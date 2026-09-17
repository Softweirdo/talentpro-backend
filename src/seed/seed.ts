import { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import {
  Application,
  ApplicationStatusEvent,
  Category,
  Counter,
  Device,
  Employee,
  Job,
  Notification,
  Otp,
  RefreshToken,
  Referral,
  ReferralStatusEvent,
  Reward,
  Setting,
  slugify,
  AuditLog,
} from '../models/index.js';
import { ensureSeedAdminExists } from '../modules/auth/auth.service.js';
import { generateReferralCode } from '../utils/crypto.js';
import { addMonths, toCivilDate } from '../utils/dates.js';
import { APPLICATIONS, CATEGORIES, EMPLOYEES, JOBS, REFERRALS } from './data.js';

const fresh = process.argv.includes('--fresh');

const daysAgoDate = (days: number) => new Date(Date.now() - days * 86_400_000);
const hoursAgoDate = (hours: number) => new Date(Date.now() - hours * 3_600_000);
const monthDate = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y!, (m ?? 1) - 1, 1));
};

async function wipe(): Promise<void> {
  logger.warn('seed: --fresh, clearing all collections');
  await Promise.all([
    Employee.deleteMany({}),
    Job.deleteMany({}),
    Application.deleteMany({}),
    ApplicationStatusEvent.deleteMany({}),
    Referral.deleteMany({}),
    ReferralStatusEvent.deleteMany({}),
    Reward.deleteMany({}),
    Category.deleteMany({}),
    Notification.deleteMany({}),
    Device.deleteMany({}),
    Otp.deleteMany({}),
    RefreshToken.deleteMany({}),
    AuditLog.deleteMany({}),
    Counter.deleteMany({}),
    Setting.deleteMany({}),
  ]);
}

async function main(): Promise<void> {
  await connectDb();
  if (fresh) await wipe();

  // ── Settings & admin ─────────────────────────────────────────────────────
  await Setting.findOneAndUpdate({ key: 'platform' }, { $setOnInsert: { key: 'platform' } }, { upsert: true });
  await ensureSeedAdminExists({
    email: env.SEED_ADMIN_EMAIL,
    password: env.SEED_ADMIN_PASSWORD,
    name: env.SEED_ADMIN_NAME,
  });

  // ── Categories ───────────────────────────────────────────────────────────
  const categoryMap = new Map<string, Types.ObjectId>();
  for (const c of CATEGORIES) {
    const doc = await Category.findOneAndUpdate(
      { slug: slugify(c.name) },
      { $set: { name: c.name, nameGu: c.nameGu, slug: slugify(c.name), sortOrder: c.sortOrder } },
      { upsert: true, new: true },
    );
    categoryMap.set(c.name, doc._id);
  }
  logger.info({ count: categoryMap.size }, 'seed: categories');

  // ── Employees ────────────────────────────────────────────────────────────
  const employeeMap = new Map<string, Types.ObjectId>();
  for (const e of EMPLOYEES) {
    const history = e.history.map((h) => ({
      _id: new Types.ObjectId(),
      company: h.company,
      from: monthDate(h.from),
      to: monthDate(h.to),
      source: 'admin' as const,
      jobId: null,
      createdByAdminId: null,
      note: null,
    }));

    // The current organization is modelled as an open stint, exactly as the
    // employment service would write it, so the seed exercises the same shape.
    if (e.currentOrganization) {
      history.unshift({
        _id: new Types.ObjectId(),
        company: e.currentOrganization,
        from: monthDate('2025-04'),
        to: null as unknown as Date,
        source: 'admin' as const,
        jobId: null,
        createdByAdminId: null,
        note: null,
      });
    }

    const doc = await Employee.findOneAndUpdate(
      { mobile: e.mobile },
      {
        $set: {
          name: e.name,
          employeeCode: e.employeeCode,
          age: e.age,
          experienceBand: e.experienceBand,
          categoryId: categoryMap.get(e.category) ?? null,
          presentSalary: e.presentSalary,
          expectedSalary: e.expectedSalary,
          currentOrganization: e.currentOrganization,
          employmentHistory: history,
          profileCompletedAt: new Date(),
          lastActiveAt: daysAgoDate(Math.floor(Math.random() * 20)),
        },
        $setOnInsert: { mobile: e.mobile, referralCode: generateReferralCode() },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    employeeMap.set(e.name, doc._id);
  }
  logger.info({ count: employeeMap.size }, 'seed: employees');

  // Keep the code sequence ahead of the highest seeded code so the next
  // assignment does not collide with EMP-1262.
  const highest = EMPLOYEES.map((e) => Number(e.employeeCode?.replace('EMP-', '') ?? 0)).reduce(
    (a, b) => Math.max(a, b),
    1000,
  );
  await Counter.findOneAndUpdate(
    { key: 'employee_code' },
    { $set: { seq: highest - 1000 + 1 } },
    { upsert: true },
  );

  // ── Jobs ─────────────────────────────────────────────────────────────────
  const jobMap = new Map<string, Types.ObjectId>();
  for (const j of JOBS) {
    const doc = await Job.findOneAndUpdate(
      { title: j.title, company: j.company },
      {
        $set: {
          title: j.title,
          company: j.company,
          location: j.location,
          categoryId: categoryMap.get(j.category)!,
          experienceBand: j.experienceBand,
          joiningUrgency: j.joiningUrgency,
          salaryMin: j.salaryMin,
          salaryMax: j.salaryMax,
          description: j.description,
          requirements: j.requirements,
          referralReward: j.referralReward,
          tenureMonths: j.tenureMonths,
          notifyCase: j.notifyCase,
          status: j.status,
          postedAt: j.postedHoursAgo !== null ? hoursAgoDate(j.postedHoursAgo) : null,
        },
      },
      { upsert: true, new: true },
    );
    jobMap.set(j.title, doc._id);
  }
  logger.info({ count: jobMap.size }, 'seed: jobs');

  // ── Applications (+ the status events the funnel is built from) ──────────
  let applicationCount = 0;
  const applicationByPair = new Map<string, Types.ObjectId>();

  for (const a of APPLICATIONS) {
    const employeeId = employeeMap.get(a.employee);
    const jobId = jobMap.get(a.job);
    if (!employeeId || !jobId) continue;

    const appliedAt = daysAgoDate(a.daysAgo);
    const doc = await Application.findOneAndUpdate(
      { employeeId, jobId },
      {
        $set: {
          status: a.status,
          source: 'direct',
          appliedAt,
          shortlistedAt: ['shortlisted', 'interview', 'hired'].includes(a.status)
            ? daysAgoDate(Math.max(0, a.daysAgo - 1))
            : null,
          interviewAt:
            'interviewInDays' in a && a.interviewInDays
              ? new Date(Date.now() + a.interviewInDays * 86_400_000)
              : null,
          interviewLocation: 'interviewLocation' in a ? (a.interviewLocation ?? null) : null,
          hiredOn: 'hiredDaysAgo' in a && a.hiredDaysAgo ? toCivilDate(daysAgoDate(a.hiredDaysAgo)) : null,
          rejectionReason: 'rejectionReason' in a ? (a.rejectionReason ?? null) : null,
          rejectedAt: a.status === 'rejected' ? daysAgoDate(a.daysAgo - 2) : null,
          // Explicit because `findOneAndUpdate` bypasses the pre-save hook.
          // No seeded application is withdrawn, so every one is live.
          isLive: true,
        },
        $setOnInsert: { employeeId, jobId },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    applicationByPair.set(`${a.employee}|${a.job}`, doc._id);
    applicationCount += 1;

    // Replay the full stage sequence, because the dashboard funnel counts
    // stages ever reached rather than current status.
    const sequence: string[] = ['applied'];
    if (['shortlisted', 'interview', 'hired'].includes(a.status)) sequence.push('shortlisted');
    if (['interview', 'hired'].includes(a.status)) sequence.push('interview');
    if (a.status === 'hired') sequence.push('hired');
    if (a.status === 'rejected') sequence.push('rejected');

    await ApplicationStatusEvent.deleteMany({ applicationId: doc._id });
    for (const [i, to] of sequence.entries()) {
      await ApplicationStatusEvent.create({
        applicationId: doc._id,
        employeeId,
        jobId,
        from: i === 0 ? null : sequence[i - 1],
        to,
        actorType: i === 0 ? 'employee' : 'admin',
        createdAt: daysAgoDate(Math.max(0, a.daysAgo - i)),
      });
    }
  }

  // Rebuild appliedCount from the applications actually written.
  const counts = await Application.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { status: { $ne: 'withdrawn' } } },
    { $group: { _id: '$jobId', count: { $sum: 1 } } },
  ]);
  for (const jobId of jobMap.values()) {
    const actual = counts.find((c) => String(c._id) === String(jobId))?.count ?? 0;
    await Job.updateOne({ _id: jobId }, { $set: { appliedCount: actual } });
  }
  logger.info({ count: applicationCount }, 'seed: applications');

  // ── Referrals & rewards ──────────────────────────────────────────────────
  let referralCount = 0;
  for (const r of REFERRALS) {
    const referrerId = employeeMap.get(r.referrer);
    if (!referrerId) continue;

    const jobId = r.job ? (jobMap.get(r.job) ?? null) : null;
    const friendId = employeeMap.get(r.friendName) ?? null;
    const hiredOn = 'hiredDaysAgo' in r && r.hiredDaysAgo ? toCivilDate(daysAgoDate(r.hiredDaysAgo)) : null;

    const referral = await Referral.findOneAndUpdate(
      { friendMobile: r.friendMobile },
      {
        $set: {
          referrerId,
          jobId,
          friendName: r.friendName,
          friendEmployeeId: friendId,
          friendApplicationId: r.job ? (applicationByPair.get(`${r.friendName}|${r.job}`) ?? null) : null,
          status: r.status,
          tenureMonths: r.tenureMonths,
          rewardAmount: r.rewardAmount,
          hiredOn,
          tenureDueOn: hiredOn ? addMonths(hiredOn, r.tenureMonths) : null,
          tenureCompletedOn:
            r.status === 'rewarded' && hiredOn ? addMonths(hiredOn, r.tenureMonths) : null,
          smsStatus: 'sent',
          expiresAt: r.status === 'pending' ? new Date(Date.now() + 90 * 86_400_000) : null,
          // Set explicitly: `findOneAndUpdate` bypasses the pre-save hook that
          // normally derives this from status.
          claimActive: !['cancelled', 'expired', 'rejected', 'tenure_broken'].includes(r.status),
        },
        $setOnInsert: { friendMobile: r.friendMobile },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    // Mark the friend's application as referral-sourced, so moving it through
    // the pipeline drives the referral too.
    if (referral.friendApplicationId) {
      await Application.updateOne(
        { _id: referral.friendApplicationId },
        { $set: { source: 'referred', referralId: referral._id } },
      );
    }

    if ('paid' in r && r.paid && referral.tenureCompletedOn) {
      const reward = await Reward.findOneAndUpdate(
        { referralId: referral._id },
        {
          $set: {
            employeeId: referrerId,
            suggestedAmount: r.rewardAmount,
            approvedAmount: r.rewardAmount,
            status: 'paid',
            eligibleAt: referral.tenureCompletedOn,
            approvedAt: referral.tenureCompletedOn,
            paidAt: referral.tenureCompletedOn,
            paymentMethod: 'upi',
          },
          $setOnInsert: { referralId: referral._id },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      await Referral.updateOne({ _id: referral._id }, { $set: { rewardId: reward._id } });
    }

    referralCount += 1;
  }
  logger.info({ count: referralCount }, 'seed: referrals');

  // ── Rebuild the denormalised counters from what was just written ─────────
  const { reconcileCounters } = await import('../jobs/reconcileCounters.js');
  await reconcileCounters();

  const summary = {
    categories: await Category.countDocuments(),
    employees: await Employee.countDocuments(),
    jobs: await Job.countDocuments(),
    applications: await Application.countDocuments(),
    referrals: await Referral.countDocuments(),
    rewards: await Reward.countDocuments(),
  };

  logger.info(summary, 'seed: complete');
  logger.info(
    { email: env.SEED_ADMIN_EMAIL, password: env.SEED_ADMIN_PASSWORD },
    'seed: admin sign-in',
  );
  logger.info(
    { mobile: '+91 98765 43210' },
    'seed: try this number in the app (the OTP prints to this log)',
  );

  await disconnectDb();
  process.exit(0);
}

main().catch((err) => {
  logger.fatal({ err }, 'seed: failed');
  process.exit(1);
});
