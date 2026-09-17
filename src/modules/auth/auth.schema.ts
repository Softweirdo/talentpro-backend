import { z } from 'zod';
import { EXPERIENCE_BANDS, LANGUAGES } from '../../utils/constants.js';

export const otpRequestSchema = z.object({
  mobile: z.string().min(10).max(20),
  deviceId: z.string().max(120).optional(),
});

export const otpVerifySchema = z.object({
  requestId: z.string().min(1),
  code: z.string().regex(/^\d{4,8}$/, 'Enter the numeric code from the SMS'),
  deviceId: z.string().max(120).optional(),
});

export const registerSchema = z.object({
  name: z.string().min(2, 'Enter your full name').max(120),
  age: z.number().int().min(16).max(75),
  experienceBand: z.enum(EXPERIENCE_BANDS),
  categoryId: z.string().length(24, 'Choose a job category'),
  presentSalary: z.number().int().min(0).max(10_000_000).nullable().optional(),
  expectedSalary: z.number().int().min(0).max(10_000_000).nullable().optional(),
  referralCode: z.string().max(20).optional().nullable(),
  language: z.enum(LANGUAGES).optional(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

export const adminLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type OtpRequestInput = z.infer<typeof otpRequestSchema>;
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type AdminLoginInput = z.infer<typeof adminLoginSchema>;
