import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readCodingDeviceState } from '../apps/desktop/src/coding-device.js';

interface MenuEntry {
  label?: string;
  enabled?: boolean;
  click?: () => void;
  submenu?: MenuEntry[];
}

const mocked = vi.hoisted(() => ({
  appDir: '',
  menu: [] as MenuEntry[],
  windows: [] as Array<{
    url: string;
    options: Record<string, unknown>;
    webContents: { mainFrame: { url: string } };
  }>,
  beforeQuit: (_event: { preventDefault: () => void }) => {},
  quit: vi.fn(),
  showOpenDialog: vi.fn(),
  showMessageBox: vi.fn(),
  showMessageBoxSync: vi.fn(),
  handle: vi.fn<(channel: string, handler: (event: unknown, code: string) => Promise<unknown>) => void>(),
  encryptString: vi.fn(),
  decryptString: vi.fn(),
  spawn: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mocked.spawn }));
vi.mock('node:url', async importOriginal => {
  const url = await importOriginal<typeof import('node:url')>();
  return {
    ...url,
    pathToFileURL: (path: string) => path.endsWith('coding-device-pair.html')
      ? new URL('file:///C:/Program%20Files/Mohassan/coding-device-pair.html') : url.pathToFileURL(path),
  };
});

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
    quit: mocked.quit,
  });
  mocked.beforeQuit = event => app.emit('before-quit', event);
  class Notification {
    static isSupported() { return true; }
    constructor(private readonly options: { body: string }) {}
    show() { mocked.notify(this.options.body); }
  }
  return {
    app, BrowserWindow, Tray,
    Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: (entries: MenuEntry[]) => entries },
    nativeImage: { createFromPath: vi.fn() },
    ipcMain: { handle: mocked.handle },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: mocked.encryptString, decryptString: mocked.decryptString },
    globalShortcut: { register: vi.fn(), unregisterAll: vi.fn() },
    dialog: { showOpenDialog: mocked.showOpenDialog, showMessageBox: mocked.showMessageBox, showMessageBoxSync: mocked.showMessageBoxSync },
    Notification,
    shell: {},
  };
});

it('manages production folders, pairing, unlinking, and graceful shutdown from the tray', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const makeChild = (pid: number) => {
    const child = Object.assign(new EventEmitter(), {
      pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), input: '',
    });
    child.stdin.on('data', chunk => { child.input += String(chunk); });
    return child;
  };
  const children: ReturnType<typeof makeChild>[] = [];
  const makeTaskkill = () => Object.assign(new EventEmitter(), { kill: vi.fn() });
  const taskkills: ReturnType<typeof makeTaskkill>[] = [];
  mocked.spawn.mockImplementation((command: string) => {
    if (command === 'taskkill') {
      const tree = makeTaskkill();
      taskkills.push(tree);
      return tree;
    }
    const child = makeChild(4100 + children.length);
    children.push(child);
    return child;
  });
  const credentials = { deviceId: randomUUID(), deviceKey: randomBytes(32).toString('base64url'), pollIntervalMs: 1000 };
  const code = randomBytes(12).toString('base64url'), ciphertext = randomBytes(64);
  const allowedRoots = ['C:\\Projects', 'D:\\Sources'];
  mocked.encryptString.mockReturnValue(ciphertext);
  mocked.decryptString.mockReturnValue(credentials.deviceKey);
  const extraRoot = 'E:\\More';
  mocked.showOpenDialog
    .mockResolvedValueOnce({ canceled: false, filePaths: allowedRoots })
    .mockResolvedValueOnce({ canceled: false, filePaths: ['c:/projects/', extraRoot] })
    .mockResolvedValueOnce({ canceled: false, filePaths: Array.from({ length: 128 }, (_, index) => `F:\\Project-${index}`) });
  mocked.showMessageBox.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
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
    await mkdir(join(codingDeviceRepoRoot, 'scripts'), { recursive: true });
    await writeFile(join(codingDeviceRepoRoot, 'scripts', 'coding-device.ts'), '');
    await mkdir(join(codingDeviceRepoRoot, 'node_modules', '@mohassan', 'coding-link'), { recursive: true });
    await writeFile(join(mocked.appDir, 'config.json'), JSON.stringify({ mode: 'production', webUrl, serverUrl, codingDeviceRepoRoot, autostartStack: true }));
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
    await import('../apps/desktop/src/main.js');
    await vi.waitFor(() => expect(mocked.windows).toHaveLength(1));
    expect(mocked.windows[0]!.url).toBe(webUrl);
    expect(mocked.spawn).not.toHaveBeenCalled();
    const logs = join(mocked.appDir, 'logs');
    const logPath = join(logs, (await readdir(logs))[0]!);
    expect(await readFile(logPath, 'utf8')).toContain(`web already running at ${webUrl}`);
    const menu = (label: string) => mocked.menu.find(entry => entry.label === label);
    expect(menu('محرك البرمجة: غير مربوط')).toMatchObject({ enabled: false });
    expect(menu('إلغاء ربط محرك البرمجة')).toMatchObject({ enabled: false });
    menu('مجلدات المشاريع المسموحة…')?.click?.();
    expect(mocked.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ properties: ['openDirectory', 'multiSelections'] }));
    await vi.waitFor(() => expect(readCodingDeviceState(statePath)).toEqual({ allowedRoots }));
    menu('مجلدات المشاريع المسموحة…')?.click?.();
    await vi.waitFor(() => expect(readCodingDeviceState(statePath).allowedRoots).toEqual([...allowedRoots, extraRoot]));
    expect(menu(extraRoot)).toMatchObject({ enabled: false });
    expect(menu('إزالة مجلد…')?.submenu?.map(entry => entry.label)).toEqual([...allowedRoots, extraRoot]);
    menu('مجلدات المشاريع المسموحة…')?.click?.();
    await vi.waitFor(() => expect(mocked.notify).toHaveBeenCalledWith(expect.stringContaining('128')));
    expect(readCodingDeviceState(statePath).allowedRoots).toEqual([...allowedRoots, extraRoot]);
    const removeExtra = () => menu('إزالة مجلد…')?.submenu?.find(entry => entry.label === extraRoot)?.click?.();
    removeExtra();
    await Promise.resolve();
    expect(readCodingDeviceState(statePath).allowedRoots).toEqual([...allowedRoots, extraRoot]);
    expect(mocked.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ detail: extraRoot, cancelId: 1, defaultId: 1 }));
    removeExtra();
    await vi.waitFor(() => expect(readCodingDeviceState(statePath).allowedRoots).toEqual(allowedRoots));
    menu('ربط محرك البرمجة بهذا الجهاز…')?.click?.();
    const pair = mocked.windows[1]!;
    expect(pair.url).toMatch(/^file:.*coding-device-pair\.html$/);
    expect(pair.options).toMatchObject({
      webPreferences: { preload: expect.stringMatching(/coding-device-preload\.js$/), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    expect(mocked.handle).toHaveBeenCalledWith('coding-device:pair', expect.any(Function));
    const pairRequest = mocked.handle.mock.lastCall![1];
    const main = mocked.windows[0]!.webContents;
    const frame = pair.webContents.mainFrame;
    const submit = () => pairRequest({ sender: pair.webContents, senderFrame: frame }, code);
    expect(await pairRequest({ sender: main, senderFrame: main.mainFrame }, code)).toMatchObject({ ok: false });
    expect(await pairRequest({ sender: pair.webContents, senderFrame: { url: pair.url } }, code)).toMatchObject({ ok: false });
    frame.url = pair.url.replace('/C:/', '/c:/').replace('Mohassan', 'mohassan');
    expect(await submit()).toMatchObject({ ok: false });
    frame.url = pair.url.replace('/C:/', '/c:/');
    expect(await submit()).toMatchObject({ ok: true });
    expect(mocked.encryptString).toHaveBeenCalledWith(credentials.deviceKey);
    expect(mocked.decryptString).toHaveBeenCalledWith(ciphertext);
    expect(readCodingDeviceState(statePath)).toEqual({
      allowedRoots,
      pairing: { deviceId: credentials.deviceId, pollIntervalMs: credentials.pollIntervalMs, encryptedKey: ciphertext.toString('base64'), serverUrl },
    });
    expect(mocked.spawn).toHaveBeenCalledExactlyOnceWith('node', ['--import', 'tsx', 'scripts/coding-device.ts'], {
      cwd: codingDeviceRepoRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const first = children[0]!;
    expect(JSON.parse(first.input)).toEqual({ ...credentials, allowedRoots, serverUrl });
    expect(menu('محرك البرمجة: غير متصل')).toBeDefined();
    first.stdout.write('{"online":true}\n');
    expect(menu('محرك البرمجة: متصل')).toBeDefined();
    vi.useFakeTimers();
    menu('إلغاء ربط محرك البرمجة')?.click?.();
    expect(readCodingDeviceState(statePath)).toEqual({ allowedRoots });
    expect(first.stdin.writableEnded).toBe(true);
    expect(menu('محرك البرمجة: غير مربوط')).toBeDefined();
    expect(mocked.notify).toHaveBeenCalledWith(expect.stringContaining('«مشاريع البرمجة» على الويب'));
    await vi.advanceTimersByTimeAsync(70_000);
    expect(taskkills[0]?.kill).toHaveBeenCalledOnce();
    expect(first.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    vi.useRealTimers();
    const shutdownLog = await readFile(logPath, 'utf8');
    expect(shutdownLog).toContain('taskkill timed out');
    expect(shutdownLog).toContain('shutdown could not be confirmed');

    expect(await submit()).toMatchObject({ ok: true });
    expect(children).toHaveLength(1); // A replacement waits for the first process even after failed cleanup.
    first.emit('exit', null, 'SIGKILL');
    first.emit('close', null, 'SIGKILL');
    await Promise.resolve();
    const second = children[1]!;
    second.stdout.write('{"revoked":true}\n');
    expect(readCodingDeviceState(statePath)).toEqual({ allowedRoots });
    expect(mocked.notify).toHaveBeenCalledWith(expect.stringContaining('ألغى الخادم'));
    second.emit('close', 0, null);

    expect(await submit()).toMatchObject({ ok: true });
    const third = children[2]!;
    vi.useFakeTimers();
    const beforeQuit = { preventDefault: vi.fn() };
    mocked.beforeQuit(beforeQuit);
    mocked.beforeQuit(beforeQuit);
    expect(beforeQuit.preventDefault).toHaveBeenCalledTimes(2);
    expect(third.stdin.writableEnded).toBe(true);
    vi.advanceTimersByTime(59_999);
    expect(taskkills).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(mocked.spawn).toHaveBeenLastCalledWith('taskkill', ['/PID', String(third.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    third.emit('exit', null, 'SIGKILL');
    third.emit('close', null, 'SIGKILL');
    await Promise.resolve();
    expect(mocked.quit).not.toHaveBeenCalled();
    taskkills[1]!.emit('close', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocked.quit).toHaveBeenCalledOnce();
    expect(mocked.showMessageBoxSync).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    mocked.beforeQuit({ preventDefault: vi.fn() });
    for (const child of children) child.emit('close', 0, null);
    for (const tree of taskkills) tree.emit('close', 0);
    Object.defineProperty(process, 'platform', originalPlatform);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(mocked.appDir, { recursive: true, force: true });
  }
});
