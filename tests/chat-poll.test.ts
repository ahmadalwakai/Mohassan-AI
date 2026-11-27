import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHttpError, POLL_INTERVAL_MS, pollBackoffMs } from "../apps/web/components/chat-connection";
import { startChatPoll } from "../apps/web/components/chat-poll";

const tab = new EventTarget();
const page = Object.assign(new EventTarget(), { hidden: false });
const network = { onLine: true };
const interval = POLL_INTERVAL_MS;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", tab);
  vi.stubGlobal("document", page);
  vi.stubGlobal("navigator", network);
  page.hidden = false;
  network.onLine = true;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chat polling", () => {
  it("aborts an active request offline and resumes once the browser is online", async () => {
    const run = vi.fn<(signal: AbortSignal) => Promise<void>>().mockImplementationOnce((signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    ).mockResolvedValue(undefined);
    const onError = vi.fn();
    const stop = startChatPoll({ interval, hiddenInterval: null, firstDelay: 0, run, onError });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(1);
      const [signal] = run.mock.calls[0]!;
      network.onLine = false;
      tab.dispatchEvent(new Event("offline"));
      await vi.advanceTimersByTimeAsync(interval * 10);
      expect(signal.aborted).toBe(true);
      expect(run).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();

      network.onLine = true;
      tab.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it("backs off 503 responses, resets after success, and stops on 401", async () => {
    const random = 0.5;
    vi.spyOn(Math, "random").mockReturnValue(random);
    const unavailable = new ChatHttpError(503);
    const run = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(unavailable)
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ChatHttpError(401));
    const onError = vi.fn();
    const stop = startChatPoll({ interval, hiddenInterval: null, firstDelay: 0, run, onError });
    try {
      await vi.advanceTimersByTimeAsync(0);
      for (const failures of [1, 2]) {
        await vi.advanceTimersByTimeAsync(pollBackoffMs(failures, random) - 1);
        expect(run).toHaveBeenCalledTimes(failures);
        await vi.advanceTimersByTimeAsync(1);
        expect(run).toHaveBeenCalledTimes(failures + 1);
      }
      await vi.advanceTimersByTimeAsync(interval);
      expect(run).toHaveBeenCalledTimes(4);
      expect(onError.mock.calls).toEqual([[unavailable], [unavailable]]);
      tab.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(interval * 10);
      expect(run).toHaveBeenCalledTimes(4);
    } finally {
      stop();
    }
  });
});
