import { BrowserWindow, Notification, dialog, ipcMain, safeStorage, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { hostname } from 'node:os';
import { join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DesktopCodingWorker, pairCodingDevice, readCodingDeviceState, writeCodingDeviceState, type CodingDeviceState, type CodingDeviceStatus } from './coding-device.js';

const submitChannel = 'coding-device:pair';
const statusText: Record<CodingDeviceStatus, string> = {
  online: 'متصل',
  offline: 'غير متصل',
  unpaired: 'غير مربوط',
  'setup-required': 'يحتاج إعدادًا',
  'repair-required': 'يحتاج إعادة الربط',
};
const foldDrive = (url: string) => url.replace(/^file:\/\/\/([A-Za-z]):\//, (_match, drive: string) => `file:///${drive.toLowerCase()}:/`);
const folderKey = (folder: string) => win32.normalize(folder).replace(/\\+$/, '').toLowerCase();
const folderLabel = (folder: string) => folder.replaceAll('&', '&&');

export function createCodingDeviceTray(options: {
  userDir: string;
  assets: string;
  repoRoot: string;
  serverUrl: string;
  icon: () => NativeImage;
  refresh: () => void;
  log: (message: string) => void;
}) {
  const supported = process.platform === 'win32';
  const path = join(options.userDir, 'coding-device.json');
  const page = join(options.assets, 'coding-device-pair.html');
  const pageUrl = pathToFileURL(page).href;
  let state = readCodingDeviceState(path);
  let status: CodingDeviceStatus = 'unpaired';
  let window: BrowserWindow | null = null;
  let busy = false;
  let shuttingDown = false;

  function notify(message: string) {
    if (Notification.isSupported()) new Notification({ title: 'محرك البرمجة', body: message }).show();
  }

  function persist(next: CodingDeviceState) {
    writeCodingDeviceState(path, next);
    state = next;
    worker.setState(state);
  }

  function unlink(source: 'local' | 'server') {
    const next = { allowedRoots: state.allowedRoots };
    let saved = true;
    try { persist(next); } catch {
      saved = false;
      state = next;
      worker.setState(state);
    }
    if (source === 'server') {
      notify(saved ? 'ألغى الخادم ربط محرك البرمجة بهذا الجهاز.' : 'ألغى الخادم الربط. تعذر تحديث ملف الربط على هذا الجهاز.');
    } else {
      notify(saved
        ? 'أُلغي الربط على هذا الجهاز. ألغِ ربط الجهاز أيضًا من «مشاريع البرمجة» على الويب لإبطال المفتاح على الخادم.'
        : 'توقف محرك البرمجة. تعذر تحديث ملف الربط. ألغِ ربط الجهاز من «مشاريع البرمجة» على الويب.');
    }
  }

  const worker = new DesktopCodingWorker({
    repoRoot: options.repoRoot,
    decrypt: encryptedKey => safeStorage.decryptString(Buffer.from(encryptedKey, 'base64')),
    onStatus: next => { status = next; options.refresh(); },
    onRevoked: () => unlink('server'),
    onRapidExit: () => notify('توقف محرك البرمجة عدة مرات. راجع سجل التشغيل. سيحاول التطبيق تشغيله مجددًا بعد خمس دقائق.'),
    log: options.log,
  });

  ipcMain.handle(submitChannel, async (event, code: unknown) => {
    if (
      !supported || !window || event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame || foldDrive(event.senderFrame.url) !== foldDrive(pageUrl) ||
      busy || shuttingDown
    ) return { ok: false, message: 'تعذر بدء الربط.' };
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, message: 'تعذر استخدام مخزن مفاتيح Windows.' };
    busy = true;
    options.refresh();
    try {
      const credentials = await pairCodingDevice(options.serverUrl, code, hostname());
      if (shuttingDown) return { ok: false, message: 'أُغلق تطبيق موحسن أثناء الربط.' };
      const { deviceKey, ...pairing } = credentials;
      persist({
        allowedRoots: state.allowedRoots,
        pairing: { ...pairing, serverUrl: new URL(options.serverUrl).origin, encryptedKey: safeStorage.encryptString(deviceKey).toString('base64') },
      });
      return { ok: true, message: 'تم ربط هذا الجهاز. اختر مجلدات المشاريع المسموحة من قائمة موحسن.' };
    } catch (error) {
      // Network and validation errors use local text. Do not expose OS paths,
      // untrusted response text, or device credentials to the renderer.
      const message = error instanceof Error && 'code' in error && typeof error.code === 'string' &&
        /^(PAIRING_|INVALID_(?:SERVER_URL|PAIRING_))/.test(error.code)
        ? error.message : 'تعذر حفظ بيانات الربط على هذا الجهاز.';
      return { ok: false, message };
    } finally {
      busy = false;
      options.refresh();
    }
  });

  function showPairing() {
    if (window) { window.focus(); return; }
    const local = new BrowserWindow({
      title: 'ربط محرك البرمجة', width: 480, height: 340, show: false, autoHideMenuBar: true,
      icon: options.icon(), backgroundColor: '#f7f8f5',
      webPreferences: { preload: join(__dirname, 'coding-device-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    window = local;
    local.setMenu(null);
    local.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    local.webContents.on('will-navigate', event => event.preventDefault());
    local.once('ready-to-show', () => local.show());
    local.on('closed', () => { window = null; });
    void local.loadFile(page).catch(() => {
      if (!local.isDestroyed()) local.close();
      notify('تعذر فتح نافذة ربط محرك البرمجة.');
    });
  }

  async function chooseRoots() {
    const selected = await dialog.showOpenDialog({
      title: 'مجلدات مشاريع البرمجة المسموحة',
      buttonLabel: 'السماح بهذه المجلدات',
      defaultPath: state.allowedRoots[0],
      properties: ['openDirectory', 'multiSelections'],
    });
    if (selected.canceled || shuttingDown) return;
    const folders = new Map(state.allowedRoots.map(folder => [folderKey(folder), folder]));
    const originalSize = folders.size;
    for (const folder of selected.filePaths) {
      const key = folderKey(folder);
      if (!folders.has(key)) folders.set(key, folder);
    }
    if (folders.size === originalSize) return;
    if (folders.size > 128) {
      notify('تسمح قائمة مجلدات المشاريع بما يصل إلى 128 مجلدًا. أزل مجلدًا قبل إضافة مجلدات أخرى.');
      return;
    }
    try { persist({ ...state, allowedRoots: [...folders.values()] }); }
    catch { notify('تعذر حفظ مجلدات المشاريع المسموحة.'); }
  }

  async function removeRoot(folder: string) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: 'إزالة مجلد مشروع',
      message: 'هل تريد إزالة هذا المجلد من قائمة المجلدات المسموحة؟',
      detail: folder,
      buttons: ['إزالة', 'إلغاء'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0 || shuttingDown) return;
    const key = folderKey(folder);
    const allowedRoots = state.allowedRoots.filter(root => folderKey(root) !== key);
    if (allowedRoots.length !== state.allowedRoots.length) persist({ ...state, allowedRoots });
  }

  if (supported) worker.setState(state);
  return {
    menuItems(): MenuItemConstructorOptions[] {
      return [
        { label: `محرك البرمجة: ${statusText[status]}`, enabled: false },
        { label: 'ربط محرك البرمجة بهذا الجهاز…', enabled: supported && !busy, click: showPairing },
        { label: 'مجلدات المشاريع المسموحة…', enabled: supported, click: () => { void chooseRoots().catch(() => notify('تعذر فتح مجلدات المشاريع.')); } },
        ...state.allowedRoots.map(folder => ({ label: folderLabel(folder), enabled: false })),
        {
          label: 'إزالة مجلد…', enabled: supported && state.allowedRoots.length > 0,
          submenu: state.allowedRoots.map(folder => ({
            label: folderLabel(folder), click: () => { void removeRoot(folder).catch(() => notify('تعذر إزالة مجلد المشروع.')); },
          })),
        },
        { label: 'إلغاء ربط محرك البرمجة', enabled: supported && Boolean(state.pairing) && !busy, click: () => unlink('local') },
      ];
    },
    stop() {
      shuttingDown = true;
      return worker.stop();
    },
  };
}
