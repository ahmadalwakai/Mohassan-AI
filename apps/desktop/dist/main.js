"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const APP_ID = 'ai.mohassan.desktop';
electron_1.app.setName('Mohassan');
electron_1.app.setAppUserModelId(APP_ID);
const userDir = electron_1.app.getPath('userData');
const logDir = (0, node_path_1.join)(userDir, 'logs');
const configPath = (0, node_path_1.join)(userDir, 'config.json');
const assets = (0, node_path_1.join)(__dirname, '..', 'assets');
const args = process.argv.slice(1);
const flag = (name) => args.includes(name);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
/** The repository: the folder this app runs from in development, or the saved path once packaged. */
function detectRepoRoot() {
    const candidates = [option('--repo'), process.env.MOHASSAN_REPO, (0, node_path_1.resolve)(__dirname, '..', '..', '..'), 'C:\\Mohassan AI'];
    for (const candidate of candidates)
        if (candidate && (0, node_fs_1.existsSync)((0, node_path_1.join)(candidate, 'scripts', 'dev.mjs')))
            return (0, node_path_1.resolve)(candidate);
    return (0, node_path_1.resolve)(__dirname, '..', '..', '..');
}
function loadConfig() {
    let saved = {};
    try {
        saved = JSON.parse((0, node_fs_1.readFileSync)(configPath, 'utf8'));
    }
    catch {
        saved = {};
    }
    const config = {
        repoRoot: saved.repoRoot && (0, node_fs_1.existsSync)((0, node_path_1.join)(saved.repoRoot, 'scripts', 'dev.mjs')) ? saved.repoRoot : detectRepoRoot(),
        mode: flag('--lab') ? 'lab' : flag('--production') ? 'production' : saved.mode ?? 'dev',
        webUrl: saved.webUrl ?? 'http://127.0.0.1:3000',
        serverUrl: saved.serverUrl ?? 'http://127.0.0.1:4000',
        labDir: saved.labDir ?? '.data/local-lab',
        autostartStack: saved.autostartStack ?? true,
        closeToTray: saved.closeToTray ?? true,
        startHidden: flag('--hidden') || (saved.startHidden ?? false),
    };
    if (option('--repo'))
        config.repoRoot = (0, node_path_1.resolve)(option('--repo'));
    try {
        (0, node_fs_1.mkdirSync)(userDir, { recursive: true });
        (0, node_fs_1.writeFileSync)(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    }
    catch { /* read-only profile */ }
    return config;
}
const config = loadConfig();
const logFile = (0, node_path_1.join)(logDir, `stack-${new Date().toISOString().slice(0, 10)}.log`);
function log(line) {
    try {
        (0, node_fs_1.mkdirSync)(logDir, { recursive: true });
        (0, node_fs_1.appendFileSync)(logFile, `[${new Date().toISOString()}] ${line}\n`);
    }
    catch { /* best effort */ }
}
let mainWindow = null;
let splash = null;
let tray = null;
let stack = null;
let stackStartedHere = false;
let quitting = false;
const icon = () => electron_1.nativeImage.createFromPath((0, node_path_1.join)(assets, 'icon.png'));
const trayIcon = () => electron_1.nativeImage.createFromPath((0, node_path_1.join)(assets, 'tray.png'));
async function reachable(url, timeoutMs = 1500) {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
        return response.status > 0 && response.status < 500;
    }
    catch {
        return false;
    }
}
/** A stack already running answers on its API at once, even while the web dev server is compiling a page. */
async function stackAlreadyRunning() {
    for (let attempt = 0; attempt < 3; attempt++) {
        if (await reachable(`${config.serverUrl}/health`, 2500) && await reachable(config.webUrl, 8000))
            return true;
        if (!await reachable(`${config.serverUrl}/health`, 2500))
            return false;
    }
    return false;
}
function setSplash(text, detail = '', failed = false) {
    if (!splash || splash.isDestroyed())
        return;
    void splash.webContents.executeJavaScript(`window.setStatus(${JSON.stringify(text)}, ${JSON.stringify(detail)}, ${failed})`).catch(() => undefined);
}
function createSplash() {
    splash = new electron_1.BrowserWindow({ width: 440, height: 320, frame: false, resizable: false, show: false, icon: icon(), backgroundColor: '#f7f8f5', webPreferences: { contextIsolation: true, sandbox: true } });
    void splash.loadFile((0, node_path_1.join)(assets, 'loading.html'));
    splash.once('ready-to-show', () => { if (!config.startHidden)
        splash?.show(); });
}
/** Starts `scripts/dev.mjs` from the repository with the system Node; the service and the web app follow. */
function startStack() {
    const script = (0, node_path_1.join)(config.repoRoot, 'scripts', 'dev.mjs');
    const modeArgs = config.mode === 'lab' ? ['--local-lab'] : config.mode === 'production' ? ['--production'] : [];
    log(`starting stack: node ${script} ${modeArgs.join(' ')} (cwd ${config.repoRoot})`);
    // The stack listens where this app expects it; a lab keeps its own folder so two labs never share one database.
    const web = new URL(config.webUrl), api = new URL(config.serverUrl);
    const env = { ...process.env, MOHASSAN_DESKTOP_SHELL: '1', FORCE_COLOR: '0', SERVER_PORT: api.port || '4000', PORT: web.port || '3000', WEB_ORIGIN: web.origin, ...(config.mode === 'lab' ? { MOHASSAN_LAB_DIR: config.labDir } : {}) };
    const child = (0, node_child_process_1.spawn)('node', [script, ...modeArgs], { cwd: config.repoRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    child.stdout?.on('data', chunk => log(`[stack] ${String(chunk).trimEnd()}`));
    child.stderr?.on('data', chunk => log(`[stack!] ${String(chunk).trimEnd()}`));
    child.on('exit', code => {
        log(`stack exited with ${code}`);
        stack = null;
        if (!quitting && stackStartedHere) {
            const choice = electron_1.dialog.showMessageBoxSync({ type: 'warning', title: 'موحسن', message: 'توقفت خدمة موحسن.', detail: `رمز الخروج ${code ?? '؟'}. راجع السجل:\n${logFile}`, buttons: ['أعد التشغيل', 'افتح السجل', 'إغلاق'], defaultId: 0, cancelId: 2, noLink: true });
            if (choice === 0)
                void boot();
            else if (choice === 1)
                void electron_1.shell.openPath(logFile);
        }
    });
    stackStartedHere = true;
    return child;
}
function stopStack() {
    const child = stack;
    stack = null;
    if (!child?.pid)
        return;
    log(`stopping stack pid ${child.pid}`);
    if (process.platform === 'win32')
        (0, node_child_process_1.spawn)('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else
        child.kill('SIGTERM');
}
function createMainWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1320, height: 860, minWidth: 900, minHeight: 600, title: 'موحسن', icon: icon(), show: false, autoHideMenuBar: true, backgroundColor: '#f7f8f5',
        webPreferences: { preload: (0, node_path_1.join)(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
    });
    electron_1.Menu.setApplicationMenu(null);
    const localOrigins = new Set([new URL(config.webUrl).origin, new URL(config.serverUrl).origin]);
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        try {
            if (localOrigins.has(new URL(url).origin))
                return { action: 'allow' };
        }
        catch { /* fall through */ }
        void electron_1.shell.openExternal(url);
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
        try {
            if (localOrigins.has(new URL(url).origin))
                return;
        }
        catch { /* fall through */ }
        event.preventDefault();
        void electron_1.shell.openExternal(url);
    });
    mainWindow.on('close', event => {
        if (quitting || !config.closeToTray)
            return;
        event.preventDefault();
        mainWindow?.hide();
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.once('ready-to-show', () => {
        if (!config.startHidden) {
            mainWindow?.show();
            mainWindow?.focus();
        }
        splash?.close();
        splash = null;
    });
    void mainWindow.loadURL(config.webUrl);
}
function showMain() {
    if (!mainWindow) {
        createMainWindow();
        return;
    }
    if (mainWindow.isMinimized())
        mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}
function toggleMain() {
    if (mainWindow?.isVisible() && mainWindow.isFocused())
        mainWindow.hide();
    else
        showMain();
}
function openAtLogin() { return electron_1.app.getLoginItemSettings().openAtLogin; }
/** A Desktop shortcut that launches this same app, packaged or from the repository. */
function createDesktopShortcut() {
    const target = process.execPath;
    const shortcutArgs = electron_1.app.isPackaged ? '' : `"${(0, node_path_1.join)(config.repoRoot, 'apps', 'desktop')}"`;
    const link = (0, node_path_1.join)((0, node_os_1.homedir)(), 'Desktop', 'Mohassan.lnk');
    const ok = electron_1.shell.writeShortcutLink(link, 'create', { target, args: shortcutArgs, cwd: config.repoRoot, icon: (0, node_path_1.join)(assets, 'icon.ico'), iconIndex: 0, description: 'موحسن — مساعدك على هذا الجهاز' });
    new electron_1.Notification({ title: 'موحسن', body: ok ? 'أُنشئ اختصار «Mohassan» على سطح المكتب.' : 'تعذر إنشاء الاختصار.' }).show();
}
function buildTray() {
    tray = new electron_1.Tray(trayIcon());
    tray.setToolTip('موحسن');
    const refresh = () => tray?.setContextMenu(electron_1.Menu.buildFromTemplate([
        { label: 'فتح موحسن', click: showMain },
        { label: 'مجلد المشاريع', click: () => { const folder = (0, node_path_1.join)((0, node_os_1.homedir)(), 'Mohassan Projects'); (0, node_fs_1.mkdirSync)(folder, { recursive: true }); void electron_1.shell.openPath(folder); } },
        { label: 'لقطات الشاشة', click: () => { const folder = (0, node_path_1.join)((0, node_os_1.homedir)(), 'Pictures', 'Mohassan Screenshots'); (0, node_fs_1.mkdirSync)(folder, { recursive: true }); void electron_1.shell.openPath(folder); } },
        { type: 'separator' },
        { label: 'إعادة تشغيل الخدمة', click: () => { stopStack(); setTimeout(() => { void boot(true); }, 1500); } },
        { label: 'التشغيل مع Windows', type: 'checkbox', checked: openAtLogin(), click: item => { electron_1.app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }); refresh(); } },
        { label: 'اختصار على سطح المكتب', click: createDesktopShortcut },
        { label: 'فتح الإعدادات', click: () => { void electron_1.shell.openPath(configPath); } },
        { label: 'فتح سجل التشغيل', click: () => { void electron_1.shell.openPath(logFile); } },
        { type: 'separator' },
        { label: `الوضع: ${config.mode === 'lab' ? 'مختبر محلي' : config.mode === 'production' ? 'إنتاج' : 'تطوير'} · ${config.webUrl}`, enabled: false },
        { label: 'خروج', click: () => { quitting = true; electron_1.app.quit(); } },
    ]));
    refresh();
    tray.on('click', toggleMain);
    tray.on('double-click', showMain);
}
/** Opens the window as soon as the web app answers; starts the stack first when nothing answers. */
async function boot(restart = false) {
    if (!restart && !splash)
        createSplash();
    const started = Date.now();
    setSplash('يبحث عن خدمة موحسن…', config.webUrl);
    if (await stackAlreadyRunning()) {
        log(`web already running at ${config.webUrl}`);
        setSplash('موحسن يعمل بالفعل، يُفتح…');
        if (!mainWindow)
            createMainWindow();
        else
            void mainWindow.loadURL(config.webUrl);
        return;
    }
    if (!config.autostartStack) {
        setSplash('خدمة موحسن لا تعمل.', `شغّلها من مجلد المشروع ثم أعد فتح التطبيق:\n${config.repoRoot}`, true);
        return;
    }
    if (!(0, node_fs_1.existsSync)((0, node_path_1.join)(config.repoRoot, 'scripts', 'dev.mjs'))) {
        setSplash('لم أجد مجلد مشروع موحسن.', `عدّل repoRoot في:\n${configPath}`, true);
        return;
    }
    setSplash('يبدأ خادم موحسن…', config.repoRoot);
    if (!stack)
        stack = startStack();
    const deadline = Date.now() + 300_000;
    let serverReady = false;
    while (Date.now() < deadline && !quitting) {
        if (!serverReady && await reachable(`${config.serverUrl}/health`, 800)) {
            serverReady = true;
            setSplash('الخادم جاهز، تبدأ الواجهة…', `${Math.round((Date.now() - started) / 1000)} ث`);
        }
        if (await reachable(config.webUrl, 1200)) {
            log(`stack ready in ${Date.now() - started} ms`);
            setSplash('جاهز.', `${Math.round((Date.now() - started) / 1000)} ث`);
            if (!mainWindow)
                createMainWindow();
            else
                void mainWindow.loadURL(config.webUrl);
            if (electron_1.Notification.isSupported())
                new electron_1.Notification({ title: 'موحسن', body: `جاهز للعمل بعد ${Math.round((Date.now() - started) / 1000)} ثانية.`, icon: icon() }).show();
            return;
        }
        if (!stack) {
            setSplash('توقفت الخدمة أثناء البدء.', `راجع السجل:\n${logFile}`, true);
            return;
        }
        setSplash(serverReady ? 'تبدأ الواجهة…' : 'يبدأ خادم موحسن…', `${Math.round((Date.now() - started) / 1000)} ث · ${logFile}`);
        await new Promise(resolve => setTimeout(resolve, 700));
    }
    setSplash('لم تصبح الخدمة جاهزة خلال خمس دقائق.', `راجع السجل:\n${logFile}`, true);
}
const single = electron_1.app.requestSingleInstanceLock();
if (!single)
    electron_1.app.quit();
else {
    electron_1.app.on('second-instance', showMain);
    electron_1.app.whenReady().then(() => {
        buildTray();
        electron_1.globalShortcut.register('CommandOrControl+Shift+M', toggleMain);
        void boot();
        electron_1.app.on('activate', showMain);
    });
    electron_1.app.on('window-all-closed', () => { });
    electron_1.app.on('before-quit', () => { quitting = true; electron_1.globalShortcut.unregisterAll(); if (stackStartedHere)
        stopStack(); });
}
