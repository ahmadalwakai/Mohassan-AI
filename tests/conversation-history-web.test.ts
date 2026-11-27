import { randomUUID } from "node:crypto";
import type { ChatConversationList } from "@mohassan/contracts";
import { describe, expect, it } from "vitest";
import { refreshHistoryHead } from "../apps/web/components/conversation-history";

function summary(order: number): ChatConversationList["conversations"][number] {
  return { id: randomUUID(), title: `Conversation ${order}`, status: "idle", updatedAt: new Date(order).toISOString() };
}

function page(conversations: ChatConversationList["conversations"], nextCursor: string | null): ChatConversationList {
  return { conversations, nextCursor, configured: false, capabilities: { available: [], chatModel: false }, requestKeys: true };
}

describe("conversation history refreshes", () => {
  it("keeps the loaded tail and continues from its cursor after a new conversation", () => {
    const [newest, previousNewest, previousBoundary, older] = [4, 3, 2, 1].map(summary);
    const cursor = older.id;
    const loaded = { ...page([previousNewest, previousBoundary, older], cursor), expanded: true };
    const first = page([newest, previousNewest], previousNewest.id);

    expect(refreshHistoryHead(loaded, first)).toEqual({
      ...first, conversations: [newest, previousNewest, previousBoundary, older], nextCursor: cursor, expanded: true,
    });
  });

  it("replaces the continuation if the new first page has moved beyond everything loaded", () => {
    const [newest, boundary, previousNewest, older] = [4, 3, 2, 1].map(summary);
    const loaded = { ...page([previousNewest, older], null), expanded: true };
    const first = page([newest, boundary], boundary.id);

    expect(refreshHistoryHead(loaded, first)).toBe(first);
  });
});
