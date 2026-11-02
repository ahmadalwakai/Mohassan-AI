import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export class Fault extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
}
export const envelopeSchema = z.object({ nonce: z.string().regex(/^[\w-]{16}$/), ciphertext: z.string().regex(/^[\w-]+$/).max(1_500_000) }).strict();
export type Envelope = z.infer<typeof envelopeSchema>;
export function keyFrom(value: string | undefined): Buffer {
  if (!value) throw new Fault("not_configured", "لم يكتمل إعداد اتصال وصلة.", 503);
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Fault("not_configured", "إعداد اتصال وصلة غير صالح.", 503);
  return key;
}
export function seal(value: unknown, key: Buffer, aad: string): Envelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const raw = Buffer.from(JSON.stringify(value));
  if (raw.length > 1_048_576) throw new Fault("too_large", "حجم الطلب أكبر من الحد المسموح.", 413);
  const encrypted = Buffer.concat([cipher.update(raw), cipher.final(), cipher.getAuthTag()]);
  return { nonce: nonce.toString("base64url"), ciphertext: encrypted.toString("base64url") };
}
export function unseal(value: Envelope, key: Buffer, aad: string): unknown {
  const checked = envelopeSchema.parse(value);
  const raw = Buffer.from(checked.ciphertext, "base64url");
  if (raw.length < 17 || raw.length > 1_048_592) throw new Fault("invalid_envelope", "بيانات الاتصال غير صالحة.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(checked.nonce, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(0, -16)), decipher.final()]).toString("utf8"));
}
export function sameSecret(left: string, right: string): boolean {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}
const sessionSchema = z.object({ token: z.string().min(16).max(512), device_id: z.string().min(1).max(128), exp: z.number().int() }).strict();
export type Session = z.infer<typeof sessionSchema>;
export function packSession(session: Session, key: Buffer): string {
  return Buffer.from(JSON.stringify(seal(sessionSchema.parse(session), key, "wasla:web-session:v1"))).toString("base64url");
}
export function unpackSession(cookie: string | undefined, key: Buffer): Session | null {
  try {
    if (!cookie || cookie.length > 4096) return null;
    const result = sessionSchema.parse(unseal(JSON.parse(Buffer.from(cookie, "base64url").toString()), key, "wasla:web-session:v1"));
    return result.exp > Date.now() ? result : null;
  } catch { return null; }
}
export function requireSameOrigin(request: Request): void {
  const expected = process.env.WASLA_WEB_ORIGIN || new URL(request.url).origin;
  if (request.headers.get("origin") !== expected || request.headers.get("x-wasla-web") !== "1")
    throw new Fault("origin_denied", "هذا الطلب يجب أن يأتي من واجهة وصلة نفسها.", 403);
}
export async function boundedJSON(request: Request, maximum = 65_536): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Fault("invalid_json", "الطلب غير صالح.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new Fault("invalid_json", "الطلب فارغ.");
  const chunks: Uint8Array[] = []; let count = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      count += value.length;
      if (count > maximum) { await reader.cancel(); throw new Fault("too_large", "الطلب طويل جدًا.", 413); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) { if (error instanceof Fault) throw error; throw new Fault("invalid_json", "صيغة الطلب غير صالحة."); }
}
