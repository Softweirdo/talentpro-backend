import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export interface PushPayload {
  title: string;
  body: string;
  /** Deep-link data, e.g. `{ screen: 'JobDetail', jobId }`. Values must be strings for FCM. */
  data?: Record<string, string>;
}

export interface PushResult {
  sent: number;
  failed: number;
  /** Tokens FCM reported as permanently invalid; callers should delete them. */
  invalidTokens: string[];
}

export interface PushProvider {
  readonly name: string;
  sendToTokens(tokens: string[], payload: PushPayload): Promise<PushResult>;
}

class MockPushProvider implements PushProvider {
  readonly name = 'mock';

  async sendToTokens(tokens: string[], payload: PushPayload): Promise<PushResult> {
    logger.info(
      { recipients: tokens.length, title: payload.title, body: payload.body, data: payload.data },
      '🔔 Push (mock)',
    );
    return { sent: tokens.length, failed: 0, invalidTokens: [] };
  }
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

/**
 * FCM HTTP v1. Uses a self-signed JWT exchanged for an OAuth access token,
 * which avoids pulling in the whole google-auth-library for one call.
 */
class FcmProvider implements PushProvider {
  readonly name = 'fcm';
  private account: ServiceAccount | null = null;
  private accessToken: { value: string; expiresAt: number } | null = null;

  private getAccount(): ServiceAccount | null {
    if (this.account) return this.account;
    if (!env.FCM_SERVICE_ACCOUNT_JSON) return null;
    try {
      this.account = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON) as ServiceAccount;
      return this.account;
    } catch {
      logger.error('push: FCM_SERVICE_ACCOUNT_JSON is not valid JSON');
      return null;
    }
  }

  private async getAccessToken(account: ServiceAccount): Promise<string | null> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) {
      return this.accessToken.value;
    }

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(
      JSON.stringify({
        iss: account.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      }),
    ).toString('base64url');

    const signature = crypto
      .createSign('RSA-SHA256')
      .update(`${header}.${claims}`)
      .sign(account.private_key.replace(/\\n/g, '\n'), 'base64url');

    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: `${header}.${claims}.${signature}`,
        }),
      });
      const json = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!json.access_token) return null;
      this.accessToken = {
        value: json.access_token,
        expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
      };
      return json.access_token;
    } catch (err) {
      logger.error({ err }, 'push: failed to mint FCM access token');
      return null;
    }
  }

  async sendToTokens(tokens: string[], payload: PushPayload): Promise<PushResult> {
    const account = this.getAccount();
    if (!account) {
      logger.warn('push: FCM not configured, dropping notification');
      return { sent: 0, failed: tokens.length, invalidTokens: [] };
    }

    const accessToken = await this.getAccessToken(account);
    if (!accessToken) return { sent: 0, failed: tokens.length, invalidTokens: [] };

    const url = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;
    const invalidTokens: string[] = [];
    let sent = 0;
    let failed = 0;

    // FCM v1 has no true multicast; send in bounded concurrent batches.
    const BATCH = 50;
    for (let i = 0; i < tokens.length; i += BATCH) {
      const batch = tokens.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async (token) => {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              message: {
                token,
                notification: { title: payload.title, body: payload.body },
                data: payload.data ?? {},
                android: { priority: 'high', notification: { sound: 'default' } },
                apns: { payload: { aps: { sound: 'default' } } },
              },
            }),
          });
          if (res.status === 404 || res.status === 400) {
            const body = (await res.json()) as { error?: { status?: string } };
            if (body.error?.status === 'NOT_FOUND' || body.error?.status === 'INVALID_ARGUMENT') {
              invalidTokens.push(token);
            }
            throw new Error(`FCM ${res.status}`);
          }
          if (!res.ok) throw new Error(`FCM ${res.status}`);
        }),
      );
      sent += results.filter((r) => r.status === 'fulfilled').length;
      failed += results.filter((r) => r.status === 'rejected').length;
    }

    return { sent, failed, invalidTokens };
  }
}

const providers: Record<string, PushProvider> = {
  mock: new MockPushProvider(),
  fcm: new FcmProvider(),
};

export const pushProvider: PushProvider = providers[env.PUSH_PROVIDER] ?? providers.mock!;
