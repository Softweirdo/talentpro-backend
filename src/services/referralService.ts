import { Types, type ClientSession } from 'mongoose';
import {
  Employee,
  Referral,
  ReferralStatusEvent,
  Reward,
  getSettings,
  type ReferralDoc,
} from '../models/index.js';
import { addMonths, toCivilDate, todayIst } from '../utils/dates.js';
import { assertTransition } from './referralStateMachine.js';
import { notifyEmployee } from './notify.js';
import { logger } from '../config/logger.js';
import type { ActorType, ReferralStatus } from '../utils/constants.js';

interface TransitionMeta {
  reason?: string | null;
  actorType?: ActorType;
  actorId?: Types.ObjectId | string | null;
  metadata?: Record<string, unknown>;
  session?: ClientSession;
}

/**
 * Moves a referral to a new status, recording the event.
 *
 * Every status change in the system funnels through here so the event log is
 * complete and no handler can invent a transition the state machine forbids.
 */
export async function transitionReferral(
  referral: ReferralDoc,
  to: ReferralStatus,
  meta: TransitionMeta = {},
): Promise<ReferralDoc> {
  const from = referral.status;
  if (from === to) return referral;

  assertTransition(from, to);
  referral.status = to;
  await referral.save({ session: meta.session });

  await ReferralStatusEvent.create(
    [
      {
        referralId: referral._id,
        referrerId: referral.referrerId,
        from,
        to,
        reason: meta.reason ?? null,
        actorType: meta.actorType ?? 'system',
        actorId: meta.actorId ? new Types.ObjectId(String(meta.actorId)) : null,
        metadata: meta.metadata ?? {},
      },
    ],
    { session: meta.session },
  );

  return referral;
}

/**
 * Marks a referral hired and starts the tenure clock.
 *
 * `tenureDueOn` is stored so the nightly sweep is a single indexed range scan;
 * the day counter the app shows is always derived, never stored.
 */
export async function startTenure(
  referral: ReferralDoc,
  hiredOn: Date,
  meta: TransitionMeta = {},
): Promise<ReferralDoc> {
  const civilHiredOn = toCivilDate(hiredOn);

  await transitionReferral(referral, 'hired', meta);

  referral.hiredOn = civilHiredOn;
  referral.tenureDueOn = addMonths(civilHiredOn, referral.tenureMonths);
  await referral.save({ session: meta.session });

  await transitionReferral(referral, 'tenure_running', {
    ...meta,
    metadata: { hiredOn: civilHiredOn, tenureDueOn: referral.tenureDueOn },
  });

  void notifyEmployee({
    employeeId: referral.referrerId,
    kind: 'referral_status',
    title: 'Your referral was hired! 🎉',
    body: `${referral.friendName} has been hired. Your ₹${referral.rewardAmount.toLocaleString('en-IN')} reward unlocks after ${referral.tenureMonths} months.`,
    data: { screen: 'Referrals', referralId: String(referral._id) },
  });

  return referral;
}

/**
 * Completes tenure and mints the reward.
 *
 * `tenureCompletedOn` is set to the *due* date rather than today, so a cron
 * outage of a few days still records the legally correct completion date.
 * The unique index on `Reward.referralId` is what makes this safe to run twice.
 */
export async function completeTenure(referral: ReferralDoc): Promise<ReferralDoc> {
  const completedOn = referral.tenureDueOn ?? todayIst();

  await transitionReferral(referral, 'tenure_complete', {
    actorType: 'system',
    metadata: { tenureCompletedOn: completedOn },
  });

  referral.tenureCompletedOn = completedOn;

  try {
    const reward = await Reward.create({
      referralId: referral._id,
      employeeId: referral.referrerId,
      suggestedAmount: referral.rewardAmount,
      status: 'pending_approval',
      eligibleAt: completedOn,
    });
    referral.rewardId = reward._id;
  } catch (err) {
    // Duplicate key = the reward already exists from a previous run. Re-link it
    // rather than failing; this is the cron's idempotency path.
    if ((err as { code?: number }).code === 11000) {
      const existing = await Reward.findOne({ referralId: referral._id });
      if (existing) referral.rewardId = existing._id;
    } else {
      throw err;
    }
  }

  await referral.save();

  void notifyEmployee({
    employeeId: referral.referrerId,
    kind: 'referral_status',
    title: 'Reward unlocked 💰',
    body: `${referral.friendName} completed ${referral.tenureMonths} months. Your ₹${referral.rewardAmount.toLocaleString('en-IN')} reward is pending approval.`,
    data: { screen: 'Referrals', referralId: String(referral._id) },
  });

  return referral;
}

/** The friend left before completing tenure — the reward is voided. */
export async function breakTenure(
  referral: ReferralDoc,
  params: { reason: string; leftOn?: Date; actorId?: Types.ObjectId | string | null },
): Promise<ReferralDoc> {
  await transitionReferral(referral, 'tenure_broken', {
    reason: params.reason,
    actorType: 'admin',
    actorId: params.actorId,
  });

  referral.tenureBrokenOn = toCivilDate(params.leftOn ?? new Date());
  await referral.save();

  await Reward.updateOne(
    { referralId: referral._id, status: { $in: ['pending_approval', 'on_hold', 'approved'] } },
    { $set: { status: 'void', voidReason: params.reason } },
  );

  return referral;
}

/**
 * Reverses a hire (an admin dragged a card back out of the Hired column).
 * The referral leaves the tenure track and any unpaid reward is voided.
 */
export async function revertHire(
  referral: ReferralDoc,
  params: { reason: string; to: ReferralStatus; actorId?: Types.ObjectId | string | null },
): Promise<ReferralDoc> {
  const reward = await Reward.findOne({ referralId: referral._id });
  if (reward?.status === 'paid') {
    logger.warn(
      { referralId: String(referral._id) },
      'referral: hire reverted after the reward was already paid — manual recovery required',
    );
  }

  await Reward.updateOne(
    { referralId: referral._id, status: { $in: ['pending_approval', 'on_hold', 'approved'] } },
    { $set: { status: 'void', voidReason: `Hire reverted: ${params.reason}` } },
  );

  referral.hiredOn = null;
  referral.tenureDueOn = null;
  referral.tenureCompletedOn = null;
  await referral.save();

  // Bypasses the forward-only state machine on purpose: this is an audited
  // admin correction, not a normal lifecycle step.
  const from = referral.status;
  referral.status = params.to;
  await referral.save();

  await ReferralStatusEvent.create({
    referralId: referral._id,
    referrerId: referral.referrerId,
    from,
    to: params.to,
    reason: `Hire reverted: ${params.reason}`,
    actorType: 'admin',
    actorId: params.actorId ? new Types.ObjectId(String(params.actorId)) : null,
    metadata: { correction: true },
  });

  return referral;
}

/**
 * Recomputes an employee's all-time referral count from the referrals
 * collection. Cancelled and expired referrals do not count.
 */
export async function recomputeReferralCount(
  employeeId: Types.ObjectId | string,
): Promise<number> {
  const count = await Referral.countDocuments({
    referrerId: new Types.ObjectId(String(employeeId)),
    status: { $nin: ['cancelled', 'expired'] },
  });
  await Employee.updateOne({ _id: employeeId }, { $set: { totalReferrals: count } });
  return count;
}

/**
 * Recomputes `moneyEarned` as a full re-sum of the rewards ledger rather than
 * an increment. Money must never depend on a counter staying in step — this
 * way the cache is self-healing.
 */
export async function recomputeMoneyEarned(
  employeeId: Types.ObjectId | string,
): Promise<number> {
  const [agg] = await Reward.aggregate<{ total: number }>([
    { $match: { employeeId: new Types.ObjectId(String(employeeId)), status: 'paid' } },
    { $group: { _id: null, total: { $sum: '$approvedAmount' } } },
  ]);
  const total = agg?.total ?? 0;
  await Employee.updateOne({ _id: employeeId }, { $set: { moneyEarned: total } });
  return total;
}

/** Resolves the tenure and reward terms for a new referral, snapshotting them. */
export async function resolveReferralTerms(job: {
  tenureMonths?: number;
  referralReward?: number;
} | null): Promise<{ tenureMonths: number; rewardAmount: number; claimWindowDays: number }> {
  const settings = await getSettings();
  return {
    tenureMonths: job?.tenureMonths ?? settings.defaultTenureMonths,
    rewardAmount: job?.referralReward ?? settings.defaultRewardAmount,
    claimWindowDays: settings.referralClaimWindowDays,
  };
}
