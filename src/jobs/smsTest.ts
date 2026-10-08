/**
 * Sends test SMS through the configured SMS_PROVIDER, to check gateway
 * credentials and template wording without going through the app.
 *
 *   npm run sms:test -- 9876543210         # OTP only
 *   npm run sms:test -- 9876543210 --all   # every template
 */
import { env } from '../config/env.js';
import { normalizeMobile } from '../utils/mobile.js';
import { smsProvider, smsTemplates } from '../services/sms/index.js';

const [raw, flag] = process.argv.slice(2);
if (!raw) {
  console.error('Usage: npm run sms:test -- <mobile> [--all]');
  process.exit(1);
}

const samples: Record<string, string> = {
  otp: smsTemplates.otp('123456'),
  ...(flag === '--all' && {
    referralInvite: smsTemplates.referralInvite('Ravi', 'Amit', 'Forklift Operator'),
    referralInviteNoJob: smsTemplates.referralInvite('Ravi', 'Amit'),
    shortlisted: smsTemplates.shortlisted('Forklift Operator', 'Mpower Solutions'),
    rewardPaid: smsTemplates.rewardPaid(5000),
  }),
};

const to = normalizeMobile(raw);
let failed = 0;
for (const [name, message] of Object.entries(samples)) {
  const result = await smsProvider.send(to, message);
  console.log(`${env.SMS_PROVIDER} → ${to} [${name}]`, result);
  if (!result.ok) failed++;
}
process.exit(failed ? 1 : 0);
