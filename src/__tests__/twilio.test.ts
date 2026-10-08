import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../config/env.js';
import { isValidTwilioSignature, twilioSignature } from '../services/sms/index.js';

// The provider registry resolves SMS_PROVIDER once, at import.
vi.hoisted(() => {
  process.env.SMS_PROVIDER = 'twilio';
});

async function twilio() {
  const { smsProvider } = await import('../services/sms/index.js');
  return smsProvider;
}

describe('Twilio SMS provider', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    Object.assign(env, {
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'secret',
      TWILIO_MESSAGING_SERVICE_SID: 'MG456',
      TWILIO_FROM: undefined,
      TWILIO_STATUS_CALLBACK_URL: undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('posts a form-encoded message with basic auth and returns the SID', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ sid: 'SM789' }), { status: 201 }));
    const provider = await twilio();

    const result = await provider.send('+919876543210', 'hello');

    expect(result).toEqual({ ok: true, providerMessageId: 'SM789' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from('AC123:secret').toString('base64')}`);
    const body = init.body as URLSearchParams;
    expect(body.get('To')).toBe('+919876543210');
    expect(body.get('Body')).toBe('hello');
    expect(body.get('MessagingServiceSid')).toBe('MG456');
    expect(body.has('From')).toBe(false);
    expect(body.has('StatusCallback')).toBe(false);
  });

  it('falls back to a From number and adds the status callback when set', async () => {
    Object.assign(env, {
      TWILIO_MESSAGING_SERVICE_SID: undefined,
      TWILIO_FROM: '+15005550006',
      TWILIO_STATUS_CALLBACK_URL: 'https://api.example.com/api/v1/webhooks/twilio/status',
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ sid: 'SM1' }), { status: 201 }));
    const provider = await twilio();

    await provider.send('+919876543210', 'hi');

    const body = fetchMock.mock.calls[0]![1].body as URLSearchParams;
    expect(body.get('From')).toBe('+15005550006');
    expect(body.get('StatusCallback')).toBe('https://api.example.com/api/v1/webhooks/twilio/status');
  });

  it("surfaces Twilio's error code and message", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 21608, message: 'The number is unverified.' }), { status: 400 }),
    );
    const provider = await twilio();

    const result = await provider.send('+919876543210', 'hi');

    expect(result).toEqual({ ok: false, error: '21608: The number is unverified.' });
  });

  it('refuses to send without credentials or a sender', async () => {
    const provider = await twilio();

    env.TWILIO_AUTH_TOKEN = undefined;
    expect((await provider.send('+91', 'x')).ok).toBe(false);

    Object.assign(env, { TWILIO_AUTH_TOKEN: 'secret', TWILIO_MESSAGING_SERVICE_SID: undefined });
    expect((await provider.send('+91', 'x')).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a network failure rather than throwing', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const provider = await twilio();

    expect(await provider.send('+919876543210', 'hi')).toEqual({ ok: false, error: 'ECONNRESET' });
  });
});

describe('Twilio webhook signature', () => {
  const url = 'https://api.example.com/api/v1/webhooks/twilio/status';
  const params = { MessageSid: 'SM1', MessageStatus: 'delivered', To: '+919876543210' };

  it('accepts a signature computed with the auth token', () => {
    const signature = twilioSignature('secret', url, params);
    expect(isValidTwilioSignature('secret', url, params, signature)).toBe(true);
  });

  it('is independent of param order', () => {
    const reordered = { To: params.To, MessageStatus: params.MessageStatus, MessageSid: params.MessageSid };
    expect(twilioSignature('secret', url, reordered)).toBe(twilioSignature('secret', url, params));
  });

  it('rejects a tampered body, a wrong token, a wrong URL or a missing header', () => {
    const signature = twilioSignature('secret', url, params);
    expect(isValidTwilioSignature('secret', url, { ...params, MessageStatus: 'failed' }, signature)).toBe(false);
    expect(isValidTwilioSignature('other', url, params, signature)).toBe(false);
    expect(isValidTwilioSignature('secret', `${url}x`, params, signature)).toBe(false);
    expect(isValidTwilioSignature('secret', url, params, undefined)).toBe(false);
  });
});
