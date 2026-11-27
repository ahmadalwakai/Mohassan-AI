import { ChatCapabilitiesSchema, ChatConversationSchema, ChatConversationSummarySchema, type ChatConversation } from "@mohassan/contracts";
import { z } from "zod";
import { ChatHttpError, chatErrorMessage, isSessionExpired, OFFLINE_MESSAGE } from "./chat-connection";
export { chatHttpErrorMessage } from "./chat-connection";

const sessionEvents = new EventTarget();
let sessionVersion = 0;

export function renewChatSession() {
  sessionVersion += 1;
}

export function onSessionExpired(listener: () => void): () => void {
  sessionEvents.addEventListener("expired", listener);
  return () => sessionEvents.removeEventListener("expired", listener);
}

// Opt in only for authenticated requests. A 401 from a sign-in attempt means invalid credentials.
export async function sessionFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;
  init?.signal?.throwIfAborted();
  if (offline()) throw new Error(OFFLINE_MESSAGE);
  const version = sessionVersion;
  const response = await fetch(input, init).catch((error: unknown) => {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new Error(chatErrorMessage(error, offline()), { cause: error });
  });
  if (!response.ok && isSessionExpired(new ChatHttpError(response.status)) && version === sessionVersion) {
    renewChatSession();
    sessionEvents.dispatchEvent(new Event("expired"));
  }
  return response;
}

export async function requestChatJson<T>(path: string, options: RequestInit = {}, send = sessionFetch): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await send(path, { ...options, headers, credentials: "same-origin", cache: "no-store" });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ChatHttpError(response.status, body?.error?.message ?? body?.message, body?.error?.code ?? body?.code);
  return body as T;
}

export async function requestChatConversation(path: string, options?: RequestInit): Promise<ChatConversation> {
  const body = await requestChatJson<unknown>(path, options);
  const result = ChatConversationSchema.safeParse(body);
  if (!result.success) throw new Error("تعذّر قراءة بيانات المحادثة. أعد المحاولة.");
  return result.data;
}

const historySchema = z.object({
  conversations: z.array(ChatConversationSummarySchema),
  configured: z.boolean().optional(),
  capabilities: ChatCapabilitiesSchema.optional(),
});

export async function requestChatHistory(signal?: AbortSignal) {
  const body = await requestChatJson<unknown>("/api/chat/conversations", { signal });
  const result = historySchema.safeParse(body);
  if (!result.success) throw new Error("تعذّر قراءة قائمة المحادثات.");
  return result.data;
}
