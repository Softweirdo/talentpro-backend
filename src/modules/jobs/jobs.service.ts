import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { Application, Category, Job, type JobDoc } from '../../models/index.js';
import { fromNow, formatCivilDate } from '../../utils/dates.js';
import { NOTIFY_CASE_LABELS, type NotifyCase } from '../../utils/constants.js';
import { translateToGujarati } from '../../services/translate/index.js';
import { logger } from '../../config/logger.js';

export interface JobListFilters {
  q?: string;
  categoryId?: string;
  location?: string;
  experienceBand?: string;
  urgency?: string;
  status?: string;
  company?: string;
}

export function buildJobFilter(filters: JobListFilters, opts: { publicOnly?: boolean } = {}) {
  const filter: Record<string, unknown> = { deletedAt: null };

  if (opts.publicOnly) {
    // The app never sees drafts or closed listings.
    filter.status = { $in: ['active', 'closing'] };
  } else if (filters.status) {
    filter.status = filters.status;
  }

  if (filters.categoryId) filter.categoryId = new Types.ObjectId(filters.categoryId);
  if (filters.experienceBand) filter.experienceBand = filters.experienceBand;
  if (filters.urgency) filter.joiningUrgency = filters.urgency;
  if (filters.location) filter.location = { $regex: filters.location, $options: 'i' };
  if (filters.company) filter.company = { $regex: filters.company, $options: 'i' };
  if (filters.q) filter.$text = { $search: filters.q };

  return filter;
}

type LeanJob = JobDoc | (Record<string, unknown> & { _id: Types.ObjectId });

/** The job shape the mobile feed and detail screens consume. */
export function publicJob(job: any, extra: { hasApplied?: boolean; categoryName?: string | null } = {}) {
  return {
    id: String(job._id),
    title: job.title,
    company: job.company,
    location: job.location,
    categoryId: job.categoryId ? String(job.categoryId) : null,
    categoryName: extra.categoryName ?? job.categoryName ?? null,
    experienceBand: job.experienceBand,
    joiningUrgency: job.joiningUrgency,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    description: job.description,
    requirements: job.requirements ?? [],
    gu: currentTranslation(job),
    referralReward: job.referralReward,
    tenureMonths: job.tenureMonths,
    status: job.status,
    appliedCount: job.appliedCount ?? 0,
    postedAt: job.postedAt,
    postedAgo: job.postedAt ? fromNow(job.postedAt) : null,
    /** The prototype's "NEW" ribbon: anything posted within 24 hours. */
    isNew: job.postedAt ? Date.now() - new Date(job.postedAt).getTime() < 86_400_000 : false,
    ...(extra.hasApplied !== undefined ? { hasApplied: extra.hasApplied } : {}),
  };
}

/** The job shape the admin table consumes — adds the fields only admins see. */
export function adminJob(job: any, categoryName?: string | null) {
  return {
    ...publicJob(job, { categoryName }),
    notifyCase: job.notifyCase as NotifyCase,
    notifyCaseLabel: NOTIFY_CASE_LABELS[job.notifyCase as NotifyCase],
    notifiedAt: job.notifiedAt,
    closesAt: job.closesAt,
    closesOn: formatCivilDate(job.closesAt),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/** Resolves category names in one query rather than populating per row. */
export async function attachCategoryNames<T extends { categoryId?: unknown }>(
  rows: T[],
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => String(r.categoryId)).filter((id) => id !== 'undefined'))];
  if (ids.length === 0) return new Map();
  const categories = await Category.find({ _id: { $in: ids } })
    .select('name')
    .lean();
  return new Map(categories.map((c) => [String(c._id), c.name]));
}

/** Which of these jobs the employee has already applied to, in one query. */
export async function appliedJobIds(
  employeeId: string,
  jobIds: Types.ObjectId[],
): Promise<Set<string>> {
  if (jobIds.length === 0) return new Set();
  const applications = await Application.find({
    employeeId: new Types.ObjectId(employeeId),
    jobId: { $in: jobIds },
    status: { $ne: 'withdrawn' },
  })
    .select('jobId')
    .lean();
  return new Set(applications.map((a) => String(a.jobId)));
}

// ─── Gujarati translation ──────────────────────────────────────────────────

type TranslatableJob = {
  _id: Types.ObjectId;
  title: string;
  location: string;
  description?: string | null;
  requirements?: string[];
  gu?: { title: string; location: string; description: string | null; requirements: string[]; sourceHash: string } | null;
};

/** Fingerprint of the English a translation is made from. */
function sourceHash(job: TranslatableJob): string {
  return createHash('sha1')
    .update(JSON.stringify([job.title, job.location, job.description ?? null, job.requirements ?? []]))
    .digest('hex');
}

/** The stored translation, or null if missing or made from older English. */
function currentTranslation(job: TranslatableJob) {
  if (!job.gu || job.gu.sourceHash !== sourceHash(job)) return null;
  return {
    title: job.gu.title,
    location: job.gu.location,
    description: job.gu.description,
    requirements: job.gu.requirements,
  };
}

const inFlight = new Set<string>();

/**
 * Translates the job's English text to Gujarati and stores it. A no-op when
 * the stored translation is current. Never throws — a failed translation only
 * means the app keeps showing English.
 */
export async function translateJob(job: TranslatableJob): Promise<void> {
  const id = String(job._id);
  const hash = sourceHash(job);
  if (job.gu?.sourceHash === hash || inFlight.has(id)) return;
  inFlight.add(id);

  try {
    const requirements = job.requirements ?? [];
    // Requirements go as one newline-joined block to keep the request count
    // down; if the lines do not come back one-for-one they are retried singly.
    const out = await translateToGujarati([
      job.title,
      job.location,
      job.description ?? '',
      requirements.join('\n'),
    ]);
    if (!out) return;

    let guRequirements = requirements.length ? out[3]!.split('\n').map((r) => r.trim()) : [];
    if (guRequirements.length !== requirements.length) {
      const single = await translateToGujarati(requirements);
      if (!single) return;
      guRequirements = single;
    }

    // Guarded on the source hash: if an admin edited the job meanwhile, this
    // stale result is dropped and the newer save's translation wins.
    const current = await Job.findById(job._id).select('title location description requirements').lean();
    if (!current || sourceHash({ ...current, _id: job._id }) !== hash) return;

    await Job.updateOne(
      { _id: job._id },
      {
        $set: {
          gu: {
            title: out[0],
            location: out[1],
            description: job.description ? out[2] : null,
            requirements: guRequirements,
            sourceHash: hash,
            translatedAt: new Date(),
          },
        },
      },
    );
  } catch (err) {
    logger.warn({ err, jobId: id }, 'Job translation failed');
  } finally {
    inFlight.delete(id);
  }
}

/** Kicks off translation for any of these jobs lacking a current one, without waiting. */
export function translateStaleInBackground(jobs: TranslatableJob[]): void {
  for (const job of jobs) {
    if (!currentTranslation(job)) void translateJob(job);
  }
}
