import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { getSettings, invalidateSettingsCache, recordAudit, Setting } from '../../models/index.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/error.js';
import { requireAdmin, requirePermission } from '../../middleware/auth.js';
import { decryptSecret, encryptSecret, maskSecret } from '../../utils/crypto.js';
import { TENURE_MONTH_OPTIONS } from '../../utils/constants.js';

export const adminSettingsRouter: Router = Router();

adminSettingsRouter.use(requireAdmin);

/** Secrets are returned masked and never in full — the admin panel can display but not exfiltrate them. */
async function settingsView() {
  const settings = await getSettings(true);
  const withSecrets = await Setting.findById(settings._id)
    .select('+smsApiKeyEnc +fcmServerKeyEnc')
    .lean();

  return {
    smsProvider: settings.smsProvider,
    smsSenderId: settings.smsSenderId,
    smsApiKey: maskSecret(
      withSecrets?.smsApiKeyEnc ? decryptSecret(withSecrets.smsApiKeyEnc) : null,
    ),
    fcmServerKey: maskSecret(
      withSecrets?.fcmServerKeyEnc ? decryptSecret(withSecrets.fcmServerKeyEnc) : null,
    ),
    defaultTenureMonths: settings.defaultTenureMonths,
    defaultRewardAmount: settings.defaultRewardAmount,
    tokenExpiryDays: settings.tokenExpiryDays,
    referralClaimWindowDays: settings.referralClaimWindowDays,
    updatedAt: settings.updatedAt,
  };
}

adminSettingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ data: await settingsView() });
  }),
);

adminSettingsRouter.patch(
  '/',
  requirePermission('settings:write'),
  validate({
    body: z.object({
      smsProvider: z.enum(['fast2sms', 'msg91', 'textlocal']).optional(),
      smsSenderId: z.string().min(3).max(11).optional(),
      smsApiKey: z.string().min(8).max(500).optional(),
      fcmServerKey: z.string().min(8).max(5000).optional(),
      defaultTenureMonths: z.union([z.literal(3), z.literal(6)]).optional(),
      defaultRewardAmount: z.number().int().min(0).max(1_000_000).optional(),
      tokenExpiryDays: z.number().int().min(1).max(365).optional(),
      referralClaimWindowDays: z.number().int().min(1).max(730).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const settings = await getSettings(true);
    const before = {
      smsProvider: settings.smsProvider,
      defaultTenureMonths: settings.defaultTenureMonths,
      defaultRewardAmount: settings.defaultRewardAmount,
    };

    const update: Record<string, unknown> = {};
    for (const key of [
      'smsProvider',
      'smsSenderId',
      'defaultTenureMonths',
      'defaultRewardAmount',
      'tokenExpiryDays',
      'referralClaimWindowDays',
    ] as const) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    // Write-only: a new value replaces the stored one, and is never echoed back.
    if (req.body.smsApiKey) update.smsApiKeyEnc = encryptSecret(req.body.smsApiKey);
    if (req.body.fcmServerKey) update.fcmServerKeyEnc = encryptSecret(req.body.fcmServerKey);
    update.updatedByAdminId = new Types.ObjectId(req.admin!.id);

    await Setting.updateOne({ _id: settings._id }, { $set: update });
    invalidateSettingsCache();

    await recordAudit({
      actorType: 'admin',
      actorId: req.admin!.id,
      action: 'settings.update',
      entityType: 'settings',
      entityId: settings._id,
      before,
      // Secret values are deliberately excluded from the audit payload.
      after: { ...update, smsApiKeyEnc: undefined, fcmServerKeyEnc: undefined },
    });

    res.json({ data: await settingsView() });
  }),
);

export { TENURE_MONTH_OPTIONS };
