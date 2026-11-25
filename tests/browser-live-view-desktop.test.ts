import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import type { BrowserLiveCorner, BrowserLiveMode } from '@mohassan/contracts';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { BrowserLiveViewWindowState } from '../apps/desktop/src/browser-live-view-window.js';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, value?: unknown) => unknown>(),
  windows: [] as unknown[],
  display: vi.fn(),
  screenOn: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: MockWindow,
  ipcMain: { handle: (name: string, handler: (event: unknown, value: unknown) => unknown) => electron.handlers.set(name, handler) },
  screen: { on: electron.screenOn, getDisplayMatching: electron.display },
}));

class MockWindow extends EventEmitter {
  private visible = false;
  private destroyed = false;
  private bounds = { x: 0, y: 0, width: 340, height: 340 };
  readonly webContents = Object.assign(new EventEmitter(), {
    mainFrame: { url: 'about:blank' },
    getURL: () => this.webContents.mainFrame.url,
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
  });

  constructor(readonly options: unknown) { super(); electron.windows.push(this); }

  readonly loadURL = vi.fn(async (url: string) => { this.webContents.mainFrame.url = url; });
  readonly showInactive = vi.fn(() => { this.visible = true; });
  readonly hide = vi.fn(() => { this.visible = false; });
  readonly destroy = vi.fn(() => { this.destroyed = true; this.emit('closed'); });
  readonly setBounds = vi.fn((bounds: typeof this.bounds) => { this.bounds = bounds; });
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  getBounds() { return this.bounds; }
}

const { registerBrowserLiveViewWindow } = await import('../apps/desktop/src/browser-live-view-window.js');

const webUrl = 'http://127.0.0.1:3000';
const eventFor = (window: MockWindow) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
const send = (channel: string, event: unknown, body?: unknown) => electron.handlers.get(`browser-live-view:${channel}`)!(event, body);

function fixture() {
  const main = new MockWindow({});
  main.webContents.mainFrame.url = webUrl;
  let enabled = false;
  const onWindowClosed = vi.fn();
  const controller = registerBrowserLiveViewWindow({
    webUrl, preload: '/shell/preload.js', icon: vi.fn(),
    mainWindow: () => main as unknown as BrowserWindow,
    enabled: () => enabled, onWindowClosed,
  });
  return {
    main, onWindowClosed, controller,
    setEnabled(value: boolean) { enabled = value; controller.sync(); controller.notifyEnabledChanged(); },
    get mini() { return electron.windows[1] as MockWindow; },
  };
}

beforeEach(() => {
  electron.handlers.clear();
  electron.windows.length = 0;
  electron.display.mockReset().mockReturnValue({ workArea: { x: -1000, y: 50, width: 1000, height: 800 } });
  electron.screenOn.mockClear();
});

describe('desktop browser live view', () => {
  it('opens the sandboxed same-origin mini window only when enabled and informs the main view', () => {
    expectTypeOf<BrowserLiveViewWindowState>().toEqualTypeOf<{ corner: BrowserLiveCorner; mode: BrowserLiveMode }>();
    const view = fixture();
    view.controller.sync();
    expect(view.mini).toBeUndefined();
    expect(send('enabled', eventFor(view.main))).toBe(false);
    view.setEnabled(true);
    expect(send('enabled', eventFor(view.main))).toBe(true);
    expect(view.main.webContents.send).toHaveBeenLastCalledWith('browser-live-view:enabled-changed', true);
    expect(view.mini.options).toMatchObject({
      show: false, alwaysOnTop: true, skipTaskbar: true,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    });
    expect(view.mini.loadURL).toHaveBeenCalledWith(`${webUrl}/browser-live-view`);
    expect(view.mini.isVisible()).toBe(false);
    const preventDefault = vi.fn();
    view.mini.webContents.emit('will-navigate', { preventDefault }, 'https://example.com/browser-live-view');
    expect(preventDefault).toHaveBeenCalledOnce();
    view.setEnabled(false);
    expect(view.mini.destroy).toHaveBeenCalledOnce();
    expect(view.onWindowClosed).not.toHaveBeenCalled();
    expect(view.main.webContents.send).toHaveBeenLastCalledWith('browser-live-view:enabled-changed', false);
  });

  it.each([
    ['top-left', -988, 62], ['top-right', -352, 62],
    ['bottom-left', -988, 498], ['bottom-right', -352, 498],
  ])('snaps to the %s of a display work area with negative coordinates', (corner, x, y) => {
    const view = fixture();
    view.setEnabled(true);
    send('update', eventFor(view.mini), { corner, mode: 'small' });
    expect(electron.display).toHaveBeenCalledWith(view.main.getBounds());
    expect(view.mini.getBounds()).toEqual({ x, y, width: 340, height: 340 });
    expect(view.mini.showInactive).toHaveBeenCalledOnce();
  });

  it('keeps its selected corner when expanded, collapsed, hidden and shown again', () => {
    const view = fixture();
    view.setEnabled(true);
    const event = eventFor(view.mini);
    send('update', event, { corner: 'bottom-right', mode: 'medium' });
    expect(view.mini.getBounds()).toEqual({ x: -572, y: 338, width: 560, height: 500 });
    send('update', event, { corner: 'bottom-right', mode: 'pill' });
    expect(view.mini.getBounds()).toEqual({ x: -332, y: 774, width: 320, height: 64 });
    send('update', event, { corner: 'bottom-right', mode: 'closed' });
    expect(view.mini.isVisible()).toBe(false);
    expect(view.mini.destroy).not.toHaveBeenCalled();
    expect(send('corner-at', event, { x: -650, y: 490 })).toBe('bottom-left');
    expect(send('corner-at', event, { x: -150, y: 349 })).toBe('top-right');
    send('update', event, { corner: 'bottom-right', mode: 'medium' });
    expect(view.mini.showInactive).toHaveBeenCalledTimes(2);
    view.mini.destroy();
    expect(view.onWindowClosed).toHaveBeenCalledOnce();
  });

  it('rejects bounds requests from other renderers, subframes, other origins and invalid payloads', () => {
    const view = fixture();
    view.setEnabled(true);
    const event = eventFor(view.mini);
    const state = { corner: 'bottom-left', mode: 'small' };
    send('update', eventFor(view.main), state);
    send('update', { ...event, senderFrame: { url: event.senderFrame.url } }, state);
    send('update', event, { ...state, corner: 'center' });
    send('update', event, { ...state, mode: 'constructor' });
    expect(send('corner-at', event, { x: Infinity, y: 1 })).toBeNull();
    view.mini.webContents.mainFrame.url = `${webUrl}/`;
    send('update', event, state);
    view.mini.webContents.mainFrame.url = 'https://example.com/browser-live-view';
    send('update', event, state);
    expect(send('corner-at', event, { x: 0, y: 0 })).toBeNull();
    expect(view.mini.setBounds).not.toHaveBeenCalled();
  });

  it('repositions and fits the active view after a display work area changes', () => {
    const view = fixture();
    view.setEnabled(true);
    send('update', eventFor(view.mini), { corner: 'bottom-right', mode: 'medium' });
    electron.display.mockReturnValue({ workArea: { x: 30, y: 40, width: 400, height: 300 } });
    const onDisplayChange = electron.screenOn.mock.calls.find(([event]) => event === 'display-metrics-changed')?.[1];
    onDisplayChange();
    expect(view.mini.getBounds()).toEqual({ x: 42, y: 52, width: 376, height: 276 });
    expect(view.mini.showInactive).toHaveBeenCalledOnce();
  });
});
