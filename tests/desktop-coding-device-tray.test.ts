import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readCodingDeviceState } from '../apps/desktop/src/coding-device.js';

interface MenuEntry {
  label?: string;
  enabled?: boolean;
  click?: () => void;
}

const mocked = vi.hoisted(() => ({
  appDir: '',
  menu: [] as MenuEntry[],
  windows: [] as Array<{
    url: string;
    options: Record<string, unknown>;
    webContents: { mainFrame: { url: string } };
  }>,
  beforeQuit: () => {},
  showOpenDialog: vi.fn(),
  showMessageBoxSync: vi.fn(),
  handle: vi.fn<(channel: string, handler: (event: unknown, code: string) => Promise<unknown>) => void>(),
  encryptString: vi.fn(),
  decryptString: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mocked.spawn }));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const { pathToFileURL } = await import('node:url');
  class BrowserWindow extends EventEmitter {
    readonly webContents = Object.assign(new EventEmitter(), { mainFrame: { url: '' }, setWindowOpenHandler: vi.fn() });
    url = '';
    constructor(readonly options: Record<string, unknown>) {
      super();
      mocked.windows.push(this);
    }
    setMenu() {}
    show() {}
    focus() {}
    loadURL(url: string) {
      this.url = url;
      this.webContents.mainFrame.url = url;
      return Promise.resolve();
    }
    loadFile(path: string) { return this.loadURL(pathToFileURL(path).href); }
  }
  class Tray {
    setToolTip() {}
    setContextMenu(entries: MenuEntry[]) { mocked.menu = entries; }
    on() {}
  }
  const app = Object.assign(new EventEmitter(), {
    setName: vi.fn(), setAppUserModelId: vi.fn(), getPath: () => mocked.appDir,
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    setAccessibilitySupportEnabled: vi.fn(), getLoginItemSettings: () => ({ openAtLogin: false }),
  });
  mocked.beforeQuit = () => app.emit('before-quit');
  return {
    app, BrowserWindow, Tray,
    Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: (entries: MenuEntry[]) => entries },
    nativeImage: { createFromPath: vi.fn() },
    ipcMain: { handle: mocked.handle },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: mocked.encryptString, decryptString: mocked.decryptString },
    globalShortcut: { register: vi.fn(), unregisterAll: vi.fn() },
    dialog: { showOpenDialog: mocked.showOpenDialog, showMessageBoxSync: mocked.showMessageBoxSync },
    Notification: { isSupported: () => false },
    shell: {},
  };
});

it('uses the production tray to select folders, pair from the isolated local window, launch the worker, and unlink', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
  let input = '';
  child.stdin.on('data', chunk => { input += String(chunk); });
  mocked.spawn.mockReturnValue(child);
  const credentials = { deviceId: randomUUID(), deviceKey: randomBytes(32).toString('base64url'), pollIntervalMs: 1000 };
  const code = randomBytes(12).toString('base64url'), ciphertext = randomBytes(64);
  const allowedRoots = ['C:\\Projects', 'D:\\Sources'];
  mocked.encryptString.mockReturnValue(ciphertext);
  mocked.decryptString.mockReturnValue(credentials.deviceKey);
  mocked.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: allowedRoots });
  const server = createServer((_request, response) => response.end(JSON.stringify(credentials)));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  mocked.appDir = await mkdtemp(join(tmpdir(), 'coding-device-tray-'));
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP test port');
    const webUrl = 'https://web.example', serverUrl = `http://127.0.0.1:${address.port}`;
    const codingDeviceRepoRoot = join(mocked.appDir, 'released checkout');
    const statePath = join(mocked.appDir, 'coding-device.json');
    await writeFile(join(mocked.appDir, 'config.json'), JSON.stringify({ mode: 'production', webUrl, serverUrl, codingDeviceRepoRoot, autostartStack: true }));
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
    await import('../apps/desktop/src/main.js');
    await vi.waitFor(() => expect(mocked.windows).toHaveLength(1));
    expect(mocked.windows[0]!.url).toBe(webUrl);
    expect(mocked.spawn).not.toHaveBeenCalled();
    const menu = (label: string) => mocked.menu.find(entry => entry.label === label);
    expect(menu('محرك البرمجة: غير مربوط')).toMatchObject({ enabled: false });
    expect(menu('إلغاء ربط محرك البرمجة')).toMatchObject({ enabled: false });
    menu('مجلدات المشاريع المسموحة…')?.click?.();
    expect(mocked.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ properties: ['openDirectory', 'multiSelections'] }));
    await vi.waitFor(() => expect(readCodingDeviceState(statePath)).toEqual({ allowedRoots }));
    menu('ربط محرك البرمجة بهذا الجهاز…')?.click?.();
    const pair = mocked.windows[1]!;
    expect(pair.url).toMatch(/^file:.*coding-device-pair\.html$/);
    expect(pair.options).toMatchObject({
      webPreferences: { preload: expect.stringMatching(/coding-device-preload\.js$/), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    expect(mocked.handle).toHaveBeenCalledWith('coding-device:pair', expect.any(Function));
    const pairRequest = mocked.handle.mock.lastCall![1];
    const main = mocked.windows[0]!.webContents;
    expect(await pairRequest({ sender: main, senderFrame: main.mainFrame }, code)).toMatchObject({ ok: false });
    expect(await pairRequest({ sender: pair.webContents, senderFrame: { url: pair.url } }, code)).toMatchObject({ ok: false });
    expect(await pairRequest({ sender: pair.webContents, senderFrame: pair.webContents.mainFrame }, code)).toMatchObject({ ok: true });
    expect(mocked.encryptString).toHaveBeenCalledWith(credentials.deviceKey);
    expect(mocked.decryptString).toHaveBeenCalledWith(ciphertext);
    expect(readCodingDeviceState(statePath)).toEqual({
      allowedRoots,
      pairing: { deviceId: credentials.deviceId, pollIntervalMs: credentials.pollIntervalMs, encryptedKey: ciphertext.toString('base64'), serverUrl },
    });
    expect(mocked.spawn).toHaveBeenCalledExactlyOnceWith('node', ['--import', 'tsx', 'scripts/coding-device.ts'], {
      cwd: codingDeviceRepoRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    expect(JSON.parse(input)).toEqual({ ...credentials, allowedRoots, serverUrl });
    expect(menu('محرك البرمجة: غير متصل')).toBeDefined();
    child.stdout.write('{"online":true}\n');
    expect(menu('محرك البرمجة: متصل')).toBeDefined();
    menu('إلغاء ربط محرك البرمجة')?.click?.();
    expect(readCodingDeviceState(statePath)).toEqual({ allowedRoots });
    expect(child.stdin.writableEnded).toBe(true);
    child.stdout.end();
    child.emit('close');
    expect(menu('محرك البرمجة: غير مربوط')).toBeDefined();
    expect(mocked.showMessageBoxSync).not.toHaveBeenCalled();
  } finally {
    mocked.beforeQuit();
    child.stdout.end();
    child.emit('close');
    Object.defineProperty(process, 'platform', originalPlatform);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(mocked.appDir, { recursive: true, force: true });
  }
});
