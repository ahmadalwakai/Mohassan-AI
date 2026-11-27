import { app, BrowserWindow, Menu, Notification, Tray, dialog, globalShortcut, nativeImage, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureConfigFile, loadConfig } from './config';

/**
 * تطبيق موحسن لسطح المكتب. يشغّل خدمة موحسن وواجهتها من مجلد المشروع على هذا الجهاز،
 * ويعرضها في نافذة واحدة مع أيقونة في شريط المهام. لا يحمل أي نموذج ولا يتصل بأي منصة
 * ذكاء اصطناعي خارجية: كل ما يفعله هو تشغيل ما على الجهاز وإظهاره.
 */
const APP_ID = 'ai.mohassan.desktop';
app.setName('Mohassan');
app.setAppUserModelId(APP_ID);

const userDir = app.getPath('userData');
const logDir = join(userDir, 'logs');
const configPath = join(userDir, 'config.json');
const assets = join(__dirname, '..', 'assets');
const config = loadConfig(configPath, process.argv.slice(1), process.env.MOHASSAN_REPO);
const logFile = join(logDir, `stack-${new Date().toISOString().slice(0, 10)}.log`);
function log(line: string) {
  try { mkdirSync(logDir, { recursive: true }); appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`); } catch { /* best effort */ }
}

let mainWindow: BrowserWindow | null = null;
let splash: BrowserWindow | null = null;
let tray: Tray | null = null;
let stack: { child: ChildProcess; stopping: boolean } | null = null;
let bootController: AbortController | undefined;
let restarting = false;
let quitting = false;

const icon = () => nativeImage.createFromPath(join(assets, 'icon.png'));
const trayIcon = () => nativeImage.createFromPath(join(assets, 'tray.png'));

async function reachable(url: string, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), redirect: 'manual' });
    return response.status > 0 && response.status < 500;
  } catch { return false; }
}

/** A stack already running answers on its API at once, even while the web dev server is compiling a page. */
async function stackAlreadyRunning(signal: AbortSignal): Promise<boolean> {
  for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
    if (await reachable(`${config.serverUrl}/health`, 2500, signal) && await reachable(config.webUrl, 8000, signal)) return true;
    if (!await reachable(`${config.serverUrl}/health`, 2500, signal)) return false;
  }
  return false;
}

function setSplash(text: string, detail = '', failed = false) {
  if (!splash || splash.isDestroyed()) return;
  void splash.webContents.executeJavaScript(`window.setStatus(${JSON.stringify(text)}, ${JSON.stringify(detail)}, ${failed})`).catch(() => undefined);
}

function createSplash(showOnError = false) {
  const window = new BrowserWindow({ width: 440, height: 320, frame: false, resizable: false, show: false, icon: icon(), backgroundColor: '#f7f8f5', webPreferences: { contextIsolation: true, sandbox: true } });
  splash = window;
  window.once('ready-to-show', () => { if (showOnError || !config.startHidden) window.show(); });
  window.on('closed', () => { if (splash === window) splash = null; });
  void window.loadFile(join(assets, 'loading.html'));
}

function showStackStartError(error: Error) {
  log(`could not start stack: ${error.message}`);
  bootController?.abort();
  if (!splash || splash.isDestroyed()) createSplash(true);
  else splash.show();

  // ENOENT can also mean a missing cwd: https://nodejs.org/docs/latest-v24.x/api/child_process.html#child_processspawncommand-args-options (retrieved 2026-11-27).
  // Required Node version: https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/package.json#L13-L15 (retrieved 2026-11-27).
  if ('code' in error && error.code === 'ENOENT') {
    setSplash('تعذّر العثور على Node.js أو مجلد مشروع موحسن.', 'ثبّت Node.js 24 وأضفه إلى PATH، وتأكد من وجود مجلد المشروع.', true);
  } else {
    setSplash('تعذّر تشغيل Node.js لبدء خدمة موحسن.', `تأكد من تثبيت Node.js 24 وإمكانية تشغيله من PATH. راجع السجل:\n${logFile}`, true);
  }
}

/** Starts `scripts/dev.mjs` from the repository with the system Node; the service and the web app follow. */
function startStack() {
  const script = join(config.repoRoot, 'scripts', 'dev.mjs');
  const modeArgs = config.mode === 'lab' ? ['--local-lab'] : config.mode === 'production' ? ['--production'] : [];
  log(`starting stack: node ${script} ${modeArgs.join(' ')} (cwd ${config.repoRoot})`);
  // The stack listens where this app expects it; a lab keeps its own folder so two labs never share one database.
  const web = new URL(config.webUrl), api = new URL(config.serverUrl);
  const env: NodeJS.ProcessEnv = { ...process.env, MOHASSAN_DESKTOP_SHELL: '1', FORCE_COLOR: '0', SERVER_PORT: api.port || '4000', PORT: web.port || '3000', WEB_ORIGIN: web.origin, ...(config.mode === 'lab' ? { MOHASSAN_LAB_DIR: config.labDir } : {}) };
  let child: ChildProcess;
  try {
    child = spawn('node', [script, ...modeArgs], { cwd: config.repoRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  } catch (error) {
    showStackStartError(error instanceof Error ? error : new Error(String(error)));
    return;
  }
  const current = { child, stopping: false };
  stack = current;
  child.stdout?.on('data', chunk => log(`[stack] ${String(chunk).trimEnd()}`));
  child.stderr?.on('data', chunk => log(`[stack!] ${String(chunk).trimEnd()}`));
  child.on('error', error => {
    if (child.pid || stack !== current) { log(`stack process error: ${error.message}`); return; }
    stack = null;
    if (!quitting && !current.stopping) showStackStartError(error);
  });
  child.on('exit', code => {
    log(`stack exited with ${code}`);
    if (stack !== current) return;
    stack = null;
    if (!quitting && !current.stopping) {
      const choice = dialog.showMessageBoxSync({ type: 'warning', title: 'موحسن', message: 'توقفت خدمة موحسن.', detail: `رمز الخروج ${code ?? '؟'}. راجع السجل:\n${logFile}`, buttons: ['أعد التشغيل', 'افتح السجل', 'إغلاق'], defaultId: 0, cancelId: 2, noLink: true });
      if (choice === 0) void boot();
      else if (choice === 1) void shell.openPath(logFile);
    }
  });
}

async function stopStack() {
  const current = stack;
  if (!current || current.stopping) return;
  current.stopping = true;
  const { child } = current;
  if (!child.pid) { stack = null; return; }

  log(`stopping stack pid ${child.pid}`);
  try {
    if (process.platform === 'win32') {
      const taskkill = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      const [code] = await once(taskkill, 'close');
      if (code !== 0 && stack === current) throw new Error(`taskkill exited with ${code}`);
    } else if (!child.kill('SIGTERM')) {
      throw new Error('could not send SIGTERM to the stack');
    }
    if (stack === current) await once(child, 'exit');
  } catch (error) {
    log(`could not stop stack: ${String(error)}`);
    current.stopping = false;
  }
}

async function restartStack() {
  if (restarting || quitting) return;
  restarting = true;
  bootController?.abort();
  await stopStack();
  restarting = false;
  if (!stack) void boot(true);
}

function createMainWindow(onReady?: () => void) {
  mainWindow = new BrowserWindow({
    width: 1320, height: 860, minWidth: 900, minHeight: 600, title: 'موحسن', icon: icon(), show: false, autoHideMenuBar: true, backgroundColor: '#f7f8f5',
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  Menu.setApplicationMenu(null);
  const localOrigins = new Set([new URL(config.webUrl).origin, new URL(config.serverUrl).origin]);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { if (localOrigins.has(new URL(url).origin)) return { action: 'allow' }; } catch { /* fall through */ }
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try { if (localOrigins.has(new URL(url).origin)) return; } catch { /* fall through */ }
    event.preventDefault();
    void shell.openExternal(url);
  });
  mainWindow.on('close', event => {
    if (quitting || !config.closeToTray) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.once('ready-to-show', () => {
    if (!config.startHidden) { mainWindow?.show(); mainWindow?.focus(); }
    onReady?.();
  });
  void mainWindow.loadURL(config.webUrl);
}

/**
 * Opens the page once the service answers. A new window closes the splash itself when it is ready to show; an existing one
 * (after «أعد التشغيل») only reloads, so it closes the splash here. Before 2026-11-22 the splash stayed on top saying «جاهز».
 */
function openMain(signal: AbortSignal) {
  const closeSplash = () => { if (!signal.aborted) splash?.close(); };
  if (!mainWindow) { createMainWindow(closeSplash); return; }
  const window = mainWindow;
  window.webContents.once('did-stop-loading', () => {
    closeSplash();
    if (!config.startHidden && !window.isDestroyed()) { window.show(); window.focus(); }
  });
  void window.loadURL(config.webUrl);
}

function showMain() {
  if (!mainWindow) { createMainWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}

function toggleMain() {
  if (mainWindow?.isVisible() && mainWindow.isFocused()) mainWindow.hide(); else showMain();
}

function openAtLogin(): boolean { return app.getLoginItemSettings().openAtLogin; }

async function openSettings() {
  try {
    ensureConfigFile(configPath, process.env.MOHASSAN_REPO);
    const error = await shell.openPath(configPath);
    if (error) log(`could not open settings: ${error}`);
  } catch (error) {
    log(`could not open settings: ${String(error)}`);
  }
}

/** A Desktop shortcut that launches this same app, packaged or from the repository. */
function createDesktopShortcut() {
  const target = process.execPath;
  const shortcutArgs = app.isPackaged ? '' : `"${join(config.repoRoot, 'apps', 'desktop')}"`;
  const link = join(homedir(), 'Desktop', 'Mohassan.lnk');
  const ok = shell.writeShortcutLink(link, 'create', { target, args: shortcutArgs, cwd: config.repoRoot, icon: join(assets, 'icon.ico'), iconIndex: 0, description: 'موحسن — مساعدك على هذا الجهاز' });
  new Notification({ title: 'موحسن', body: ok ? 'أُنشئ اختصار «Mohassan» على سطح المكتب.' : 'تعذر إنشاء الاختصار.' }).show();
}

function buildTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('موحسن');
  const refresh = () => tray?.setContextMenu(Menu.buildFromTemplate([
    { label: 'فتح موحسن', click: showMain },
    { label: 'مجلد المشاريع', click: () => { const folder = join(homedir(), 'Mohassan Projects'); mkdirSync(folder, { recursive: true }); void shell.openPath(folder); } },
    { label: 'لقطات الشاشة', click: () => { const folder = join(homedir(), 'Pictures', 'Mohassan Screenshots'); mkdirSync(folder, { recursive: true }); void shell.openPath(folder); } },
    { type: 'separator' },
    { label: 'إعادة تشغيل الخدمة', click: () => { void restartStack(); } },
    { label: 'التشغيل مع Windows', type: 'checkbox', checked: openAtLogin(), click: item => { app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }); refresh(); } },
    { label: 'اختصار على سطح المكتب', click: createDesktopShortcut },
    { label: 'فتح الإعدادات', click: () => { void openSettings(); } },
    { label: 'فتح سجل التشغيل', click: () => { void shell.openPath(logFile); } },
    { type: 'separator' },
    { label: `الوضع: ${config.mode === 'lab' ? 'مختبر محلي' : config.mode === 'production' ? 'إنتاج' : 'تطوير'} · ${config.webUrl}`, enabled: false },
    { label: 'خروج', click: () => { quitting = true; app.quit(); } },
  ]));
  refresh();
  tray.on('click', toggleMain);
  tray.on('double-click', showMain);
}

/** Opens the window as soon as the web app answers; starts the stack first when nothing answers. */
async function boot(restart = false): Promise<void> {
  if (quitting) return;
  bootController?.abort();
  bootController = new AbortController();
  const { signal } = bootController;
  if (!restart && (!splash || splash.isDestroyed())) createSplash();
  const started = Date.now();
  setSplash('يبحث عن خدمة موحسن…', config.webUrl);
  const alreadyRunning = await stackAlreadyRunning(signal);
  if (signal.aborted) return;
  if (alreadyRunning) {
    log(`web already running at ${config.webUrl}`);
    setSplash('موحسن يعمل بالفعل، يُفتح…');
    openMain(signal);
    return;
  }
  if (!config.autostartStack) {
    setSplash('خدمة موحسن لا تعمل.', `شغّلها من مجلد المشروع ثم أعد فتح التطبيق:\n${config.repoRoot}`, true);
    return;
  }
  if (!existsSync(join(config.repoRoot, 'scripts', 'dev.mjs'))) {
    setSplash('لم أجد مجلد مشروع موحسن.', `عدّل repoRoot في:\n${configPath}`, true);
    return;
  }
  setSplash('يبدأ خادم موحسن…', config.repoRoot);
  if (!stack) startStack();
  const deadline = Date.now() + 300_000;
  let serverReady = false;
  while (Date.now() < deadline && !signal.aborted) {
    if (!serverReady) {
      serverReady = await reachable(`${config.serverUrl}/health`, 800, signal);
      if (signal.aborted) return;
      if (serverReady) setSplash('الخادم جاهز، تبدأ الواجهة…', `${Math.round((Date.now() - started) / 1000)} ث`);
    }
    const webReady = await reachable(config.webUrl, 1200, signal);
    if (signal.aborted) return;
    if (webReady) {
      log(`stack ready in ${Date.now() - started} ms`);
      setSplash('جاهز.', `${Math.round((Date.now() - started) / 1000)} ث`);
      openMain(signal);
      if (Notification.isSupported()) new Notification({ title: 'موحسن', body: `جاهز للعمل بعد ${Math.round((Date.now() - started) / 1000)} ثانية.`, icon: icon() }).show();
      return;
    }
    if (!stack) { setSplash('توقفت الخدمة أثناء البدء.', `راجع السجل:\n${logFile}`, true); return; }
    setSplash(serverReady ? 'تبدأ الواجهة…' : 'يبدأ خادم موحسن…', `${Math.round((Date.now() - started) / 1000)} ث · ${logFile}`);
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  if (!signal.aborted) setSplash('لم تصبح الخدمة جاهزة خلال خمس دقائق.', `راجع السجل:\n${logFile}`, true);
}

const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else {
  app.on('second-instance', showMain);
  app.whenReady().then(() => {
    // Expose the page to UI Automation (screen readers, and Mohassan's own desktop engine when it drives this window).
    // Electron only accepts this call after `ready`; calling it earlier aborted the packaged app with exit code 1.
    app.setAccessibilitySupportEnabled(true);
    buildTray();
    globalShortcut.register('CommandOrControl+Shift+M', toggleMain);
    void boot();
    app.on('activate', showMain);
  });
  app.on('window-all-closed', () => { /* the tray keeps the app alive */ });
  app.on('before-quit', () => { quitting = true; bootController?.abort(); globalShortcut.unregisterAll(); void stopStack(); });
}
