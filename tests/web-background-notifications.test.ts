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
  it('claims background events and only publishes server-confirmed notices', async () => {
    const target = new EventTarget();
    const notices = vi.fn();
    const viewer = vi.fn();
    target.addEventListener(backgroundNoticeEvent, notices);
    target.addEventListener(backgroundViewerEvent, viewer);
    vi.stubGlobal('window', target);
    const abort = new AbortController();
    const claimed = { ...completed, title: 'Task complete', body: 'Your task is complete.' };
    const claim = vi.fn(async (id: string) => ({ notification: id === completed.taskId ? claimed : null }));

    announceBackgroundViewer('member');
    expect(viewer.mock.calls[0]?.[0].detail).toBe('member');
    await claimOpenBackgroundNotifications([
      { ...completed, taskId: 'legacy', runKind: undefined },
      { ...completed, taskId: 'claimed-elsewhere' },
      completed,
    ], 'member', abort.signal, claim);
    expect(claim.mock.calls).toEqual([['claimed-elsewhere'], [completed.taskId]]);
    expect(notices).toHaveBeenCalledOnce();
    expect(notices.mock.calls[0]?.[0].detail).toEqual({ viewerId: 'member', notification: claimed });
  });

  it('drops a claimed result after its page connection is closed', async () => {
    const target = new EventTarget();
    const notices = vi.fn();
    target.addEventListener(backgroundNoticeEvent, notices);
    vi.stubGlobal('window', target);
    const abort = new AbortController();
    await claimOpenBackgroundNotifications([completed], 'member', abort.signal, async () => {
      abort.abort();
      return { notification: completed };
    });
    expect(notices).not.toHaveBeenCalled();
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
