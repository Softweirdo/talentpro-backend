import argon2 from 'argon2';
import { Types } from 'mongoose';
import {
  Admin,
  Employee,
  Otp,
  Referral,
  getSettings,
  recordAudit,
  type EmployeeDoc,
} from '../../models/index.js';
import {
  issueRefreshToken,
  revokeAllForSubject,
  revokeRefreshToken,
  rotateRefreshToken,
  signAdminAccessToken,
  signEmployeeAccessToken,
  signRegistrationToken,
} from '../../services/tokens.js';
import { sendSms, smsTemplates } from '../../services/sms/index.js';
import { enforce, reset } from '../../middleware/rateLimit.js';
import { generateOtpCode, generateReferralCode, hashOtp, verifyOtp } from '../../utils/crypto.js';
import { maskMobile, normalizeMobile } from '../../utils/mobile.js';
import { DEFAULTS } from '../../utils/constants.js';
import { badRequest, forbidden, notFound, unauthorized } from '../../utils/errors.js';
import { exposeOtp, fixedOtpCode } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { transitionReferral, recomputeReferralCount } from '../../services/referralService.js';
import type { RegisterInput } from './auth.schema.js';

export interface RequestOtpResult {
  requestId: string;
  expiresIn: number;
  resendAfter: number;
  maskedMobile: string;
  /** Present only outside production, so the flow is testable without a gateway. */
  devCode?: string;
}

/**
 * Sends a login OTP.
 *
 * The response is identical whether or not an account exists — an attacker must
 * not be able to enumerate which numbers are registered.
 */
export async function requestOtp(params: {
  mobile: string;
  deviceId?: string;
  ip?: string;
}): Promise<RequestOtpResult> {
  const mobile = normalizeMobile(params.mobile);

  // Resend cooldown first, so a impatient double-tap gets a clear message
  // rather than burning the hourly quota.
  enforce({
    key: `otp:cooldown:${mobile}`,
    limit: 1,
    windowMs: DEFAULTS.otpResendCooldownSeconds * 1000,
    code: 'OTP_COOLDOWN',
    message: 'Please wait before requesting another code',
  });
  enforce({
    key: `otp:hour:${mobile}`,
    limit: 5,
    windowMs: 3_600_000,
    code: 'OTP_RATE_LIMITED',
    message: 'Too many code requests. Try again later.',
  });
  enforce({
    key: `otp:day:${mobile}`,
    limit: 10,
    windowMs: 86_400_000,
    code: 'OTP_RATE_LIMITED',
    message: 'Daily limit reached. Try again tomorrow.',
  });
  if (params.ip) {
    enforce({
      key: `otp:ip:${params.ip}`,
      limit: 30,
      windowMs: 3_600_000,
      code: 'OTP_RATE_LIMITED',
      message: 'Too many requests from this network',
    });
  }

  // Any earlier code for this number stops working the moment a new one is sent.
  await Otp.updateMany(
    { mobile, consumedAt: null },
    { $set: { consumedAt: new Date(), smsStatus: 'failed' } },
  );

  // A fixed code (OTP_FIXED_CODE) stands in for the gateway while none is live:
  // every number gets the same OTP. Unset it and codes go back to random.
  const code = fixedOtpCode ?? generateOtpCode(6);
  const otp = await Otp.create({
    mobile,
    codeHash: hashOtp(code),
    expiresAt: new Date(Date.now() + DEFAULTS.otpTtlSeconds * 1000),
    requestIp: params.ip ?? null,
    deviceId: params.deviceId ?? null,
  });

  const result = await sendSms(mobile, smsTemplates.otp(code));
  await Otp.updateOne({ _id: otp._id }, { $set: { smsStatus: result.ok ? 'sent' : 'failed' } });

  return {
    requestId: String(otp._id),
    expiresIn: DEFAULTS.otpTtlSeconds,
    resendAfter: DEFAULTS.otpResendCooldownSeconds,
    maskedMobile: maskMobile(mobile),
    ...(exposeOtp ? { devCode: code } : {}),
  };
}

export interface VerifyOtpResult {
  isNewUser: boolean;
  registrationToken?: string;
  accessToken?: string;
  refreshToken?: string;
  employee?: unknown;
}

export async function verifyOtpCode(params: {
  requestId: string;
  code: string;
  deviceId?: string;
  ip?: string;
  userAgent?: string;
}): Promise<VerifyOtpResult> {
  if (!Types.ObjectId.isValid(params.requestId)) {
    throw badRequest('OTP_INVALID', 'This code is invalid or has expired');
  }

  const otp = await Otp.findById(params.requestId).select('+codeHash');
  // One generic error for wrong, expired, consumed and exhausted — the
  // difference is useful only to an attacker.
  const invalid = () => badRequest('OTP_INVALID', 'This code is invalid or has expired');

  if (!otp || otp.consumedAt) throw invalid();
  if (otp.expiresAt.getTime() < Date.now()) throw invalid();
  if (otp.attempts >= otp.maxAttempts) throw invalid();

  // Counted before the comparison, so a brute-force run exhausts its budget
  // even if every guess is wrong.
  otp.attempts += 1;
  await otp.save();

  if (!verifyOtp(params.code, otp.codeHash)) throw invalid();

  otp.consumedAt = new Date();
  await otp.save();

  // A successful login clears the throttles for that number.
  reset(`otp:cooldown:${otp.mobile}`);
  reset(`otp:hour:${otp.mobile}`);

  const employee = await Employee.findOne({ mobile: otp.mobile, deletedAt: null });

  if (!employee || !employee.profileCompletedAt) {
    return { isNewUser: true, registrationToken: signRegistrationToken(otp.mobile) };
  }

  if (employee.isBlocked) {
    throw forbidden('ACCOUNT_BLOCKED', 'This account has been blocked. Contact support.');
  }

  employee.lastActiveAt = new Date();
  await employee.save();

  const session = await issueSession(employee, {
    deviceId: params.deviceId,
    ip: params.ip,
    userAgent: params.userAgent,
  });

  return { isNewUser: false, ...session, employee: publicEmployee(employee) };
}

async function issueSession(
  employee: EmployeeDoc,
  meta: { deviceId?: string; ip?: string; userAgent?: string },
): Promise<{ accessToken: string; refreshToken: string }> {
  const settings = await getSettings();
  const refresh = await issueRefreshToken({
    subjectType: 'employee',
    subjectId: employee._id,
    ttlDays: settings.tokenExpiryDays,
    deviceId: meta.deviceId ?? null,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  });

  return {
    accessToken: signEmployeeAccessToken({
      employeeId: String(employee._id),
      mobile: employee.mobile,
      tokenVersion: employee.tokenVersion,
    }),
    refreshToken: refresh.token,
  };
}

/**
 * Completes signup. The mobile comes from the registration token, never from
 * the request body — otherwise anyone with a valid token could claim any number.
 */
export async function register(params: {
  mobile: string;
  input: RegisterInput;
  deviceId?: string;
  ip?: string;
  userAgent?: string;
}) {
  const mobile = normalizeMobile(params.mobile);
  const { input } = params;

  const existing = await Employee.findOne({ mobile, deletedAt: null });
  if (existing?.profileCompletedAt) {
    throw badRequest('ALREADY_REGISTERED', 'This number is already registered. Please sign in.');
  }

  const referralCode = await allocateReferralCode();

  const employee =
    existing ??
    new Employee({
      mobile,
      referralCode,
    });

  if (!employee.referralCode) employee.referralCode = referralCode;
  employee.name = input.name.trim();
  employee.age = input.age;
  employee.experienceBand = input.experienceBand;
  employee.categoryId = new Types.ObjectId(input.categoryId);
  employee.presentSalary = input.presentSalary ?? null;
  employee.expectedSalary = input.expectedSalary ?? null;
  employee.language = input.language ?? 'en';
  employee.profileCompletedAt = new Date();
  employee.lastActiveAt = new Date();

  if (input.referralCode) employee.referredByCodeRaw = input.referralCode.trim().toUpperCase();

  await employee.save();
  await bindReferral(employee, input.referralCode ?? null);

  const session = await issueSession(employee, params);

  await recordAudit({
    actorType: 'employee',
    actorId: employee._id,
    action: 'employee.register',
    entityType: 'employee',
    entityId: employee._id,
    after: { mobile: employee.mobile, name: employee.name },
    ip: params.ip ?? null,
  });

  return { ...session, employee: publicEmployee(employee) };
}

async function allocateReferralCode(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateReferralCode();
    if (!(await Employee.exists({ referralCode: code }))) return code;
  }
  // Astronomically unlikely; widening the code is better than looping forever.
  return generateReferralCode(10);
}

/**
 * Links a new signup to whoever referred them.
 *
 * Two paths exist and must converge: the friend types a code, or the referrer
 * submitted their details first. A pending referral on this mobile wins over a
 * typed code, because it is the record that actually promised a reward.
 */
async function bindReferral(employee: EmployeeDoc, typedCode: string | null): Promise<void> {
  const pending = await Referral.findOne({
    friendMobile: employee.mobile,
    status: 'pending',
  });

  if (pending) {
    if (pending.expiresAt && pending.expiresAt.getTime() < Date.now()) {
      await transitionReferral(pending, 'expired', { reason: 'Claim window lapsed' });
      logger.info({ referralId: String(pending._id) }, 'referral: expired before registration');
    } else {
      pending.friendEmployeeId = employee._id;
      await transitionReferral(pending, 'registered', { actorType: 'system' });

      employee.referredByEmployeeId = pending.referrerId;
      await employee.save();
      await recomputeReferralCount(pending.referrerId);

      if (typedCode) {
        const referrer = await Employee.findById(pending.referrerId).select('referralCode');
        if (referrer && referrer.referralCode !== typedCode.trim().toUpperCase()) {
          logger.warn(
            { employeeId: String(employee._id), typedCode, actual: referrer.referralCode },
            'referral: typed code conflicts with the pending referral record; record wins',
          );
        }
      }
      return;
    }
  }

  if (!typedCode) return;

  const referrer = await Employee.findOne({
    referralCode: typedCode.trim().toUpperCase(),
    deletedAt: null,
  });
  if (!referrer) return;
  if (String(referrer._id) === String(employee._id)) return;

  employee.referredByEmployeeId = referrer._id;
  await employee.save();
}

export async function refreshSession(params: {
  refreshToken: string;
  deviceId?: string;
  ip?: string;
  userAgent?: string;
}) {
  const rotated = await rotateRefreshToken(params.refreshToken, params);

  if (rotated.subjectType === 'employee') {
    const employee = await Employee.findOne({ _id: rotated.subjectId, deletedAt: null });
    if (!employee) throw unauthorized('ACCOUNT_NOT_FOUND', 'Account no longer exists');
    if (employee.isBlocked) throw forbidden('ACCOUNT_BLOCKED', 'This account has been blocked');

    return {
      accessToken: signEmployeeAccessToken({
        employeeId: String(employee._id),
        mobile: employee.mobile,
        tokenVersion: employee.tokenVersion,
      }),
      refreshToken: rotated.refresh.token,
    };
  }

  const admin = await Admin.findById(rotated.subjectId);
  if (!admin?.isActive) throw forbidden('ADMIN_INACTIVE', 'This admin account is inactive');

  return {
    accessToken: signAdminAccessToken({
      adminId: String(admin._id),
      email: admin.email,
      role: admin.role,
      tokenVersion: admin.tokenVersion,
    }),
    refreshToken: rotated.refresh.token,
  };
}

export const logout = (refreshToken: string): Promise<void> => revokeRefreshToken(refreshToken);

export const logoutAll = (employeeId: string): Promise<void> =>
  revokeAllForSubject('employee', employeeId);

const LOCK_THRESHOLD = 5;
const LOCK_MINUTES = 15;

/**
 * Admin login. Unknown emails still pay the cost of a hash verification so
 * response timing does not reveal which addresses exist.
 */
export async function adminLogin(params: {
  email: string;
  password: string;
  ip?: string;
  userAgent?: string;
}) {
  const admin = await Admin.findOne({ email: params.email.toLowerCase() }).select('+passwordHash');
  const invalid = () => unauthorized('INVALID_CREDENTIALS', 'Incorrect email or password');

  if (!admin) {
    await argon2.verify(
      '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$vzJLGBbLVJm/MBRTfBPfXeL6ZP2hXBz5V+p1S1nGzXk',
      params.password,
    ).catch(() => false);
    throw invalid();
  }

  if (admin.lockedUntil && admin.lockedUntil.getTime() > Date.now()) {
    const minutes = Math.ceil((admin.lockedUntil.getTime() - Date.now()) / 60_000);
    throw forbidden('ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${minutes} minute(s).`);
  }

  if (!admin.isActive) throw forbidden('ADMIN_INACTIVE', 'This admin account is inactive');

  const ok = await argon2.verify(admin.passwordHash, params.password).catch(() => false);

  if (!ok) {
    admin.failedLoginCount += 1;
    if (admin.failedLoginCount >= LOCK_THRESHOLD) {
      admin.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
      admin.failedLoginCount = 0;
    }
    await admin.save();
    throw invalid();
  }

  admin.failedLoginCount = 0;
  admin.lockedUntil = null;
  admin.lastLoginAt = new Date();
  await admin.save();

  const refresh = await issueRefreshToken({
    subjectType: 'admin',
    subjectId: admin._id,
    ip: params.ip ?? null,
    userAgent: params.userAgent ?? null,
  });

  await recordAudit({
    actorType: 'admin',
    actorId: admin._id,
    action: 'admin.login',
    entityType: 'admin',
    entityId: admin._id,
    ip: params.ip ?? null,
  });

  return {
    accessToken: signAdminAccessToken({
      adminId: String(admin._id),
      email: admin.email,
      role: admin.role,
      tokenVersion: admin.tokenVersion,
    }),
    refreshToken: refresh.token,
    admin: { id: String(admin._id), name: admin.name, email: admin.email, role: admin.role },
  };
}

export const hashPassword = (plain: string): Promise<string> =>
  argon2.hash(plain, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });

/** The employee shape the mobile app receives. Never includes internal counters' provenance. */
export function publicEmployee(e: EmployeeDoc) {
  return {
    id: String(e._id),
    mobile: e.mobile,
    employeeCode: e.employeeCode,
    referralCode: e.referralCode,
    name: e.name,
    age: e.age,
    experienceBand: e.experienceBand,
    categoryId: e.categoryId ? String(e.categoryId) : null,
    presentSalary: e.presentSalary,
    expectedSalary: e.expectedSalary,
    currentOrganization: e.currentOrganization,
    isEmployed: Boolean(e.currentOrganization),
    totalReferrals: e.totalReferrals,
    moneyEarned: e.moneyEarned,
    language: e.language,
    createdAt: e.createdAt,
  };
}

export async function ensureSeedAdminExists(input: {
  email: string;
  password: string;
  name: string;
}): Promise<void> {
  if (await Admin.exists({})) return;
  await Admin.create({
    email: input.email.toLowerCase(),
    name: input.name,
    passwordHash: await hashPassword(input.password),
    role: 'super_admin',
  });
  logger.info({ email: input.email }, 'auth: bootstrap super admin created');
}

export async function findEmployeeByMobile(mobile: string) {
  const normalized = normalizeMobile(mobile);
  const employee = await Employee.findOne({ mobile: normalized, deletedAt: null });
  if (!employee) throw notFound('EMPLOYEE_NOT_FOUND', 'No account found for this number');
  return employee;
}
