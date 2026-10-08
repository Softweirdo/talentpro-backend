import { Router } from 'express';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { Otp, Referral } from '../../models/index.js';
import { isValidTwilioSignature } from '../../services/sms/index.js';

/**
 * Twilio's delivery reports for messages sent with a StatusCallback. Twilio
 * can report "sent" while an Indian carrier silently drops the SMS (DLT
 * mismatch); only "delivered" means it reached the handset.
 */
export const twilioWebhookRouter = Router();

const FINAL_STATUS: Record<string, 'delivered' | 'failed'> = {
  delivered: 'delivered',
  failed: 'failed',
  undelivered: 'failed',
};

twilioWebhookRouter.post('/status', async (req, res, next) => {
  try {
    const token = env.TWILIO_AUTH_TOKEN;
    const url = env.TWILIO_STATUS_CALLBACK_URL;
    const params = req.body as Record<string, string>;
    if (!token || !url || !isValidTwilioSignature(token, url, params, req.get('x-twilio-signature'))) {
      res.status(403).end();
      return;
    }

    const { MessageSid: sid, MessageStatus: status, ErrorCode: errorCode, To: to } = params;
    const smsStatus = status ? FINAL_STATUS[status] : undefined;
    if (sid && smsStatus) {
      if (smsStatus === 'failed') logger.warn({ sid, to, status, errorCode }, 'sms: twilio reports undelivered');
      const filter = { smsProviderMessageId: sid };
      await Promise.all([
        Otp.updateOne(filter, { $set: { smsStatus } }),
        Referral.updateOne(filter, { $set: { smsStatus } }),
      ]);
    }
    // Intermediate statuses (queued, sent…) are acknowledged and ignored.
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
