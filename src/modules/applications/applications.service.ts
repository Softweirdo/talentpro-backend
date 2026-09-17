import { Types } from 'mongoose';
import {
  Application,
  ApplicationStatusEvent,
  Employee,
  Job,
  Referral,
  recordAudit,
  type ApplicationDoc,
} from '../../models/index.js';
import { applicationStatusCopy, notifyEmployee } from '../../services/notify.js';
import {
  breakTenure,
  revertHire,
  startTenure,
  transitionReferral,
} from '../../services/referralService.js';
import { APPLICATION_TO_REFERRAL } from '../../services/referralStateMachine.js';
import { applyHireToEmployment } from '../../services/employment.js';
import { formatCivilDate, fromNow, toCivilDate, todayIst } from '../../utils/dates.js';
import { conflict, notFound, unprocessable } from '../../utils/errors.js';
import { logger } from '../../config/logger.js';
import type { ActorType, ApplicationStatus } from '../../utils/constants.js';

export interface SetStatusInput {
  status: ApplicationStatus;
  reason?: string | null;
  interviewAt?: Date | null;
  interviewLocation?: string | null;
  hiredOn?: Date | null;
  actorType?: ActorType;
  actorId?: Types.ObjectId | string | null;
  ip?: string | null;
}

/** Stages a candidate may move between. Everything else is an invalid drag. */
const ALLOWED: Record<ApplicationStatus, ApplicationStatus[]> = {
  applied: ['shortlisted', 'interview', 'rejected', 'withdrawn'],
  shortlisted: ['interview', 'hired', 'rejected', 'applied'],
  interview: ['hired', 'rejected', 'shortlisted'],
  // Reversible, but it is an audited correction — see the revert path below.
  hired: ['rejected', 'interview'],
  rejected: ['applied', 'shortlisted', 'interview'],
  withdrawn: [],
};

export interface StatusChangeResult {
  application: ApplicationDoc;
  employmentConflict: string | null;
}

/**
 * The single writer of application status.
 *
 * Every move records an event (the funnel depends on stages *ever* reached),
 * cascades to the linked referral, notifies the candidate, and — on a hire —
 * touches employment history. Keeping all of that here is what stops the
 * pipeline drag, the bulk action and the mobile withdraw from drifting apart.
 */
export async function setApplicationStatus(
  applicationId: Types.ObjectId | string,
  input: SetStatusInput,
): Promise<StatusChangeResult> {
  const application = await Application.findById(applicationId);
  if (!application) throw notFound('APPLICATION_NOT_FOUND', 'Application not found');

  const from = application.status;
  const to = input.status;

  if (from === to) return { application, employmentConflict: null };
  if (!ALLOWED[from]?.includes(to)) {
    throw conflict('INVALID_TRANSITION', `An application cannot move from "${from}" to "${to}"`, {
      from,
      to,
      allowed: ALLOWED[from],
    });
  }

  const job = await Job.findById(application.jobId).select('title company tenureMonths');
  if (!job) throw notFound('JOB_NOT_FOUND', 'The job for this application no longer exists');

  const wasHired = from === 'hired';
  application.status = to;

  switch (to) {
    case 'shortlisted':
      application.shortlistedAt ??= new Date();
      break;

    case 'interview':
      if (input.interviewAt) application.interviewAt = input.interviewAt;
      if (input.interviewLocation !== undefined) {
        application.interviewLocation = input.interviewLocation;
      }
      application.shortlistedAt ??= new Date();
      break;

    case 'hired':
      // A civil IST date: the tenure clock is counted in calendar days, so a
      // late-evening hire must not slip to the next UTC day.
      application.hiredOn = toCivilDate(input.hiredOn ?? new Date());
      break;

    case 'rejected':
      application.rejectedAt = new Date();
      application.rejectionReason = input.reason ?? null;
      break;

    case 'withdrawn':
      application.withdrawnAt = new Date();
      break;
  }

  await application.save();

  await ApplicationStatusEvent.create({
    applicationId: application._id,
    employeeId: application.employeeId,
    jobId: application.jobId,
    from,
    to,
    reason: input.reason ?? null,
    actorType: input.actorType ?? 'admin',
    actorId: input.actorId ? new Types.ObjectId(String(input.actorId)) : null,
    metadata: {
      ...(application.interviewAt ? { interviewAt: application.interviewAt } : {}),
      ...(application.hiredOn ? { hiredOn: application.hiredOn } : {}),
    },
  });

  let employmentConflict: string | null = null;

  if (to === 'hired') {
    const result = await applyHireToEmployment({
      employeeId: application.employeeId,
      company: job.company,
      jobId: job._id,
      hiredOn: application.hiredOn!,
      actorId: input.actorId ?? null,
    });
    employmentConflict = result.conflictWith;
  }

  await cascadeToReferral(application, from, to, input, wasHired);

  const copy = applicationStatusCopy[to]?.(job.title, job.company);
  if (copy) {
    void notifyEmployee({
      employeeId: application.employeeId,
      kind: 'application_status',
      title: copy.title,
      body: copy.body,
      data: { screen: 'ApplicationDetail', applicationId: String(application._id) },
    });
  }

  await recordAudit({
    actorType: input.actorType ?? 'admin',
    actorId: input.actorId ?? null,
    action: 'application.status',
    entityType: 'application',
    entityId: application._id,
    before: { status: from },
    after: { status: to, reason: input.reason ?? null },
    ip: input.ip ?? null,
  });

  return { application, employmentConflict };
}

/**
 * Mirrors the application's stage onto the referral that produced it.
 *
 * Reversing a hire is the interesting case: the referral must leave the tenure
 * track and any unpaid reward is voided, rather than silently continuing to
 * count down toward a payout for someone who was never actually employed.
 */
async function cascadeToReferral(
  application: ApplicationDoc,
  from: ApplicationStatus,
  to: ApplicationStatus,
  input: SetStatusInput,
  wasHired: boolean,
): Promise<void> {
  if (!application.referralId) return;

  const referral = await Referral.findById(application.referralId);
  if (!referral) return;

  try {
    if (wasHired && to !== 'hired') {
      await revertHire(referral, {
        reason: input.reason ?? 'Hire reversed by admin',
        to: to === 'rejected' ? 'rejected' : 'shortlisted',
        actorId: input.actorId ?? null,
      });
      return;
    }

    if (to === 'hired') {
      await startTenure(referral, application.hiredOn ?? todayIst(), {
        actorType: input.actorType ?? 'admin',
        actorId: input.actorId ?? null,
      });
      return;
    }

    const target = APPLICATION_TO_REFERRAL[to];
    if (!target || referral.status === target) return;

    await transitionReferral(referral, target, {
      reason: input.reason ?? null,
      actorType: input.actorType ?? 'admin',
      actorId: input.actorId ?? null,
      metadata: { applicationId: String(application._id), applicationStatus: to },
    });
  } catch (err) {
    // A referral already in a terminal state must not block a legitimate
    // application move — the pipeline is the admin's primary surface.
    logger.warn(
      { err, referralId: String(referral._id), from, to },
      'application: referral cascade skipped',
    );
  }
}

/** Marks a hired referral's tenure broken because the friend left early. */
export async function markTenureBroken(
  referralId: Types.ObjectId | string,
  params: { reason: string; leftOn?: Date; actorId?: string | null },
) {
  const referral = await Referral.findById(referralId);
  if (!referral) throw notFound('REFERRAL_NOT_FOUND', 'Referral not found');
  if (referral.status !== 'tenure_running' && referral.status !== 'tenure_complete') {
    throw unprocessable(
      'NOT_IN_TENURE',
      'Only a referral whose tenure is running or complete can be marked broken',
    );
  }
  return breakTenure(referral, params);
}

export function applicationCard(app: any, job?: any, employee?: any) {
  return {
    id: String(app._id),
    status: app.status,
    source: app.source,
    referralId: app.referralId ? String(app.referralId) : null,
    appliedAt: app.appliedAt,
    appliedAgo: app.appliedAt ? fromNow(app.appliedAt) : null,
    interviewAt: app.interviewAt,
    interviewDate: app.interviewAt ? formatCivilDate(app.interviewAt) : null,
    interviewLocation: app.interviewLocation,
    hiredOn: app.hiredOn,
    hiredDate: formatCivilDate(app.hiredOn),
    rejectionReason: app.rejectionReason,
    job: job
      ? {
          id: String(job._id),
          title: job.title,
          company: job.company,
          location: job.location,
          salaryMin: job.salaryMin,
          salaryMax: job.salaryMax,
        }
      : null,
    employee: employee
      ? {
          id: String(employee._id),
          name: employee.name,
          employeeCode: employee.employeeCode,
          mobile: employee.mobile,
          experienceBand: employee.experienceBand,
          currentOrganization: employee.currentOrganization,
        }
      : null,
  };
}

/** Bulk-loads the jobs and employees a page of applications references. */
export async function hydrateApplications(apps: { jobId: unknown; employeeId: unknown }[]) {
  const jobIds = [...new Set(apps.map((a) => String(a.jobId)))];
  const employeeIds = [...new Set(apps.map((a) => String(a.employeeId)))];

  const [jobs, employees] = await Promise.all([
    Job.find({ _id: { $in: jobIds } })
      .select('title company location salaryMin salaryMax')
      .lean(),
    Employee.find({ _id: { $in: employeeIds } })
      .select('name employeeCode mobile experienceBand currentOrganization')
      .lean(),
  ]);

  return {
    jobs: new Map(jobs.map((j) => [String(j._id), j])),
    employees: new Map(employees.map((e) => [String(e._id), e])),
  };
}
