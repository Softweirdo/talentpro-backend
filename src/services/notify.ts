import { Types } from 'mongoose';
import { Device, Employee, Notification } from '../models/index.js';
import type { JobDoc } from '../models/Job.js';
import { pushProvider, type PushPayload } from './push/index.js';
import { logger } from '../config/logger.js';
import type { NotificationKind } from '../utils/constants.js';

export interface NotifyInput {
  employeeId: Types.ObjectId | string;
  kind: NotificationKind;
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Records an in-app notification and pushes it.
 *
 * Delivery failures are logged, never thrown — the business write that
 * triggered this already committed and must not be rolled back because a
 * handset was unreachable.
 */
export async function notifyEmployee(input: NotifyInput): Promise<void> {
  try {
    const employeeId = new Types.ObjectId(String(input.employeeId));

    const notification = await Notification.create({
      employeeId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      data: input.data ?? {},
    });

    const devices = await Device.find({ employeeId }).select('fcmToken').lean();
    if (devices.length === 0) return;

    const result = await pushProvider.sendToTokens(
      devices.map((d) => d.fcmToken),
      {
        title: input.title,
        body: input.body,
        data: { ...(input.data ?? {}), notificationId: String(notification._id), kind: input.kind },
      },
    );

    if (result.sent > 0) {
      await Notification.updateOne({ _id: notification._id }, { $set: { sentAt: new Date() } });
    }
    if (result.invalidTokens.length > 0) {
      await Device.deleteMany({ fcmToken: { $in: result.invalidTokens } });
    }
  } catch (err) {
    logger.error({ err, employeeId: String(input.employeeId) }, 'notify: failed');
  }
}

export async function notifyMany(
  employeeIds: (Types.ObjectId | string)[],
  payload: Omit<NotifyInput, 'employeeId'>,
): Promise<void> {
  await Promise.allSettled(
    employeeIds.map((employeeId) => notifyEmployee({ ...payload, employeeId })),
  );
}

/**
 * Resolves who receives the push when a job is published.
 *
 *   Case 1 → every active employee
 *   Case 2 → employees whose category matches the job
 *   Case 3 → category AND experience band both match
 *
 * Narrower cases exist because blasting 2,800 welders about an electrician
 * vacancy is how an app gets its notifications switched off.
 */
export async function resolveAudience(job: Pick<JobDoc, 'notifyCase' | 'categoryId' | 'experienceBand'>) {
  const filter: Record<string, unknown> = { deletedAt: null, isBlocked: false };

  if (job.notifyCase >= 2) filter.categoryId = job.categoryId;
  if (job.notifyCase === 3) filter.experienceBand = job.experienceBand;

  return Employee.find(filter).select('_id').lean();
}

/** Publishes a job to its configured audience. Returns how many were notified. */
export async function broadcastJob(job: JobDoc): Promise<number> {
  const audience = await resolveAudience(job);
  if (audience.length === 0) return 0;

  const salary = `₹${job.salaryMin.toLocaleString('en-IN')} – ${job.salaryMax.toLocaleString('en-IN')}/mo`;

  await notifyMany(
    audience.map((e) => e._id),
    {
      kind: 'new_job',
      title: `New job: ${job.title}`,
      body: `${job.company} · ${job.location} · ${salary}`,
      data: { screen: 'JobDetail', jobId: String(job._id) },
    },
  );

  logger.info(
    { jobId: String(job._id), notifyCase: job.notifyCase, recipients: audience.length },
    'notify: job broadcast',
  );
  return audience.length;
}

/** Copy for each pipeline stage the employee is moved into. */
export const applicationStatusCopy: Record<
  string,
  (jobTitle: string, company: string) => { title: string; body: string } | null
> = {
  shortlisted: (jobTitle, company) => ({
    title: 'You have been shortlisted 🎉',
    body: `${company} shortlisted you for ${jobTitle}. Check the app for next steps.`,
  }),
  interview: (jobTitle, company) => ({
    title: 'Interview scheduled',
    body: `Your interview for ${jobTitle} at ${company} has been scheduled. Open the app for the date and venue.`,
  }),
  hired: (jobTitle, company) => ({
    title: 'Congratulations, you are hired! 🎊',
    body: `${company} has hired you for ${jobTitle}.`,
  }),
  rejected: (jobTitle, company) => ({
    title: 'Application update',
    body: `Your application for ${jobTitle} at ${company} was not selected this time. Keep applying — new jobs are posted daily.`,
  }),
  // Applying is a user-initiated action; the app already confirms it on screen.
  applied: () => null,
  withdrawn: () => null,
};
