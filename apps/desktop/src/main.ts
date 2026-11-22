import { app, BrowserWindow, Menu, Notification, Tray, dialog, globalShortcut, nativeImage, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * تطبيق موحسن لسطح المكتب. يشغّل خدمة موحسن وواجهتها من مجلد المشروع على هذا الجهاز،
 * ويعرضها في نافذة واحدة مع أيقونة في شريط المهام. لا يحمل أي نموذج ولا يتصل بأي منصة
 * ذكاء اصطناعي خارجية: كل ما يفعله هو تشغيل ما على الجهاز وإظهاره.
 */
interface Config {
  repoRoot: string;
  mode: 'dev' | 'lab' | 'production';
  webUrl: string;
  serverUrl: string;
  /** Lab mode only: the lab folder (database and profiles), relative to the repository. */
  labDir: string;
  autostartStack: boolean;
  closeToTray: boolean;
  startHidden: boolean;
}

const APP_ID = 'ai.mohassan.desktop';
app.setName('Mohassan');
app.setAppUserModelId(APP_ID);

const userDir = app.getPath('userData');
const logDir = join(userDir, 'logs');
const configPath = join(userDir, 'config.json');
const assets = join(__dirname, '..', 'assets');
const args = process.argv.slice(1);
const flag = (name: string) => args.includes(name);
const option = (name: string): string | undefined => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };

/** The repository: the folder this app runs from in development, or the saved path once packaged. */
function detectRepoRoot(): string {
  const candidates = [option('--repo'), process.env.MOHASSAN_REPO, resolve(__dirname, '..', '..', '..'), 'C:\\Mohassan AI'];
  for (const candidate of candidates) if (candidate && existsSync(join(candidate, 'scripts', 'dev.mjs'))) return resolve(candidate);
  return resolve(__dirname, '..', '..', '..');
}

function loadConfig(): Config {
  let saved: Partial<Config> = {};
  try { saved = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<Config>; } catch { saved = {}; }
  const config: Config = {
    repoRoot: saved.repoRoot && existsSync(join(saved.repoRoot, 'scripts', 'dev.mjs')) ? saved.repoRoot : detectRepoRoot(),
    mode: flag('--lab') ? 'lab' : flag('--production') ? 'production' : saved.mode ?? 'dev',
    webUrl: saved.webUrl ?? 'http://127.0.0.1:3000',
    serverUrl: saved.serverUrl ?? 'http://127.0.0.1:4000',
    labDir: saved.labDir ?? '.data/local-lab',
    autostartStack: saved.autostartStack ?? true,
    closeToTray: saved.closeToTray ?? true,
    startHidden: flag('--hidden') || (saved.startHidden ?? false),
  };
  if (option('--repo')) config.repoRoot = resolve(option('--repo')!);
  try { mkdirSync(userDir, { recursive: true }); writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8'); } catch { /* read-only profile */ }
  return config;
}

const config = loadConfig();
const logFile = join(logDir, `stack-${new Date().toISOString().slice(0, 10)}.log`);
function log(line: string) {
  try { mkdirSync(logDir, { recursive: true }); appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`); } catch { /* best effort */ }
}

let mainWindow: BrowserWindow | null = null;
let splash: BrowserWindow | null = null;
let tray: Tray | null = null;
let stack: ChildProcess | null = null;
let stackStartedHere = false;
let quitting = false;

const icon = () => nativeImage.createFromPath(join(assets, 'icon.png'));
const trayIcon = () => nativeImage.createFromPath(join(assets, 'tray.png'));

async function reachable(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return response.status > 0 && response.status < 500;
  } catch { return false; }
}

/** A stack already running answers on its API at once, even while the web dev server is compiling a page. */
async function stackAlreadyRunning(): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await reachable(`${config.serverUrl}/health`, 2500) && await reachable(config.webUrl, 8000)) return true;
    if (!await reachable(`${config.serverUrl}/health`, 2500)) return false;
  }
  return false;
}

function setSplash(text: string, detail = '', failed = false) {
  if (!splash || splash.isDestroyed()) return;
  void splash.webContents.executeJavaScript(`window.setStatus(${JSON.stringify(text)}, ${JSON.stringify(detail)}, ${failed})`).catch(() => undefined);
}

function createSplash() {
  splash = new BrowserWindow({ width: 440, height: 320, frame: false, resizable: false, show: false, icon: icon(), backgroundColor: '#f7f8f5', webPreferences: { contextIsolation: true, sandbox: true } });
  void splash.loadFile(join(assets, 'loading.html'));
  splash.once('ready-to-show', () => { if (!config.startHidden) splash?.show(); });
}

/** Starts `scripts/dev.mjs` from the repository with the system Node; the service and the web app follow. */
function startStack(): ChildProcess {
  const script = join(config.repoRoot, 'scripts', 'dev.mjs');
  const modeArgs = config.mode === 'lab' ? ['--local-lab'] : config.mode === 'production' ? ['--production'] : [];
  log(`starting stack: node ${script} ${modeArgs.join(' ')} (cwd ${config.repoRoot})`);
  // The stack listens where this app expects it; a lab keeps its own folder so two labs never share one database.
  const web = new URL(config.webUrl), api = new URL(config.serverUrl);
  const env: NodeJS.ProcessEnv = { ...process.env, MOHASSAN_DESKTOP_SHELL: '1', FORCE_COLOR: '0', SERVER_PORT: api.port || '4000', PORT: web.port || '3000', WEB_ORIGIN: web.origin, ...(config.mode === 'lab' ? { MOHASSAN_LAB_DIR: config.labDir } : {}) };
  const child = spawn('node', [script, ...modeArgs], { cwd: config.repoRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  child.stdout?.on('data', chunk => log(`[stack] ${String(chunk).trimEnd()}`));
  child.stderr?.on('data', chunk => log(`[stack!] ${String(chunk).trimEnd()}`));
  child.on('exit', code => {
    log(`stack exited with ${code}`);
    stack = null;
    if (!quitting && stackStartedHere) {
      const choice = dialog.showMessageBoxSync({ type: 'warning', title: 'موحسن', message: 'توقفت خدمة موحسن.', detail: `رمز الخروج ${code ?? '؟'}. راجع السجل:\n${logFile}`, buttons: ['أعد التشغيل', 'افتح السجل', 'إغلاق'], defaultId: 0, cancelId: 2, noLink: true });
      if (choice === 0) void boot();
      else if (choice === 1) void shell.openPath(logFile);
    }
  });
  stackStartedHere = true;
  return child;
}

function stopStack() {
  const child = stack;
  stack = null;
  if (!child?.pid) return;
  log(`stopping stack pid ${child.pid}`);
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGTERM');
}

function createMainWindow() {
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
    splash?.close(); splash = null;
  });
  void mainWindow.loadURL(config.webUrl);
}

/**
 * Opens the page once the service answers. A new window closes the splash itself when it is ready to show; an existing one
 * (after «أعد التشغيل») only reloads, so it closes the splash here. Before 2026-11-22 the splash stayed on top saying «جاهز».
 */
function openMain() {
  if (!mainWindow) { createMainWindow(); return; }
  const window = mainWindow;
  window.webContents.once('did-stop-loading', () => {
    splash?.close(); splash = null;
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
    { label: 'إعادة تشغيل الخدمة', click: () => { stopStack(); setTimeout(() => { void boot(true); }, 1500); } },
    { label: 'التشغيل مع Windows', type: 'checkbox', checked: openAtLogin(), click: item => { app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }); refresh(); } },
    { label: 'اختصار على سطح المكتب', click: createDesktopShortcut },
    { label: 'فتح الإعدادات', click: () => { void shell.openPath(configPath); } },
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
  if (!restart && !splash) createSplash();
  const started = Date.now();
  setSplash('يبحث عن خدمة موحسن…', config.webUrl);
  if (await stackAlreadyRunning()) {
    log(`web already running at ${config.webUrl}`);
    setSplash('موحسن يعمل بالفعل، يُفتح…');
    openMain();
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
  if (!stack) stack = startStack();
  const deadline = Date.now() + 300_000;
  let serverReady = false;
  while (Date.now() < deadline && !quitting) {
    if (!serverReady && await reachable(`${config.serverUrl}/health`, 800)) { serverReady = true; setSplash('الخادم جاهز، تبدأ الواجهة…', `${Math.round((Date.now() - started) / 1000)} ث`); }
    if (await reachable(config.webUrl, 1200)) {
      log(`stack ready in ${Date.now() - started} ms`);
      setSplash('جاهز.', `${Math.round((Date.now() - started) / 1000)} ث`);
      openMain();
      if (Notification.isSupported()) new Notification({ title: 'موحسن', body: `جاهز للعمل بعد ${Math.round((Date.now() - started) / 1000)} ثانية.`, icon: icon() }).show();
      return;
    }
    if (!stack) { setSplash('توقفت الخدمة أثناء البدء.', `راجع السجل:\n${logFile}`, true); return; }
    setSplash(serverReady ? 'تبدأ الواجهة…' : 'يبدأ خادم موحسن…', `${Math.round((Date.now() - started) / 1000)} ث · ${logFile}`);
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  setSplash('لم تصبح الخدمة جاهزة خلال خمس دقائق.', `راجع السجل:\n${logFile}`, true);
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
  app.on('before-quit', () => { quitting = true; globalShortcut.unregisterAll(); if (stackStartedHere) stopStack(); });
}
