import { env, isTest } from '../../config/env.js';
import { logger } from '../../config/logger.js';

const TIMEOUT_MS = 15_000;

/**
 * Translates English strings to Gujarati, preserving order.
 *
 * Returns null when translation is disabled or the provider fails — callers
 * keep showing the English original, which is always a safe fallback.
 */
export async function translateToGujarati(texts: string[]): Promise<string[] | null> {
  if (env.TRANSLATE_PROVIDER === 'off' || isTest) return null;
  if (texts.length === 0) return [];

  try {
    return env.GOOGLE_TRANSLATE_API_KEY
      ? await cloudTranslate(texts, env.GOOGLE_TRANSLATE_API_KEY)
      : await Promise.all(texts.map(publicTranslate));
  } catch (err) {
    logger.warn({ err }, 'Gujarati translation failed');
    return null;
  }
}

/** Google Cloud Translation v2 — one request for the whole batch. */
async function cloudTranslate(texts: string[], key: string): Promise<string[]> {
  const res = await fetch(
    `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: texts, source: 'en', target: 'gu', format: 'text' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`Cloud Translation responded ${res.status}`);
  const body = (await res.json()) as { data: { translations: { translatedText: string }[] } };
  return body.data.translations.map((t) => t.translatedText);
}

/**
 * Google's keyless endpoint, as used by the translate.google.com widget. POST
 * so a long description never hits a URL length limit. The response splits the
 * text into sentences; the first element of each segment is the translation.
 */
async function publicTranslate(text: string): Promise<string> {
  if (!text.trim()) return text;
  const res = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=gu&dt=t', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({ q: text }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Google Translate responded ${res.status}`);
  const body = (await res.json()) as [[string, ...unknown[]][], ...unknown[]];
  return body[0].map((segment) => segment[0]).join('');
}
