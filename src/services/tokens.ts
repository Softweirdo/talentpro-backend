import jwt, { type SignOptions } from 'jsonwebtoken';
import { Types } from 'mongoose';
import { env } from '../config/env.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { generateOpaqueToken, sha256 } from '../utils/crypto.js';
import { unauthorized } from '../utils/errors.js';
import { logger } from '../config/logger.js';
import type { AdminRole } from '../utils/constants.js';

export type Audience = 'employee' | 'admin' | 'register';

interface EmployeeClaims {
  sub: string;
  aud: 'employee';
  mobile: string;
  ver: number;
}

interface AdminClaims {
  sub: string;
  aud: 'admin';
  email: string;
  role: AdminRole;
  ver: number;
}

interface RegistrationClaims {
  aud: 'register';
  mobile: string;
}

/**
 * Each audience is signed with its own secret. Verifying an employee token with
 * the admin verifier fails at the signature, not merely at an `aud` check — the
 * classic privilege-escalation bug in this architecture becomes unrepresentable.
 */
const SECRETS: Record<Audience, string> = {
  employee: env.JWT_EMPLOYEE_SECRET,
  admin: env.JWT_ADMIN_SECRET,
  // Derived from the employee secret but distinct, so a registration token can
  // never be replayed as an access token.
  register: `${env.JWT_EMPLOYEE_SECRET}:register`,
};

function sign(payload: object, audience: Audience, expiresIn: string): string {
  const options: SignOptions = {
    audience,
    issuer: 'talentpro',
    expiresIn: expiresIn as SignOptions['expiresIn'],
  };
  return jwt.sign(payload, SECRETS[audience], options);
}

function verify<T>(token: string, audience: Audience): T {
  try {
    return jwt.verify(token, SECRETS[audience], {
      audience,
      issuer: 'talentpro',
    }) as T;
  } catch (err) {
    const expired = err instanceof jwt.TokenExpiredError;
    throw unauthorized(
      expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
      expired ? 'Your session has expired' : 'Invalid authentication token',
    );
  }
}

export const signEmployeeAccessToken = (p: {
  employeeId: string;
  mobile: string;
  tokenVersion: number;
}): string =>
  sign({ sub: p.employeeId, mobile: p.mobile, ver: p.tokenVersion }, 'employee', env.ACCESS_TOKEN_TTL_EMPLOYEE);

export const signAdminAccessToken = (p: {
  adminId: string;
  email: string;
  role: AdminRole;
  tokenVersion: number;
}): string =>
  sign(
    { sub: p.adminId, email: p.email, role: p.role, ver: p.tokenVersion },
    'admin',
    env.ACCESS_TOKEN_TTL_ADMIN,
  );

/** Short-lived, single-purpose: it unlocks `POST /auth/register` and nothing else. */
export const signRegistrationToken = (mobile: string): string =>
  sign({ mobile }, 'register', env.REGISTRATION_TOKEN_TTL);

export const verifyEmployeeAccessToken = (t: string) => verify<EmployeeClaims>(t, 'employee');
export const verifyAdminAccessToken = (t: string) => verify<AdminClaims>(t, 'admin');
export const verifyRegistrationToken = (t: string) => verify<RegistrationClaims>(t, 'register');

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
}

export async function issueRefreshToken(params: {
  subjectType: 'employee' | 'admin';
  subjectId: Types.ObjectId | string;
  familyId?: Types.ObjectId;
  parentId?: Types.ObjectId | null;
  ttlDays?: number;
  deviceId?: string | null;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<IssuedRefreshToken> {
  const ttlDays =
    params.ttlDays ??
    (params.subjectType === 'admin' ? env.ADMIN_REFRESH_TOKEN_TTL_DAYS : env.REFRESH_TOKEN_TTL_DAYS);

  const token = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
  const familyId = params.familyId ?? new Types.ObjectId();

  await RefreshToken.create({
    subjectType: params.subjectType,
    subjectId: new Types.ObjectId(String(params.subjectId)),
    tokenHash: sha256(token),
    familyId,
    parentId: params.parentId ?? null,
    deviceId: params.deviceId ?? null,
    userAgent: params.userAgent ?? null,
    ip: params.ip ?? null,
    expiresAt,
  });

  return { token, expiresAt };
}

export interface RotationResult {
  subjectType: 'employee' | 'admin';
  subjectId: Types.ObjectId;
  refresh: IssuedRefreshToken;
}

/**
 * Rotates a refresh token, revoking the old one.
 *
 * Presenting a token that was already rotated away means it leaked — the entire
 * family is revoked and the user must authenticate from scratch.
 */
export async function rotateRefreshToken(
  presented: string,
  meta: { deviceId?: string | null; userAgent?: string | null; ip?: string | null } = {},
): Promise<RotationResult> {
  const record = await RefreshToken.findOne({ tokenHash: sha256(presented) });
  if (!record) throw unauthorized('REFRESH_INVALID', 'Please sign in again');

  if (record.revokedAt) {
    await RefreshToken.updateMany(
      { familyId: record.familyId, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'reuse_detected' } },
    );
    logger.warn(
      { subjectId: String(record.subjectId), familyId: String(record.familyId) },
      'auth: refresh token reuse detected, family revoked',
    );
    throw unauthorized('REFRESH_REUSED', 'Session invalidated for security. Please sign in again.');
  }

  if (record.expiresAt.getTime() < Date.now()) {
    throw unauthorized('REFRESH_EXPIRED', 'Your session has expired. Please sign in again.');
  }

  record.revokedAt = new Date();
  record.revokedReason = 'rotated';
  await record.save();

  const refresh = await issueRefreshToken({
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    familyId: record.familyId,
    parentId: record._id,
    deviceId: meta.deviceId ?? record.deviceId,
    userAgent: meta.userAgent ?? record.userAgent,
    ip: meta.ip ?? record.ip,
  });

  return { subjectType: record.subjectType, subjectId: record.subjectId, refresh };
}

export async function revokeRefreshToken(presented: string, reason = 'logout'): Promise<void> {
  await RefreshToken.updateOne(
    { tokenHash: sha256(presented), revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
}

export async function revokeAllForSubject(
  subjectType: 'employee' | 'admin',
  subjectId: Types.ObjectId | string,
  reason = 'logout_all',
): Promise<void> {
  await RefreshToken.updateMany(
    { subjectType, subjectId: new Types.ObjectId(String(subjectId)), revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
}
