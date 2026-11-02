export class RequestError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; this.code = code; }
}

export async function requestJSON<T>(path: string, options: RequestInit = {}, timeout = 20_000): Promise<T> {
  if (!path.startsWith("/api/") || path.startsWith("//")) throw new Error("Invalid endpoint");
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET") headers.set("X-Wasla-Web", "1");
  try {
    const response = await fetch(path, { ...options, headers, credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const fault = body as { error?: { code?: string; message?: string } } | null;
      throw new RequestError(fault?.error?.message || `HTTP ${response.status}`, response.status, fault?.error?.code);
    }
    if (!body || typeof body !== "object") throw new RequestError("Invalid server response", 502, "invalid_response");
    return body as T;
  } catch (error) {
    if (timedOut) throw new RequestError("Request timed out", 408, "timeout");
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export function safeSourceURL(value: string | null | undefined): URL | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

export function normalizePairCode(value: string): string {
  return value.trim().replace(/[٠-٩۰-۹]/g, (digit) => String(digit.charCodeAt(0) - (digit >= "۰" ? 0x6f0 : 0x660)));
}
