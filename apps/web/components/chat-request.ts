import type { ChatCapabilities, ChatConversation, ChatConversationSummary } from "@mohassan/contracts";
import { z } from "zod";
import { ChatHttpError, chatErrorMessage, isSessionExpired, OFFLINE_REQUEST_MESSAGE } from "./chat-connection";
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
  if (offline()) throw new Error(OFFLINE_REQUEST_MESSAGE);
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

// The server and web deploy independently. Check the fields the UI reads and keep the wire reply intact.
const itemShape = z.object({ id: z.string() });
const summaryShape = itemShape.extend({
  status: z.string(),
  title: z.string().optional(),
  updatedAt: z.string().optional(),
  browserAccount: z.string().nullish(),
});
const capabilitiesShape = z.object({
  available: z.array(z.string()),
  chatModel: z.boolean().optional(),
  smartMonitors: z.boolean().optional(),
  smartMonitorsV2: z.boolean().optional(),
});
const councilShape = z.object({
  chosen: z.string().optional(),
  changed: z.boolean().optional(),
  reason: z.string().optional(),
  elapsedMs: z.number().optional(),
  members: z.array(z.object({
    model: z.string().optional(),
    label: z.string().optional(),
    round: z.string(),
    outcome: z.string().optional(),
    output: z.string().optional(),
    note: z.string().optional(),
    agreements: z.number().optional(),
  })),
});
const messageShape = itemShape.extend({
  role: z.string(),
  text: z.string(),
  createdAt: z.string().optional(),
  images: z.array(itemShape.extend({ width: z.number(), height: z.number() })).optional(),
  experiment: z.string().optional(),
  council: councilShape.optional(),
});
const questionShape = itemShape.extend({
  options: z.array(itemShape.extend({ label: z.string() })),
  fields: z.array(itemShape.extend({
    prompt: z.string(),
    suggestions: z.array(z.object({ label: z.string(), reason: z.string().optional() })),
    initialValue: z.string().optional(),
    selected: z.array(z.number()).optional(),
    placeholder: z.string().optional(),
  })).optional(),
});
const objectShape = z.object({});
const conversationShape = summaryShape.extend({
  messages: z.array(messageShape),
  steps: z.array(itemShape.extend({ text: z.string() })).optional(),
  configured: z.boolean().optional(),
  capabilities: capabilitiesShape.optional(),
  progress: z.string().nullish(),
  error: z.string().nullish(),
  version: z.string().optional(),
  olderMessages: z.number().optional(),
  question: questionShape.nullish(),
  approval: itemShape.extend({ detail: z.string(), target: z.string().optional(), consequence: z.string().optional() }).nullish(),
  secure: itemShape.extend({
    kind: z.string(), site: z.string(), note: z.string().nullish(),
    fields: z.array(itemShape.extend({ label: z.string(), type: z.string() })),
  }).nullish(),
  browser: z.object({ url: z.string(), title: z.string(), screenUrl: z.string(), live: z.boolean() }).nullish(),
  visibility: z.object({ level: z.number(), canView: z.boolean(), reason: z.string() }).nullish(),
  campaign: z.object({ events: z.array(objectShape) }).nullish(),
  run: objectShape.nullish(),
  backgroundRun: z.object({ startedAt: z.string(), task: z.string(), step: z.string() }).optional(),
  monitorProposal: objectShape.optional(),
  monitors: z.array(objectShape).optional(),
  monitorAlerts: z.array(itemShape).optional(),
});

export async function requestChatConversation(path: string, options?: RequestInit): Promise<ChatConversation> {
  const body = await requestChatJson<unknown>(path, options);
  if (!conversationShape.safeParse(body).success) throw new Error("تعذّر قراءة بيانات المحادثة. أعد المحاولة.");
  return body as ChatConversation;
}

const historyShape = z.object({
  conversations: z.array(summaryShape),
  configured: z.boolean().optional(),
  capabilities: capabilitiesShape.optional(),
  requestKeys: z.boolean().optional(),
  nextCursor: z.string().nullish(),
});

type ChatHistory = {
  conversations: ChatConversationSummary[];
  configured?: boolean;
  capabilities?: ChatCapabilities;
  requestKeys?: boolean;
  nextCursor?: string | null;
  [key: string]: unknown;
};

export async function requestChatHistory(signal?: AbortSignal): Promise<ChatHistory> {
  const body = await requestChatJson<unknown>("/api/chat/conversations", { signal });
  if (!historyShape.safeParse(body).success) throw new Error("تعذّر قراءة قائمة المحادثات.");
  return body as ChatHistory;
}
