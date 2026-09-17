import type { ReferralStatus } from '../utils/constants.js';
import { conflict } from '../utils/errors.js';

/**
 * The referral lifecycle, declared rather than scattered through handlers.
 *
 *   pending → registered → applied → shortlisted → hired
 *           → tenure_running → tenure_complete → reward_approved → rewarded
 *
 * Side exits: expired (claim window lapsed), cancelled (admin: duplicate or
 * fraud), rejected (the friend's application was rejected), tenure_broken (the
 * friend left before completing tenure).
 */
export const ALLOWED_TRANSITIONS: Record<ReferralStatus, ReferralStatus[]> = {
  pending: ['registered', 'cancelled', 'expired'],
  registered: ['applied', 'cancelled'],
  applied: ['shortlisted', 'rejected', 'cancelled'],
  shortlisted: ['hired', 'rejected', 'cancelled'],
  // `hired` transitions to `tenure_running` in the same operation, but is kept
  // as a distinct state so the hire is legible in the event log.
  hired: ['tenure_running', 'rejected', 'cancelled'],
  tenure_running: ['tenure_complete', 'tenure_broken', 'cancelled'],
  tenure_complete: ['reward_approved', 'tenure_broken', 'cancelled'],
  reward_approved: ['rewarded', 'cancelled'],
  rewarded: [],
  rejected: [],
  cancelled: [],
  expired: [],
  tenure_broken: [],
};

export const TERMINAL_STATUSES: ReferralStatus[] = [
  'rewarded',
  'rejected',
  'cancelled',
  'expired',
  'tenure_broken',
];

export const isTerminal = (status: ReferralStatus): boolean => TERMINAL_STATUSES.includes(status);

export const canTransition = (from: ReferralStatus, to: ReferralStatus): boolean =>
  ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;

export function assertTransition(from: ReferralStatus, to: ReferralStatus): void {
  if (from === to) return;
  if (!canTransition(from, to)) {
    throw conflict(
      'INVALID_TRANSITION',
      `A referral cannot move from "${from}" to "${to}"`,
      { from, to, allowed: ALLOWED_TRANSITIONS[from] },
    );
  }
}

/** Maps an application's pipeline stage onto the referral status it implies. */
export const APPLICATION_TO_REFERRAL: Record<string, ReferralStatus | null> = {
  applied: 'applied',
  shortlisted: 'shortlisted',
  // An interview is still the shortlisted phase as far as the referral is concerned.
  interview: 'shortlisted',
  hired: 'hired',
  rejected: 'rejected',
  withdrawn: null,
};

/** Human-readable labels, shared by the app and the admin panel. */
export const REFERRAL_STATUS_LABELS: Record<ReferralStatus, string> = {
  pending: 'Pending',
  registered: 'Registered',
  applied: 'Applied',
  shortlisted: 'Shortlisted',
  hired: 'Hired',
  tenure_running: 'Tenure Running',
  tenure_complete: 'Reward Pending',
  reward_approved: 'Reward Approved',
  rewarded: 'Rewarded',
  rejected: 'Not Selected',
  cancelled: 'Cancelled',
  expired: 'Expired',
  tenure_broken: 'Tenure Broken',
};

/** Badge variants, matching the prototype's status-badge palette. */
export const REFERRAL_STATUS_BADGE: Record<ReferralStatus, string> = {
  pending: 'pending',
  registered: 'applied',
  applied: 'applied',
  shortlisted: 'interview',
  hired: 'hired',
  tenure_running: 'tenure',
  tenure_complete: 'shortlisted',
  reward_approved: 'shortlisted',
  rewarded: 'rewarded',
  rejected: 'rejected',
  cancelled: 'rejected',
  expired: 'pending',
  tenure_broken: 'rejected',
};
