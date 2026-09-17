import { Router } from 'express';
import { z } from 'zod';
import {
  Application,
  ApplicationStatusEvent,
  Category,
  Employee,
  Job,
  Referral,
  Reward,
} from '../../models/index.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/error.js';
import { requireAdmin, requirePermission } from '../../middleware/auth.js';
import { toCsv, csvFilename, type CsvColumn } from '../../utils/csv.js';
import { formatCivilDate, tenureProgress } from '../../utils/dates.js';
import { badRequest } from '../../utils/errors.js';

export const adminExportsRouter: Router = Router();

adminExportsRouter.use(requireAdmin, requirePermission('exports:read'));

const EXPORTABLE = ['employees', 'jobs', 'applications', 'referrals', 'rewards'] as const;
type Exportable = (typeof EXPORTABLE)[number];

/** Bounded so an export can never become an accidental full-table scan into memory. */
const MAX_ROWS = 10_000;

async function categoryNames(): Promise<Map<string, string>> {
  const rows = await Category.find().select('name').lean();
  return new Map(rows.map((c) => [String(c._id), c.name]));
}

async function buildCsv(entity: Exportable): Promise<string> {
  switch (entity) {
    case 'employees': {
      const [rows, categories] = await Promise.all([
        Employee.find({ deletedAt: null }).sort({ createdAt: -1 }).limit(MAX_ROWS).lean(),
        categoryNames(),
      ]);
      const columns: CsvColumn<(typeof rows)[number]>[] = [
        { header: 'Employee Code', value: (r) => r.employeeCode ?? 'Pending' },
        { header: 'Referral Code', value: (r) => r.referralCode },
        { header: 'Name', value: (r) => r.name },
        { header: 'Mobile', value: (r) => r.mobile },
        { header: 'Age', value: (r) => r.age },
        { header: 'Experience', value: (r) => r.experienceBand },
        { header: 'Category', value: (r) => categories.get(String(r.categoryId)) ?? '' },
        { header: 'Present Salary', value: (r) => r.presentSalary },
        { header: 'Expected Salary', value: (r) => r.expectedSalary },
        { header: 'Currently At', value: (r) => r.currentOrganization ?? 'Unemployed' },
        { header: 'Past Employers', value: (r) => r.employmentHistory.filter((s) => s.to).map((s) => s.company).join(' | ') },
        { header: 'Total Referrals', value: (r) => r.totalReferrals },
        { header: 'Money Earned', value: (r) => r.moneyEarned },
        { header: 'Language', value: (r) => r.language },
        { header: 'Blocked', value: (r) => (r.isBlocked ? 'Yes' : 'No') },
        { header: 'Last Active', value: (r) => formatCivilDate(r.lastActiveAt) },
        { header: 'Registered On', value: (r) => formatCivilDate(r.createdAt) },
      ];
      return toCsv(rows, columns);
    }

    case 'jobs': {
      const [rows, categories] = await Promise.all([
        Job.find({ deletedAt: null }).sort({ createdAt: -1 }).limit(MAX_ROWS).lean(),
        categoryNames(),
      ]);
      const columns: CsvColumn<(typeof rows)[number]>[] = [
        { header: 'Title', value: (r) => r.title },
        { header: 'Company', value: (r) => r.company },
        { header: 'Location', value: (r) => r.location },
        { header: 'Category', value: (r) => categories.get(String(r.categoryId)) ?? '' },
        { header: 'Experience', value: (r) => r.experienceBand },
        { header: 'Joining', value: (r) => r.joiningUrgency },
        { header: 'Salary Min', value: (r) => r.salaryMin },
        { header: 'Salary Max', value: (r) => r.salaryMax },
        { header: 'Referral Reward', value: (r) => r.referralReward },
        { header: 'Tenure (months)', value: (r) => r.tenureMonths },
        { header: 'Notify Case', value: (r) => r.notifyCase },
        { header: 'Status', value: (r) => r.status },
        { header: 'Applied Count', value: (r) => r.appliedCount },
        { header: 'Posted On', value: (r) => formatCivilDate(r.postedAt) },
      ];
      return toCsv(rows, columns);
    }

    case 'applications': {
      const rows = await Application.find().sort({ appliedAt: -1 }).limit(MAX_ROWS).lean();
      const [jobs, employees, events] = await Promise.all([
        Job.find({ _id: { $in: rows.map((r) => r.jobId) } }).select('title company').lean(),
        Employee.find({ _id: { $in: rows.map((r) => r.employeeId) } })
          .select('name employeeCode mobile')
          .lean(),
        ApplicationStatusEvent.find({ applicationId: { $in: rows.map((r) => r._id) } })
          .select('applicationId to createdAt')
          .lean(),
      ]);

      const jobMap = new Map(jobs.map((j) => [String(j._id), j]));
      const empMap = new Map(employees.map((e) => [String(e._id), e]));
      const historyMap = new Map<string, string[]>();
      for (const e of events) {
        const key = String(e.applicationId);
        historyMap.set(key, [...(historyMap.get(key) ?? []), `${e.to}@${formatCivilDate(e.createdAt)}`]);
      }

      const columns: CsvColumn<(typeof rows)[number]>[] = [
        { header: 'Candidate', value: (r) => empMap.get(String(r.employeeId))?.name ?? '' },
        { header: 'Employee Code', value: (r) => empMap.get(String(r.employeeId))?.employeeCode ?? '' },
        { header: 'Mobile', value: (r) => empMap.get(String(r.employeeId))?.mobile ?? '' },
        { header: 'Job', value: (r) => jobMap.get(String(r.jobId))?.title ?? '' },
        { header: 'Company', value: (r) => jobMap.get(String(r.jobId))?.company ?? '' },
        { header: 'Status', value: (r) => r.status },
        { header: 'Source', value: (r) => r.source },
        { header: 'Applied On', value: (r) => formatCivilDate(r.appliedAt) },
        { header: 'Interview', value: (r) => (r.interviewAt ? r.interviewAt.toISOString() : '') },
        { header: 'Interview Location', value: (r) => r.interviewLocation ?? '' },
        { header: 'Hired On', value: (r) => formatCivilDate(r.hiredOn) },
        { header: 'Rejection Reason', value: (r) => r.rejectionReason ?? '' },
        { header: 'Status History', value: (r) => (historyMap.get(String(r._id)) ?? []).join(' → ') },
      ];
      return toCsv(rows, columns);
    }

    case 'referrals': {
      const rows = await Referral.find().sort({ createdAt: -1 }).limit(MAX_ROWS).lean();
      const [referrers, jobs] = await Promise.all([
        Employee.find({ _id: { $in: rows.map((r) => r.referrerId) } })
          .select('name employeeCode currentOrganization')
          .lean(),
        Job.find({ _id: { $in: rows.map((r) => r.jobId).filter(Boolean) } })
          .select('title company')
          .lean(),
      ]);
      const refMap = new Map(referrers.map((e) => [String(e._id), e]));
      const jobMap = new Map(jobs.map((j) => [String(j._id), j]));

      const columns: CsvColumn<(typeof rows)[number]>[] = [
        { header: 'Referrer', value: (r) => refMap.get(String(r.referrerId))?.name ?? '' },
        { header: 'Referrer Code', value: (r) => refMap.get(String(r.referrerId))?.employeeCode ?? '' },
        { header: 'Referrer At', value: (r) => refMap.get(String(r.referrerId))?.currentOrganization ?? 'Unemployed' },
        { header: 'Friend', value: (r) => r.friendName },
        { header: 'Friend Mobile', value: (r) => r.friendMobile },
        { header: 'Job', value: (r) => (r.jobId ? (jobMap.get(String(r.jobId))?.title ?? '') : '') },
        { header: 'Company', value: (r) => (r.jobId ? (jobMap.get(String(r.jobId))?.company ?? '') : '') },
        { header: 'Status', value: (r) => r.status },
        { header: 'Hire Date', value: (r) => formatCivilDate(r.hiredOn) },
        { header: 'Tenure (months)', value: (r) => r.tenureMonths },
        { header: 'Tenure Day', value: (r) => tenureProgress(r.hiredOn, r.tenureDueOn)?.day ?? '' },
        { header: 'Tenure Due', value: (r) => formatCivilDate(r.tenureDueOn) },
        { header: 'Tenure Completed', value: (r) => formatCivilDate(r.tenureCompletedOn) },
        { header: 'Reward Amount', value: (r) => r.rewardAmount },
        { header: 'Shared On', value: (r) => formatCivilDate(r.createdAt) },
      ];
      return toCsv(rows, columns);
    }

    case 'rewards': {
      const rows = await Reward.find().sort({ eligibleAt: -1 }).limit(MAX_ROWS).lean();
      const [employees, referrals] = await Promise.all([
        Employee.find({ _id: { $in: rows.map((r) => r.employeeId) } })
          .select('name employeeCode mobile')
          .lean(),
        Referral.find({ _id: { $in: rows.map((r) => r.referralId) } })
          .select('friendName tenureMonths')
          .lean(),
      ]);
      const empMap = new Map(employees.map((e) => [String(e._id), e]));
      const refMap = new Map(referrals.map((r) => [String(r._id), r]));

      const columns: CsvColumn<(typeof rows)[number]>[] = [
        { header: 'Referrer', value: (r) => empMap.get(String(r.employeeId))?.name ?? '' },
        { header: 'Employee Code', value: (r) => empMap.get(String(r.employeeId))?.employeeCode ?? '' },
        { header: 'Mobile', value: (r) => empMap.get(String(r.employeeId))?.mobile ?? '' },
        { header: 'Friend Hired', value: (r) => refMap.get(String(r.referralId))?.friendName ?? '' },
        { header: 'Tenure (months)', value: (r) => refMap.get(String(r.referralId))?.tenureMonths ?? '' },
        { header: 'Suggested Amount', value: (r) => r.suggestedAmount },
        { header: 'Approved Amount', value: (r) => r.approvedAmount ?? '' },
        { header: 'Status', value: (r) => r.status },
        { header: 'Eligible On', value: (r) => formatCivilDate(r.eligibleAt) },
        { header: 'Approved On', value: (r) => formatCivilDate(r.approvedAt) },
        { header: 'Paid On', value: (r) => formatCivilDate(r.paidAt) },
        { header: 'Payment Method', value: (r) => r.paymentMethod ?? '' },
        { header: 'Payment Reference', value: (r) => r.paymentReference ?? '' },
      ];
      return toCsv(rows, columns);
    }
  }
}

adminExportsRouter.get(
  '/:entity',
  validate({ params: z.object({ entity: z.string() }) }),
  asyncHandler(async (req, res) => {
    const entity = String(req.params.entity).replace(/\.csv$/, '') as Exportable;
    if (!EXPORTABLE.includes(entity)) {
      throw badRequest('UNKNOWN_EXPORT', `Cannot export "${entity}"`, { supported: EXPORTABLE });
    }

    const csv = await buildCsv(entity);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${csvFilename(entity)}"`);
    res.send(csv);
  }),
);
