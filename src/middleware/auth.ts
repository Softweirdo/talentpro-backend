import type { RequestHandler } from 'express';
import { Admin, Employee, hasPermission } from '../models/index.js';
import {
  verifyAdminAccessToken,
  verifyEmployeeAccessToken,
  verifyRegistrationToken,
} from '../services/tokens.js';
import { forbidden, unauthorized } from '../utils/errors.js';
import type { AdminRole } from '../utils/constants.js';

function bearer(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) {
    throw unauthorized('TOKEN_MISSING', 'Authentication required');
  }
  return header.slice(7).trim();
}

/**
 * Employee-audience guard. Re-reads the employee so a blocked account or a
 * bumped `tokenVersion` takes effect immediately rather than at token expiry.
 */
export const requireEmployee: RequestHandler = async (req, _res, next) => {
  try {
    const claims = verifyEmployeeAccessToken(bearer(req.headers.authorization));
    const employee = await Employee.findOne({ _id: claims.sub, deletedAt: null }).select(
      'mobile isBlocked tokenVersion',
    );

    if (!employee) throw unauthorized('ACCOUNT_NOT_FOUND', 'Account no longer exists');
    if (employee.isBlocked) throw forbidden('ACCOUNT_BLOCKED', 'This account has been blocked');
    if (employee.tokenVersion !== claims.ver) {
      throw unauthorized('TOKEN_STALE', 'Please sign in again');
    }

    req.employee = {
      id: String(employee._id),
      mobile: employee.mobile,
      tokenVersion: employee.tokenVersion,
    };
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Admin-audience guard. An employee token fails here at signature verification,
 * not at a claim check — the two audiences use different signing secrets.
 */
export const requireAdmin: RequestHandler = async (req, _res, next) => {
  try {
    const claims = verifyAdminAccessToken(bearer(req.headers.authorization));
    const admin = await Admin.findById(claims.sub).select('email role isActive tokenVersion');

    if (!admin?.isActive) throw forbidden('ADMIN_INACTIVE', 'This admin account is inactive');
    if (admin.tokenVersion !== claims.ver) {
      throw unauthorized('TOKEN_STALE', 'Please sign in again');
    }

    req.admin = {
      id: String(admin._id),
      email: admin.email,
      role: admin.role,
      tokenVersion: admin.tokenVersion,
    };
    next();
  } catch (err) {
    next(err);
  }
};

/** Gates an admin route on a specific permission. Use after `requireAdmin`. */
export const requirePermission =
  (permission: string): RequestHandler =>
  (req, _res, next) => {
    const role = req.admin?.role as AdminRole | undefined;
    if (!role) return next(unauthorized());
    if (!hasPermission(role, permission)) {
      return next(
        forbidden('INSUFFICIENT_ROLE', `Your role (${role}) cannot perform this action`),
      );
    }
    next();
  };

/** Unlocks signup completion only. The mobile comes from the token, never the body. */
export const requireRegistrationToken: RequestHandler = (req, _res, next) => {
  try {
    const claims = verifyRegistrationToken(bearer(req.headers.authorization));
    req.registration = { mobile: claims.mobile };
    next();
  } catch (err) {
    next(err);
  }
};

/** Attaches the employee when a valid token is present, but never rejects. */
export const optionalEmployee: RequestHandler = async (req, _res, next) => {
  if (!req.headers.authorization) return next();
  try {
    await new Promise<void>((resolve, reject) =>
      requireEmployee(req, _res, (err?: unknown) => (err ? reject(err) : resolve())),
    );
  } catch {
    // An invalid token on an optional route is simply an anonymous request.
  }
  next();
};
