import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export interface SmsResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface SmsProvider {
  readonly name: string;
  send(to: string, message: string): Promise<SmsResult>;
}

/**
 * Logs instead of sending, so the entire OTP and referral flow is exercisable
 * with no gateway credentials. The OTP is surfaced to the caller separately
 * (see `exposeOtp`), never by parsing these logs.
 */
class MockSmsProvider implements SmsProvider {
  readonly name = 'mock';

  async send(to: string, message: string): Promise<SmsResult> {
    logger.info({ to, message }, '📱 SMS (mock)');
    return { ok: true, providerMessageId: `mock-${Date.now()}` };
  }
}

class Fast2SmsProvider implements SmsProvider {
  readonly name = 'fast2sms';

  async send(to: string, message: string): Promise<SmsResult> {
    const apiKey = env.FAST2SMS_API_KEY;
    if (!apiKey) return { ok: false, error: 'FAST2SMS_API_KEY not configured' };

    try {
      const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
        method: 'POST',
        headers: { authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          route: 'q',
          message,
          language: 'english',
          flash: 0,
          numbers: to.replace(/^\+91/, ''),
        }),
      });
      const json = (await res.json()) as { return?: boolean; request_id?: string; message?: string };
      if (!res.ok || !json.return) {
        return { ok: false, error: json.message ?? `HTTP ${res.status}` };
      }
      return { ok: true, providerMessageId: json.request_id };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

class Msg91Provider implements SmsProvider {
  readonly name = 'msg91';

  async send(to: string, message: string): Promise<SmsResult> {
    const authKey = env.MSG91_AUTH_KEY;
    if (!authKey) return { ok: false, error: 'MSG91_AUTH_KEY not configured' };

    try {
      const res = await fetch('https://control.msg91.com/api/v5/flow/', {
        method: 'POST',
        headers: { authkey: authKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: env.MSG91_TEMPLATE_ID,
          short_url: '0',
          recipients: [{ mobiles: to.replace(/^\+/, ''), MESSAGE: message }],
        }),
      });
      const json = (await res.json()) as { type?: string; message?: string };
      if (!res.ok || json.type === 'error') {
        return { ok: false, error: json.message ?? `HTTP ${res.status}` };
      }
      return { ok: true, providerMessageId: json.message };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

class TwilioProvider implements SmsProvider {
  readonly name = 'twilio';

  async send(to: string, message: string): Promise<SmsResult> {
    const sid = env.TWILIO_ACCOUNT_SID;
    const token = env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) return { ok: false, error: 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not configured' };

    // A Messaging Service picks the sender itself (and carries the India DLT
    // registration); a bare From number is the fallback.
    const body = new URLSearchParams({ To: to, Body: message });
    if (env.TWILIO_MESSAGING_SERVICE_SID) body.set('MessagingServiceSid', env.TWILIO_MESSAGING_SERVICE_SID);
    else if (env.TWILIO_FROM) body.set('From', env.TWILIO_FROM);
    else return { ok: false, error: 'TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM not configured' };
    if (env.TWILIO_STATUS_CALLBACK_URL) body.set('StatusCallback', env.TWILIO_STATUS_CALLBACK_URL);

    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      const json = (await res.json()) as { sid?: string; code?: number; message?: string };
      if (!res.ok || !json.sid) {
        return { ok: false, error: json.message ? `${json.code ?? res.status}: ${json.message}` : `HTTP ${res.status}` };
      }
      return { ok: true, providerMessageId: json.sid };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

/**
 * Twilio's X-Twilio-Signature: HMAC-SHA1 under the auth token, over the full
 * callback URL followed by every POST param as key+value, sorted by key.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac('sha1', authToken).update(payload).digest('base64');
}

export function isValidTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

const providers: Record<string, SmsProvider> = {
  mock: new MockSmsProvider(),
  fast2sms: new Fast2SmsProvider(),
  msg91: new Msg91Provider(),
  twilio: new TwilioProvider(),
};

export const smsProvider: SmsProvider = providers[env.SMS_PROVIDER] ?? providers.mock!;

/**
 * Fire-and-forget send. SMS failures must never roll back the business write
 * that triggered them — the referral or OTP record is already saved.
 */
export async function sendSms(to: string, message: string): Promise<SmsResult> {
  const result = await smsProvider.send(to, message);
  if (!result.ok) logger.warn({ to, error: result.error }, 'sms: delivery failed');
  return result;
}

export const smsTemplates = {
  otp: (code: string) => `${code} is your TalentPro verification code. Valid for 5 minutes. Do not share it with anyone.`,

  referralInvite: (friendName: string, referrerName: string, jobTitle?: string | null) =>
    jobTitle
      ? `Hi ${friendName}, ${referrerName} has shared a job with you on TalentPro: ${jobTitle}. Download the app to apply.`
      : `Hi ${friendName}, ${referrerName} has invited you to TalentPro — India's blue-collar hiring platform. Download the app to find jobs near you.`,

  shortlisted: (jobTitle: string, company: string) =>
    `Good news! You have been shortlisted for ${jobTitle} at ${company}. Open TalentPro for details.`,

  rewardPaid: (amount: number) =>
    `Your TalentPro referral reward of Rs.${amount.toLocaleString('en-IN')} has been approved. Thank you for referring!`,
};
