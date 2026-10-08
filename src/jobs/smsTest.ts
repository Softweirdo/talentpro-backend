/**
 * Sends test SMS through the configured SMS_PROVIDER, to check gateway
 * credentials and template wording without going through the app.
 *
 *   npm run sms:test -- 9876543210           # send a login OTP
 *   npm run sms:test -- 9876543210 644692    # check the OTP you received
 *   npm run sms:test -- 9876543210 --all     # every template
 *
 * With TWILIO_VERIFY_SERVICE_SID set, the OTP goes through Twilio Verify —
 * exactly as the login flow sends it — and Twilio picks the code.
 */
import { env } from '../config/env.js';
import { normalizeMobile } from '../utils/mobile.js';
import { smsProvider, smsTemplates, twilioVerify } from '../services/sms/index.js';

const [raw, arg] = process.argv.slice(2);
if (!raw) {
  console.error('Usage: npm run sms:test -- <mobile> [<code> | --all]');
  process.exit(1);
}

const to = normalizeMobile(raw);

if (twilioVerify.enabled && arg !== '--all') {
  if (arg) {
    const approved = await twilioVerify.check(to, arg);
    console.log(`twilio verify → ${to} [check ${arg}]`, approved ? 'approved' : 'rejected');
    process.exit(approved ? 0 : 1);
  }
  const result = await twilioVerify.start(to);
  console.log(`twilio verify → ${to} [otp]`, result);
  if (result.ok) console.log(`Check it with: npm run sms:test -- ${raw} <code>`);
  process.exit(result.ok ? 0 : 1);
}

const samples: Record<string, string> = {
  otp: smsTemplates.otp('123456'),
  ...(arg === '--all' && {
    referralInvite: smsTemplates.referralInvite('Ravi', 'Amit', 'Forklift Operator'),
    referralInviteNoJob: smsTemplates.referralInvite('Ravi', 'Amit'),
    shortlisted: smsTemplates.shortlisted('Forklift Operator', 'Mpower Solutions'),
    rewardPaid: smsTemplates.rewardPaid(5000),
  }),
};

let failed = 0;
for (const [name, message] of Object.entries(samples)) {
  const result = await smsProvider.send(to, message);
  console.log(`${env.SMS_PROVIDER} → ${to} [${name}]`, result);
  if (!result.ok) failed++;
}
process.exit(failed ? 1 : 0);
