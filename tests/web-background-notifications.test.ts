import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotificationPayload } from '@mohassan/contracts';
import {
  announceBackgroundViewer, backgroundNoticeEvent, backgroundViewerEvent, claimOpenBackgroundNotifications,
  listenForCompletionChime, shouldPlayCompletionSound,
} from '../apps/web/components/background-notification-client';
import { BackgroundNotificationPreferences } from '../apps/web/components/background-notification-preferences';
import { BackgroundRunCard } from '../apps/web/components/background-run-card';

const completed: NotificationPayload = {
  taskId: 'e3b87764-9c2c-4a0c-891d-749ba47f1df7',
  runId: 'c78a49ca-ef31-421d-b47e-f31d5a553f05',
  conversationId: '203c0660-d439-411c-8fe5-3d596586a4d0',
  kind: 'task_completed',
  runKind: 'run-completed',
};
const tabId = '81452432-a51b-421b-8c2b-d4631489eed9';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('background notification preferences', () => {
  it('enables sound and leaves lock-screen preview disabled by default', () => {
    const html = renderToStaticMarkup(createElement(BackgroundNotificationPreferences, {
      preferences: { quietHours: null, hideTitle: false },
      onChange: vi.fn(),
    }));
    expect(html.match(/<input[^>]+>/g)).toEqual(['<input type="checkbox" checked=""/>', '<input type="checkbox"/>']);
    expect(shouldPlayCompletionSound(completed)).toBe(true);
  });

  it('respects an explicit sound opt-out and only chimes for completion', () => {
    const html = renderToStaticMarkup(createElement(BackgroundNotificationPreferences, {
      preferences: { quietHours: null, hideTitle: false, completionSound: false, showResultPreview: true },
      onChange: vi.fn(),
    }));
    expect(html.match(/<input[^>]+>/g)).toEqual(['<input type="checkbox"/>', '<input type="checkbox" checked=""/>']);
    expect(shouldPlayCompletionSound({ ...completed, sound: false })).toBe(false);
    expect(shouldPlayCompletionSound({ ...completed, runKind: 'run-blocked' })).toBe(false);
    expect(shouldPlayCompletionSound({ ...completed, runKind: 'run-failed' })).toBe(false);
  });
});

describe('completion chime autoplay', () => {
  it('waits for a trusted gesture and skips playback when sound is disabled', async () => {
    const target = new EventTarget();
    const buffer = {};
    const bytes = new ArrayBuffer(44);
    const destination = {};
    const source = { buffer: null, connect: vi.fn(), start: vi.fn() };
    const resume = vi.fn();
    const decode = vi.fn(async () => buffer);
    const close = vi.fn(async () => {});
    const audio = vi.fn(class {
      state = 'suspended';
      destination = destination;
      async resume() { resume(); this.state = 'running'; }
      decodeAudioData = decode;
      close = close;
      createBufferSource() { return source; }
    });
    vi.stubGlobal('AudioContext', audio);
    const fetch = vi.fn(async () => new Response(bytes));
    vi.stubGlobal('fetch', fetch);
    const chime = listenForCompletionChime(target as Document);

    await chime.play(true);
    target.dispatchEvent(new Event('pointerup'));
    await chime.play(true);
    expect(audio).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    const trusted = new Event('pointerup');
    Object.defineProperty(trusted, 'isTrusted', { value: true });
    target.dispatchEvent(trusted);
    expect(resume).toHaveBeenCalledOnce();
    await chime.play(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(source.start).not.toHaveBeenCalled();

    await chime.play(true);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/mohassan-done.wav');
    expect(decode).toHaveBeenCalledExactlyOnceWith(bytes);
    expect(source.buffer).toBe(buffer);
    expect(source.connect).toHaveBeenCalledExactlyOnceWith(destination);
    expect(source.start).toHaveBeenCalledOnce();
    chime.dispose();
    expect(close).toHaveBeenCalledOnce();
    await chime.play(true);
    expect(source.start).toHaveBeenCalledOnce();
  });
});

describe('open page delivery', () => {
  const claimPath = `/api/notifications/events/${completed.taskId}/claim`;

  function setupTab(receipts = new Map<string, Response>()) {
    const target = new EventTarget();
    const origin = 'https://mohassan.example';
    const open = vi.fn(async () => ({
      match: async (key: string) => receipts.get(key),
      put: async (key: string, response: Response) => receipts.set(key, response),
      keys: async () => [...receipts.keys()],
      delete: async (key: string) => receipts.delete(key),
    }));
    vi.stubGlobal('window', Object.assign(target, { location: { origin }, caches: { open } }));
    return { target, open, receipts, receiptKey: `${origin}/api/notifications/events/${completed.taskId}` };
  }

  it('claims background events and only publishes server-confirmed notices', async () => {
    const { target, open, receipts, receiptKey } = setupTab();
    const notices = vi.fn((event: Event) => event.preventDefault());
    const viewer = vi.fn();
    target.addEventListener(backgroundNoticeEvent, notices);
    target.addEventListener(backgroundViewerEvent, viewer);
    const abort = new AbortController();
    const claimed = { ...completed, title: 'Task complete', body: 'Your task is complete.' };
    const request = vi.fn(async (path: string, init: RequestInit) => ({
      notification: path === claimPath && !init.keepalive ? claimed : null,
    }));

    announceBackgroundViewer('member');
    expect(viewer.mock.calls[0]?.[0].detail).toBe('member');
    await claimOpenBackgroundNotifications([
      { ...completed, taskId: 'legacy', runKind: undefined },
      { ...completed, taskId: 'claimed-elsewhere' },
      completed,
    ], { viewerId: 'member', tabId, signal: abort.signal, request });
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/api/notifications/events/claimed-elsewhere/claim', claimPath, claimPath]);
    expect(request).toHaveBeenLastCalledWith(claimPath, { method: 'POST', body: JSON.stringify({ tabId, acknowledge: true }), keepalive: true });
    expect(notices).toHaveBeenCalledOnce();
    expect((notices.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ viewerId: 'member', notification: claimed });
    expect(open).toHaveBeenCalledWith('mohassan-background-push-v1');
    expect(await receipts.get(receiptKey)?.text()).toBe('');
  });

  it('leaves an abandoned claim unacknowledged when its page connection closes', async () => {
    const { target, receipts } = setupTab();
    const notices = vi.fn();
    target.addEventListener(backgroundNoticeEvent, notices);
    const abort = new AbortController();
    const request = vi.fn(async () => {
      abort.abort();
      return { notification: completed };
    });
    await claimOpenBackgroundNotifications([completed], { viewerId: 'member', tabId, signal: abort.signal, request });
    expect(notices).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
    expect(receipts.size).toBe(0);
  });

  it('retries an acknowledgement after a missed response without displaying the result again', async () => {
    const first = setupTab();
    const notices = vi.fn((event: Event) => event.preventDefault());
    first.target.addEventListener(backgroundNoticeEvent, notices);
    const request = vi.fn()
      .mockResolvedValueOnce({ notification: completed })
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValueOnce({ notification: completed })
      .mockResolvedValueOnce({ notification: null });
    const claim = { viewerId: 'member', tabId, signal: new AbortController().signal, request };
    await claimOpenBackgroundNotifications([completed], claim);
    expect(notices).toHaveBeenCalledOnce();

    const reopened = setupTab(first.receipts);
    const duplicate = vi.fn();
    reopened.target.addEventListener(backgroundNoticeEvent, duplicate);
    await claimOpenBackgroundNotifications([completed], claim);
    expect(duplicate).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(4);
    expect(request).toHaveBeenLastCalledWith(claimPath, { method: 'POST', body: JSON.stringify({ tabId, acknowledge: true }), keepalive: true });
  });

  it('renders the background task, current step, elapsed time, and stop control', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-25T12:01:02.000Z'));
    const html = renderToStaticMarkup(createElement(BackgroundRunCard, {
      run: {
        id: completed.runId!, language: 'en', startedAt: '2026-11-25T12:00:00.000Z',
        task: 'Follow the status page', step: 'Waiting for the next check',
      },
      busy: false,
      onStop: vi.fn(),
    }));
    expect(html).toContain('Follow the status page');
    expect(html).toContain('Waiting for the next check');
    expect(html).toContain('Elapsed time 01:02');
    expect(html).toContain('Stop task');
  });
});
