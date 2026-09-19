import 'dotenv/config';
import { z } from 'zod';

const csv = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: z.string().default('').transform(csv),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  // Separate secrets per audience: an employee token must be structurally
  // incapable of validating against the admin verifier.
  JWT_EMPLOYEE_SECRET: z.string().min(32),
  JWT_ADMIN_SECRET: z.string().min(32),
  OTP_PEPPER: z.string().min(32),
  SETTINGS_ENC_KEY: z.string().min(32),

  ACCESS_TOKEN_TTL_EMPLOYEE: z.string().default('15m'),
  ACCESS_TOKEN_TTL_ADMIN: z.string().default('8h'),
  REGISTRATION_TOKEN_TTL: z.string().default('10m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  ADMIN_REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

  SMS_PROVIDER: z.enum(['mock', 'fast2sms', 'msg91']).default('mock'),
  FAST2SMS_API_KEY: z.string().optional(),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_TEMPLATE_ID: z.string().optional(),

  PUSH_PROVIDER: z.enum(['mock', 'fcm']).default('mock'),
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),

  TIMEZONE: z.string().default('Asia/Kolkata'),
  ENABLE_CRON: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  EXPOSE_OTP_IN_DEV: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  SEED_ADMIN_EMAIL: z.string().email().default('admin@talentpro.local'),
  SEED_ADMIN_PASSWORD: z.string().min(8).default('Admin@123'),
  SEED_ADMIN_NAME: z.string().default('Super Admin'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  console.error(`\nInvalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.\n`);
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * The OTP is echoed back in API responses so the whole auth flow is testable
 * without an SMS gateway — but never in production, whatever the flag says.
 */
export const exposeOtp = env.EXPOSE_OTP_IN_DEV && !isProd;
