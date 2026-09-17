import { Router } from 'express';
import * as service from './auth.service.js';
import {
  adminLoginSchema,
  otpRequestSchema,
  otpVerifySchema,
  refreshSchema,
  registerSchema,
} from './auth.schema.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/error.js';
import { clientIp, rateLimit } from '../../middleware/rateLimit.js';
import { requireEmployee, requireRegistrationToken } from '../../middleware/auth.js';

export const authRouter: Router = Router();

const meta = (req: Parameters<typeof clientIp>[0]) => ({
  ip: clientIp(req),
  userAgent: req.headers['user-agent'] as string | undefined,
});

authRouter.post(
  '/otp/request',
  validate({ body: otpRequestSchema }),
  asyncHandler(async (req, res) => {
    const result = await service.requestOtp({
      mobile: req.body.mobile,
      deviceId: req.body.deviceId,
      ip: clientIp(req),
    });
    res.json({ data: result });
  }),
);

authRouter.post(
  '/otp/verify',
  // Blunt per-IP backstop; the per-request attempt counter is the real limit.
  rateLimit({ prefix: 'otp-verify', limit: 40, windowMs: 3_600_000 }),
  validate({ body: otpVerifySchema }),
  asyncHandler(async (req, res) => {
    const result = await service.verifyOtpCode({
      requestId: req.body.requestId,
      code: req.body.code,
      deviceId: req.body.deviceId,
      ...meta(req),
    });
    res.json({ data: result });
  }),
);

authRouter.post(
  '/register',
  requireRegistrationToken,
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const result = await service.register({
      mobile: req.registration!.mobile,
      input: req.body,
      ...meta(req),
    });
    res.status(201).json({ data: result });
  }),
);

authRouter.post(
  '/refresh',
  validate({ body: refreshSchema }),
  asyncHandler(async (req, res) => {
    const result = await service.refreshSession({ refreshToken: req.body.refreshToken, ...meta(req) });
    res.json({ data: result });
  }),
);

authRouter.post(
  '/logout',
  validate({ body: refreshSchema }),
  asyncHandler(async (req, res) => {
    await service.logout(req.body.refreshToken);
    res.json({ data: { ok: true } });
  }),
);

authRouter.post(
  '/logout-all',
  requireEmployee,
  asyncHandler(async (req, res) => {
    await service.logoutAll(req.employee!.id);
    res.json({ data: { ok: true } });
  }),
);

export const adminAuthRouter: Router = Router();

adminAuthRouter.post(
  '/login',
  rateLimit({ prefix: 'admin-login', limit: 10, windowMs: 3_600_000 }),
  validate({ body: adminLoginSchema }),
  asyncHandler(async (req, res) => {
    const result = await service.adminLogin({
      email: req.body.email,
      password: req.body.password,
      ...meta(req),
    });
    res.json({ data: result });
  }),
);

adminAuthRouter.post(
  '/refresh',
  validate({ body: refreshSchema }),
  asyncHandler(async (req, res) => {
    const result = await service.refreshSession({ refreshToken: req.body.refreshToken, ...meta(req) });
    res.json({ data: result });
  }),
);

adminAuthRouter.post(
  '/logout',
  validate({ body: refreshSchema }),
  asyncHandler(async (req, res) => {
    await service.logout(req.body.refreshToken);
    res.json({ data: { ok: true } });
  }),
);
