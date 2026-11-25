import type { ZodType } from "zod";

export const shareListPath = "/api/chat/conversation-shares";
export const shareSettingsPath = "/api/chat/conversation-share-settings";
export const conversationPath = (id: string) => `/api/chat/conversations/${encodeURIComponent(id)}`;

export async function shareFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw Object.assign(new Error(body?.error?.message ?? "تعذر إتمام الطلب. حاول مجددًا."), { status: response.status });
  }
  return response;
}

export async function shareJson<T>(schema: ZodType<T>, path: string, init?: RequestInit): Promise<T> {
  const response = await shareFetch(path, init);
  const result = schema.safeParse(await response.json().catch(() => null));
  if (!result.success) throw new Error("تعذر قراءة ردّ الخدمة.");
  return result.data;
}

export const shareError = (caught: unknown) => caught instanceof Error ? caught.message : "تعذر الاتصال بالخدمة.";
