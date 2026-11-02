import https from "node:https";
import tls from "node:tls";
import { readFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { Fault, sameSecret } from "./security";
import { relayRequest } from "./relay";

export interface UpstreamRequest { method: string; path: string; body?: unknown; authorization?: string }
export interface UpstreamResponse { status: number; body: Record<string, unknown> }
export function configured(): boolean {
  if (!process.env.WASLA_SESSION_KEY) return false;
  return process.env.WASLA_TRANSPORT === "relay"
    ? Boolean(process.env.DATABASE_URL && process.env.WASLA_RELAY_TOKEN && process.env.WASLA_RELAY_KEY_BASE64 && process.env.WASLA_RELAY_INSTALLATION_ID)
    : Boolean(process.env.WASLA_UPSTREAM_URL && process.env.WASLA_UPSTREAM_PIN && process.env.WASLA_CA_FILE);
}
export function allowedRoute(method: string, path: string): boolean {
  const fixed: Record<string, string[]> = {
    "/v1/pair": ["POST"], "/v1/status": ["GET"], "/v1/session": ["DELETE"], "/v1/chat": ["POST"],
    "/v1/knowledge": ["GET", "POST"], "/v1/conversations": ["GET"], "/v1/settings": ["GET", "PATCH"], "/v1/metrics": ["GET"],
  };
  if (fixed[path]?.includes(method)) return true;
  const child = path.match(/^\/v1\/(knowledge|conversations)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  return Boolean(child && (method === "DELETE" || child[1] === "conversations" && method === "GET"));
}
export async function upstream(input: UpstreamRequest): Promise<UpstreamResponse> {
  if (!allowedRoute(input.method, input.path)) throw new Fault("invalid_route", "عملية غير مسموحة.");
  if (process.env.WASLA_TRANSPORT === "relay") return relayRequest(input);
  const url = new URL(process.env.WASLA_UPSTREAM_URL || "https://invalid.invalid");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Fault("not_configured", "عنوان الكمبيوتر غير صالح.", 503);
  const pin = process.env.WASLA_UPSTREAM_PIN?.toLowerCase();
  if (!pin || !/^[a-f0-9]{64}$/.test(pin) || !process.env.WASLA_CA_FILE) throw new Fault("not_configured", "هوية الكمبيوتر غير مهيأة.", 503);
  const ca = await readFile(process.env.WASLA_CA_FILE);
  // A copied trusted certificate plus normal chain/validity/SAN checks. Never
  // turn rejectUnauthorized off, and never follow an upstream redirect.
  if (!sameSecret(new X509Certificate(ca).fingerprint256.replaceAll(":", "").toLowerCase(), pin)) throw new Fault("certificate", "بصمة شهادة الكمبيوتر لا تطابق الإعداد.", 502);
  const data = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body));
  return new Promise((resolve, reject) => {
    const timeout = input.path === "/v1/chat" ? 240_000 : 15_000;
    const fail = (error: Error) => { clearTimeout(timer); reject(error); };
    const req = https.request(new URL(input.path, url), {
      method: input.method, ca, minVersion: "TLSv1.2", rejectUnauthorized: true, agent: false,
      checkServerIdentity(host, cert) {
        const error = tls.checkServerIdentity(host, cert);
        if (error) return error;
        if (!cert.fingerprint256 || !sameSecret(cert.fingerprint256.replaceAll(":", "").toLowerCase(), pin)) return new Error("Certificate pin mismatch");
      },
      headers: { Accept: "application/json", ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}), ...(input.authorization ? { Authorization: input.authorization } : {}) },
    }, (response) => {
      const status = response.statusCode || 502;
      if (status >= 300 && status < 400) { response.destroy(); fail(new Fault("redirect_denied", "تغير عنوان الخدمة بصورة غير متوقعة.", 502)); return; }
      const chunks: Buffer[] = []; let length = 0;
      response.on("data", (chunk: Buffer) => { length += chunk.length; if (length > 1_048_576) { response.destroy(); fail(new Fault("too_large", "رد الكمبيوتر طويل جدًا.", 502)); } else chunks.push(chunk); });
      response.on("error", () => fail(new Fault("upstream_unavailable", "انقطع الاتصال بالكمبيوتر. لم يُعد إرسال الطلب.", 502)));
      response.on("end", () => {
        clearTimeout(timer);
        try { const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(); resolve({ status, body }); }
        catch { fail(new Fault("invalid_response", "وصل رد غير صالح من الكمبيوتر.", 502)); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("deadline")), timeout);
    req.setTimeout(timeout, () => req.destroy(new Error("timeout")));
    req.on("error", () => fail(new Fault("upstream_unavailable", "تعذّر الوصول إلى الكمبيوتر. شغّل وصلة واتصال الشبكة الخاص.", 502)));
    if (data) req.write(data); req.end();
  });
}
