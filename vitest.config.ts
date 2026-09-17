import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The pure-logic suite needs env vars present for config/env.ts to load.
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://localhost:27017/talentpro-test',
      JWT_EMPLOYEE_SECRET: 'test-employee-secret-at-least-32-characters',
      JWT_ADMIN_SECRET: 'test-admin-secret-at-least-32-characters-xx',
      OTP_PEPPER: 'test-otp-pepper-at-least-32-characters-long',
      SETTINGS_ENC_KEY: 'test-settings-key-at-least-32-characters-xx',
    },
  },
});
