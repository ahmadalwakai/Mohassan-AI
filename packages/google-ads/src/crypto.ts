import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { GoogleAdsError } from './errors.ts';

const VERSION = 'v1';

/** A base64 key of exactly 32 bytes, so a weak or truncated value fails at startup. */
export function parseTokenKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('GOOGLE_ADS_TOKEN_KEY must be 32 random bytes in base64.');
  return key;
}

/** AES-256-GCM. The purpose and owner are authenticated, so a sealed value cannot move between rows. */
export function seal(plain: string, key: Buffer, context: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export function unseal(sealed: string, key: Buffer, context: string): string {
  const unreadable = () => new GoogleAdsError('GOOGLE_ADS_TOKEN_UNREADABLE', 'تعذرت قراءة تفويض Google المحفوظ. أعد ربط الحساب.', 401);
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || body === undefined) throw unreadable();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
  } catch { throw unreadable(); }
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Key order must not change a hash, or an unchanged draft would look edited. */
export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => [key, sort(entry)]))
    : item;
  return JSON.stringify(sort(value));
}
