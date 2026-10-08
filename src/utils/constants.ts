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

/**
 * Every permission a route can check. Roles are stored in the database and
 * pick from this list; adding a permission means adding it here *and* gating
 * a route on it. Viewing is not a permission — every active admin can read.
 */
export const PERMISSIONS = [
  'jobs:write',
  'applications:write',
  'employees:write',
  'referrals:write',
  'rewards:approve',
  'settings:write',
  'exports:read',
  'admins:write',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Grouped and labelled for the admin Roles page. */
export const PERMISSION_CATALOG: { group: string; key: Permission; label: string; description: string }[] = [
  { group: 'Recruit', key: 'jobs:write', label: 'Manage jobs & categories', description: 'Create, edit, publish and close jobs; add or archive categories' },
  { group: 'Recruit', key: 'applications:write', label: 'Move applications', description: 'Shortlist, schedule interviews, hire and reject' },
  { group: 'Recruit', key: 'referrals:write', label: 'Manage referrals', description: 'Correct, cancel or override referral status' },
  { group: 'Money', key: 'rewards:approve', label: 'Approve & pay rewards', description: 'Approve, hold, void and mark rewards paid' },
  { group: 'Manage', key: 'employees:write', label: 'Edit employees', description: 'Profiles, employee codes, employment history, blocking' },
  { group: 'Manage', key: 'exports:read', label: 'Export data', description: 'Download CSV exports of every collection' },
  { group: 'Setup', key: 'settings:write', label: 'Change platform settings', description: 'SMS and push credentials, reward and tenure defaults' },
  { group: 'Setup', key: 'admins:write', label: 'Manage admins & roles', description: 'Invite admins, assign roles, edit role permissions' },
];

/** An admin's role is the key of a document in `roles`. */
export type AdminRole = string;

export const SUPER_ADMIN_ROLE = 'super_admin';

/** Seeded at startup if missing. Reward approval and settings stay super-admin only by default — they move money and credentials. */
export const SYSTEM_ROLES: { key: string; name: string; description: string; permissions: readonly Permission[] }[] = [
  {
    key: SUPER_ADMIN_ROLE,
    name: 'Super Admin',
    description: 'Full access, including payouts, settings and admin management. Cannot be edited.',
    permissions: PERMISSIONS,
  },
  {
    key: 'recruiter',
    name: 'Recruiter',
    description: 'Runs the hiring pipeline day to day.',
    permissions: ['jobs:write', 'applications:write', 'employees:write', 'referrals:write'],
  },
  {
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only access to every page.',
    permissions: [],
  },
];

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
