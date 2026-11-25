import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent, type NativeImage, type Rectangle } from 'electron';

const MINI_PATH = '/browser-live-view';
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
const SIZES = {
  small: { width: 340, height: 340 },
  medium: { width: 560, height: 500 },
  pill: { width: 320, height: 64 },
} as const;
const EXPANDED_SIZE = { width: 1120, height: 860 };

export interface BrowserLiveViewWindowState {
  corner: typeof CORNERS[number];
  mode: keyof typeof SIZES | 'closed';
  expanded?: boolean;
}

function parseState(value: unknown): BrowserLiveViewWindowState | null {
  if (typeof value !== 'object' || value === null) return null;
  const { corner, mode, expanded } = value as Partial<BrowserLiveViewWindowState>;
  if (!corner || !CORNERS.includes(corner)) return null;
  if (mode !== 'closed' && (typeof mode !== 'string' || !Object.hasOwn(SIZES, mode))) return null;
  if (expanded !== undefined && typeof expanded !== 'boolean') return null;
  return { corner, mode, expanded: expanded === true && (mode === 'small' || mode === 'medium') };
}

function viewBounds(area: Rectangle, state: BrowserLiveViewWindowState & { mode: keyof typeof SIZES }): Rectangle {
  const insetX = Math.min(12, Math.floor((area.width - 1) / 2));
  const insetY = Math.min(12, Math.floor((area.height - 1) / 2));
  const size = state.expanded ? EXPANDED_SIZE : SIZES[state.mode];
  const width = Math.min(size.width, area.width - insetX * 2);
  const height = Math.min(size.height, area.height - insetY * 2);
  if (state.expanded) return {
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.floor((area.height - height) / 2),
    width,
    height,
  };
  return {
    x: state.corner.endsWith('right') ? area.x + area.width - width - insetX : area.x + insetX,
    y: state.corner.startsWith('bottom') ? area.y + area.height - height - insetY : area.y + insetY,
    width,
    height,
  };
}

interface Options {
  webUrl: string;
  preload: string;
  icon: () => NativeImage;
  mainWindow: () => BrowserWindow | null;
  enabled: () => boolean;
  onWindowClosed: () => void;
}

export function registerBrowserLiveViewWindow(options: Options) {
  const url = new URL(MINI_PATH, options.webUrl);
  let miniWindow: BrowserWindow | null = null;
  let state: BrowserLiveViewWindowState | null = null;

  const isLocalPage = (target: string, miniOnly: boolean) => {
    try {
      const page = new URL(target);
      return page.origin === url.origin && (!miniOnly || page.pathname === MINI_PATH);
    } catch { return false; }
  };

  function trustedSender(event: IpcMainInvokeEvent, window: BrowserWindow | null, miniOnly: boolean): boolean {
    if (!window || window.isDestroyed() || event.sender !== window.webContents) return false;
    const frame = event.senderFrame;
    return Boolean(frame && frame === window.webContents.mainFrame && isLocalPage(frame.url, miniOnly));
  }

  function workArea(window: BrowserWindow): Rectangle {
    return screen.getDisplayMatching((options.mainWindow() ?? window).getBounds()).workArea;
  }

  function reposition() {
    if (!miniWindow || !state || state.mode === 'closed') return;
    miniWindow.setBounds(viewBounds(workArea(miniWindow), { ...state, mode: state.mode }));
    if (!miniWindow.isVisible()) miniWindow.showInactive();
  }

  ipcMain.handle('browser-live-view:update', (event, value: unknown) => {
    if (!miniWindow || !trustedSender(event, miniWindow, true)) return;
    const next = parseState(value);
    if (!next) return;
    state = next;
    if (next.mode === 'closed') miniWindow.hide();
    else reposition();
  });
  ipcMain.handle('browser-live-view:enabled', event => (
    trustedSender(event, options.mainWindow(), false) || trustedSender(event, miniWindow, true)
  ) && options.enabled());
  ipcMain.handle('browser-live-view:corner-at', (event, value: unknown): BrowserLiveViewWindowState['corner'] | null => {
    if (!miniWindow || !trustedSender(event, miniWindow, true) || typeof value !== 'object' || value === null) return null;
    const { x, y } = value as { x?: number; y?: number };
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const area = workArea(miniWindow);
    return `${y < area.y + area.height / 2 ? 'top' : 'bottom'}-${x < area.x + area.width / 2 ? 'left' : 'right'}`;
  });

  screen.on('display-metrics-changed', reposition);
  screen.on('display-removed', reposition);

  function sync() {
    if (!options.enabled()) {
      const previous = miniWindow;
      miniWindow = null;
      state = null;
      previous?.destroy();
      return;
    }
    if (miniWindow || !options.mainWindow()) return;
    const window = new BrowserWindow({
      title: 'متصفح موحسن', icon: options.icon(), ...SIZES.small, show: false,
      frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false,
      fullscreenable: false, maximizable: false, minimizable: false, backgroundColor: '#f7f8f5',
      webPreferences: {
        preload: options.preload, contextIsolation: true, sandbox: true, nodeIntegration: false,
        // Keep polling for attention while hidden; the renderer stops fetching JPEGs in closed mode.
        backgroundThrottling: false,
      },
    });
    miniWindow = window;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, target) => { if (!isLocalPage(target, true)) event.preventDefault(); });
    window.webContents.on('will-redirect', (event, target) => { if (!isLocalPage(target, true)) event.preventDefault(); });
    window.webContents.on('render-process-gone', () => { if (!window.isDestroyed()) window.destroy(); });
    window.on('closed', () => {
      if (miniWindow !== window) return;
      miniWindow = null;
      state = null;
      options.onWindowClosed();
    });
    void window.loadURL(url.href).catch(() => { if (!window.isDestroyed()) window.destroy(); });
  }

  function notifyEnabledChanged() {
    const window = options.mainWindow();
    if (window && !window.isDestroyed() && isLocalPage(window.webContents.getURL(), false)) {
      window.webContents.send('browser-live-view:enabled-changed', options.enabled());
    }
  }

  return { sync, reposition, notifyEnabledChanged };
}
