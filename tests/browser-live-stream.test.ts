import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserLiveBudget, browserLiveFrameHeader } from '@mohassan/contracts';
import { createBrowserLiveStream, type DisplayedBrowserFrame } from '../apps/web/components/browser-live-stream';

class Visibility extends EventTarget {
  hidden = false;

  setHidden(hidden: boolean) {
    this.hidden = hidden;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

const endpoint = '/api/chat/conversations/example/browser/live/run';
const interval = browserLiveBudget.intervalMs;
const frameId = crypto.randomUUID();

// These fixtures test the byte envelope, so the body is sized directly from the shared frame budget.
function jpeg(size = browserLiveBudget.maxFrameBytes, id: string | null = frameId) {
  return new Response(new Uint8Array(size), { headers: { 'Content-Type': 'image/jpeg', ...(id !== null ? { [browserLiveFrameHeader]: id } : {}) } });
}

function stream(fetcher: typeof fetch, documentState = new Visibility()) {
  const onFrame = vi.fn<(frame: DisplayedBrowserFrame | null) => void>();
  const onUnavailable = vi.fn<() => void>();
  return { ...createBrowserLiveStream({ endpoint, onFrame, onUnavailable, documentState, fetcher }), onFrame, onUnavailable, documentState };
}

describe('browser live frame polling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('does not fetch while collapsed or in a hidden tab, and resumes when shown', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jpeg());
    const live = stream(fetcher);
    await vi.advanceTimersByTimeAsync(interval * 2);
    expect(fetcher).not.toHaveBeenCalled();

    live.setShown(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${endpoint}/frame`);
    expect(live.onFrame).toHaveBeenCalledWith({ id: frameId, url: expect.stringMatching(/^blob:/) });
    await vi.advanceTimersByTimeAsync(interval - 1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);

    live.setShown(false);
    expect(live.onFrame).toHaveBeenLastCalledWith(null);
    await vi.advanceTimersByTimeAsync(interval * 2);
    expect(fetcher).toHaveBeenCalledTimes(2);

    live.documentState.setHidden(true);
    live.setShown(true);
    await vi.advanceTimersByTimeAsync(interval * 2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    live.documentState.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(3);
    live.close();
  });

  it('aborts an in-flight frame on hide and ignores its late response', async () => {
    let resolveFrame!: (response: Response) => void;
    const held = new Promise<Response>(resolve => { resolveFrame = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => held).mockImplementation(async () => jpeg());
    const live = stream(fetcher);
    live.setShown(true);
    await vi.advanceTimersByTimeAsync(0);
    const signal = fetcher.mock.calls[0]?.[1]?.signal;

    live.documentState.setHidden(true);
    expect(signal?.aborted).toBe(true);
    resolveFrame(jpeg());
    await vi.advanceTimersByTimeAsync(interval * 2);
    expect(live.onFrame).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);

    live.documentState.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(live.onFrame).toHaveBeenCalledTimes(1);
    live.close();
  });

  it('rejects oversized bodies and stops on a stale run response', async () => {
    const objectUrl = vi.spyOn(URL, 'createObjectURL');
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => jpeg(browserLiveBudget.maxFrameBytes + 1))
      .mockImplementationOnce(async () => new Response(null, { status: 404 }));
    const live = stream(fetcher);
    live.setShown(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(live.onFrame).toHaveBeenLastCalledWith(null);
    expect(objectUrl).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(interval * 2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(live.onUnavailable).toHaveBeenCalledOnce();
    live.close();
  });

  it('requires a valid frame ID and clears it before polling after manual input', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => jpeg(undefined, null))
      .mockImplementationOnce(async () => jpeg(undefined, 'invalid'))
      .mockImplementation(async () => jpeg());
    const live = stream(fetcher);
    live.setShown(true);
    await vi.advanceTimersByTimeAsync(interval);
    expect(live.onFrame.mock.calls).toEqual([[null], [null]]);

    await vi.advanceTimersByTimeAsync(interval);
    expect(live.onFrame).toHaveBeenLastCalledWith({ id: frameId, url: expect.stringMatching(/^blob:/) });
    live.invalidateFrame();
    expect(live.onFrame).toHaveBeenLastCalledWith(null);
    expect(fetcher).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(interval);
    expect(live.onFrame).toHaveBeenLastCalledWith({ id: frameId, url: expect.stringMatching(/^blob:/) });
    live.close();
  });
});
