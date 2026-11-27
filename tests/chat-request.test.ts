import { afterEach, expect, it, vi } from "vitest";
import { ChatHttpError, chatErrorMessage, OFFLINE_REQUEST_MESSAGE } from "../apps/web/components/chat-connection";
import {
  onSessionExpired, renewChatSession, requestChatConversation, requestChatHistory, requestChatJson, sessionFetch,
} from "../apps/web/components/chat-request";

afterEach(() => vi.unstubAllGlobals());

function mockChatReply(body: unknown) {
  const response = new Response();
  vi.spyOn(response, "json").mockResolvedValue(body);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

it("keeps a failed request's HTTP status and announces expiry once for concurrent 401s", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401 })));
  const expired = vi.fn();
  const unsubscribe = onSessionExpired(expired);
  try {
    const outcomes = await Promise.allSettled([requestChatJson("/api/access"), requestChatJson("/api/chat/conversations")]);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ status: "rejected", reason: { status: 401 } });
    }
    expect(expired).toHaveBeenCalledOnce();
  } finally {
    unsubscribe();
  }
});

it("ignores a late 401 from a prior session and a 401 from public credential validation", async () => {
  const forbidden = () => new Response(null, { status: 401 });
  let resolvePrevious!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { resolvePrevious = resolve; });
  const fetch = vi.fn().mockReturnValueOnce(pending).mockImplementation(async () => forbidden());
  vi.stubGlobal("fetch", fetch);
  const expired = vi.fn();
  const unsubscribe = onSessionExpired(expired);
  try {
    const previous = sessionFetch("/api/access");
    renewChatSession();
    resolvePrevious(forbidden());
    await previous;
    await expect(requestChatJson("/api/auth/sign-in/email", {}, fetch)).rejects.toBeInstanceOf(ChatHttpError);
    expect(expired).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
  }
});

it("localizes browser transport errors and propagates intentional aborts", async () => {
  const nativeError = new TypeError("Failed to fetch");
  const abort = new DOMException("Aborted", "AbortError");
  const fetch = vi.fn().mockRejectedValueOnce(nativeError).mockRejectedValueOnce(abort);
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("navigator", { onLine: true });
  await expect(sessionFetch("/api/access")).rejects.toThrow(chatErrorMessage(nativeError));
  vi.stubGlobal("navigator", { onLine: false });
  await expect(sessionFetch("/api/access")).rejects.toThrow(OFFLINE_REQUEST_MESSAGE);
  expect(fetch).toHaveBeenCalledOnce();
  vi.stubGlobal("navigator", { onLine: true });
  await expect(sessionFetch("/api/access")).rejects.toBe(abort);
});

it("loads a conversation with additive fields and new enum values", async () => {
  const body = {
    id: "conversation",
    status: "future-status",
    messages: [{ id: "message", role: "future-role", text: "رسالة" }],
    capabilities: { available: ["future-capability"] },
    serverRevision: "future-revision",
  };
  mockChatReply(body);

  await expect(requestChatConversation("/api/chat/conversations/conversation")).resolves.toBe(body);
});

it("uses the Arabic conversation error when messages is null", async () => {
  mockChatReply({ id: "conversation", status: "idle", messages: null });

  await expect(requestChatConversation("/api/chat/conversations/conversation"))
    .rejects.toThrow("تعذّر قراءة بيانات المحادثة. أعد المحاولة.");
});

it("preserves pagination and idempotency fields in the full history reply", async () => {
  // Wire fields from the existing list route and pagination PR (retrieved 2026-11-27).
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/command-chat.ts#L1146-L1152
  // https://github.com/ahmadalwakai/Mohassan-AI/pull/136/files
  const body = {
    conversations: [{ id: "conversation", status: "future-status", serverRevision: "future-revision" }],
    requestKeys: true,
    nextCursor: "cursor-from-server",
  };
  mockChatReply(body);

  await expect(requestChatHistory()).resolves.toBe(body);
});
