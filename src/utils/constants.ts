export const EXPERIENCE_BANDS = ['0-1', '1-3', '3-5', '5-10', '10+'] as const;
export type ExperienceBand = (typeof EXPERIENCE_BANDS)[number];

export const JOINING_URGENCIES = ['immediate', '15_days', '30_days'] as const;
export type JoiningUrgency = (typeof JOINING_URGENCIES)[number];

export const JOB_STATUSES = ['draft', 'active', 'closing', 'closed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const APPLICATION_STATUSES = [
  'applied',
  'shortlisted',
  'interview',
  'hired',
  'rejected',
  'withdrawn',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** The five columns of the admin hiring pipeline, in display order. */
export const PIPELINE_COLUMNS = ['applied', 'shortlisted', 'interview', 'hired', 'rejected'] as const;

export const APPLICATION_SOURCES = ['direct', 'referred'] as const;
export type ApplicationSource = (typeof APPLICATION_SOURCES)[number];

export const REFERRAL_STATUSES = [
  'pending',
  'registered',
  'applied',
  'shortlisted',
  'hired',
  'tenure_running',
  'tenure_complete',
  'reward_approved',
  'rewarded',
  'rejected',
  'cancelled',
  'expired',
  'tenure_broken',
] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

/** Statuses that free up a friend's mobile number for a new referral claim. */
export const REFERRAL_TERMINAL_STATUSES = [
  'cancelled',
  'expired',
  'rejected',
  'tenure_broken',
] as const;

export const REWARD_STATUSES = ['pending_approval', 'on_hold', 'approved', 'paid', 'void'] as const;
export type RewardStatus = (typeof REWARD_STATUSES)[number];

export const EMPLOYMENT_SOURCES = ['signup', 'admin', 'hire_event'] as const;
export type EmploymentSource = (typeof EMPLOYMENT_SOURCES)[number];

export const ADMIN_ROLES = ['super_admin', 'recruiter', 'viewer'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ACTOR_TYPES = ['admin', 'employee', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const TENURE_MONTH_OPTIONS = [3, 6] as const;

export const LANGUAGES = ['en', 'gu'] as const;
export type Language = (typeof LANGUAGES)[number];

export const NOTIFICATION_KINDS = [
  'application_status',
  'referral_status',
  'reward_paid',
  'new_job',
  'general',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * Notify case = who receives the push when a job goes live.
 *   1 → every active employee
 *   2 → employees in the job's category
 *   3 → employees in the job's category AND experience band
 */
export const NOTIFY_CASES = [1, 2, 3] as const;
export type NotifyCase = (typeof NOTIFY_CASES)[number];

export const NOTIFY_CASE_LABELS: Record<NotifyCase, string> = {
  1: 'All employees',
  2: 'Matching category',
  3: 'Matching category + experience',
};

export const DEFAULTS = {
  tenureMonths: 3,
  rewardAmount: 2500,
  tokenExpiryDays: 30,
  referralClaimWindowDays: 90,
  smsSenderId: 'TLNTPR',
  otpTtlSeconds: 300,
  otpMaxAttempts: 5,
  otpResendCooldownSeconds: 60,
} as const;
