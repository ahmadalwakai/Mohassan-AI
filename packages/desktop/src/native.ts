import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { DesktopAudit } from './audit.ts';
import { DesktopError } from './errors.ts';

export interface WindowInfo { handle: number; title: string; processId: number; processName: string; className: string; x: number; y: number; width: number; height: number; minimized: boolean; maximized: boolean; foreground: boolean }
export interface ElementInfo { name: string; type: string; x: number; y: number; width: number; height: number; password: boolean; enabled: boolean }
export interface Screenshot { png: string; width: number; height: number; scaledWidth: number; scaledHeight: number; left: number; top: number; capturedAt: string; window: WindowInfo | null }
export interface ScreenInfo { device: string; x: number; y: number; width: number; height: number; primary: boolean }

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
interface Reply { id?: string; ok?: boolean; result?: unknown; error?: string; ready?: boolean }

const HOST_SCRIPT = fileURLToPath(new URL('../native/host.ps1', import.meta.url));
const SOURCE = fileURLToPath(new URL('../native/DesktopNative.cs', import.meta.url));

/** Lowercases the first letter of every key: PowerShell serialises .NET properties in PascalCase. */
function camel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camel);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) out[key.charAt(0).toLowerCase() + key.slice(1)] = camel(inner);
    return out;
  }
  return value;
}

/**
 * One long-lived Windows PowerShell process hosting the compiled C# helper.
 * Calls run one at a time; a crashed host restarts on the next call.
 */
export class NativeHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
  private queue: Promise<unknown> = Promise.resolve();
  private stderr = '';
  readonly available = process.platform === 'win32';

  constructor(private readonly options: { cacheDir: string; startTimeoutMs?: number; callTimeoutMs?: number; powershell?: string }) {}

  private async start(): Promise<void> {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await mkdir(this.options.cacheDir, { recursive: true });
      const child = spawn(this.options.powershell ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOST_SCRIPT, '-Source', SOURCE, '-CacheDir', this.options.cacheDir], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.stderr = '';
      child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4000); });
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new DesktopError('DESKTOP_NATIVE_START_TIMEOUT', 'لم يبدأ المساعد الأصلي لسطح المكتب في الوقت المحدد.', 503)), this.options.startTimeoutMs ?? 90_000);
        const lines = createInterface({ input: child.stdout });
        lines.on('line', line => {
          let reply: Reply;
          try { reply = JSON.parse(line) as Reply; } catch { return; }
          if (reply.ready) { clearTimeout(timer); resolve(); return; }
          if (!reply.id) return;
          const waiting = this.pending.get(reply.id);
          if (!waiting) return;
          this.pending.delete(reply.id);
          clearTimeout(waiting.timer);
          if (reply.ok) waiting.resolve(camel(reply.result ?? null));
          else waiting.reject(new DesktopError('DESKTOP_NATIVE_FAILED', String(reply.error ?? 'native call failed'), 502));
        });
        child.on('error', error => { clearTimeout(timer); reject(new DesktopError('DESKTOP_NATIVE_UNAVAILABLE', `تعذر تشغيل PowerShell: ${error.message}`, 503)); });
        child.on('exit', code => {
          clearTimeout(timer);
          reject(new DesktopError('DESKTOP_NATIVE_EXITED', `خرج المساعد الأصلي (${code ?? 'signal'}): ${this.stderr.trim().slice(-600)}`, 503));
          this.child = null;
          for (const [id, waiting] of this.pending) { clearTimeout(waiting.timer); waiting.reject(new DesktopError('DESKTOP_NATIVE_EXITED', 'توقف المساعد الأصلي أثناء التنفيذ.', 503)); this.pending.delete(id); }
        });
      });
      this.child = child;
      try { await ready; } catch (error) { this.child = null; try { child.kill(); } catch { /* gone */ } throw error; }
    })();
    try { await this.starting; } finally { this.starting = null; }
  }

  call<T>(op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (!this.available) return Promise.reject(new DesktopError('DESKTOP_NATIVE_UNAVAILABLE', 'التحكم بالنوافذ والإدخال متاح على Windows فقط.', 503));
    const run = this.queue.then(async () => {
      await this.start();
      const child = this.child!;
      const id = randomUUID();
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(new DesktopError('DESKTOP_NATIVE_TIMEOUT', `انتهت مهلة الإجراء ${op}.`, 504)); }, timeoutMs ?? this.options.callTimeoutMs ?? 20_000);
        this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
        child.stdin.write(`${JSON.stringify({ id, op, args })}\n`, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(new DesktopError('DESKTOP_NATIVE_WRITE', error.message, 503)); } });
      });
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.stdin.end(); } catch { /* closed */ }
    await new Promise<void>(resolve => { const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(); }, 1500); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  }
}

const fold = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[ـً-ٰٟ]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').replace(/\s+/gu, ' ').trim();
const asList = <T>(value: unknown): T[] => (Array.isArray(value) ? value as T[] : value ? [value as T] : []);

/** Windows, screen and input on the owner's own session, through the native host. */
export class DesktopWindows {
  constructor(private readonly host: NativeHost, private readonly audit: DesktopAudit) {}

  async list(): Promise<WindowInfo[]> {
    return asList<WindowInfo>(await this.host.call('windows.list'));
  }

  async foreground(): Promise<WindowInfo | null> {
    return (await this.host.call<WindowInfo | null>('windows.foreground')) ?? null;
  }

  /** Finds one window by handle or by title/process fragments; several matches prefer the exact, then the foreground, then the first. */
  async find(reference: string | number | string[]): Promise<WindowInfo | null> {
    const windows = await this.list();
    if (typeof reference === 'number') return windows.find(window => window.handle === reference) ?? null;
    const keys = (Array.isArray(reference) ? reference : [reference]).map(key => fold(key).replace(/^(?:نافذه|نافذة|window)\s+/u, '')).filter(Boolean);
    if (!keys.length) return null;
    if (keys.length === 1 && /^\d+$/u.test(keys[0]!)) return windows.find(window => window.handle === Number(keys[0])) ?? null;
    const scored = windows.map(window => {
      const title = fold(window.title), process = fold(window.processName);
      let score = 0;
      for (const key of keys) score = Math.max(score, title === key || process === key ? 3 : title.startsWith(key) || process.startsWith(key) ? 2 : title.includes(key) || process.includes(key) ? 1 : 0);
      return { window, score };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || Number(b.window.foreground) - Number(a.window.foreground));
    return scored[0]?.window ?? null;
  }

  async focus(reference: string | number | string[]): Promise<{ window: WindowInfo; result: string }> {
    const window = await this.require(reference);
    const result = await this.host.call<string>('windows.focus', { handle: window.handle });
    await this.audit.record('window_focus', { title: window.title, handle: window.handle, result });
    return { window, result };
  }

  async show(reference: string | number | string[], mode: 'minimize' | 'maximize' | 'restore' | 'close'): Promise<{ window: WindowInfo; result: string }> {
    const window = await this.require(reference);
    const result = await this.host.call<string>('windows.show', { handle: window.handle, mode });
    await this.audit.record(`window_${mode}`, { title: window.title, handle: window.handle, result });
    return { window, result };
  }

  async screenshot(reference?: string | number | string[] | null, maxWidth = 1600): Promise<Screenshot> {
    const window = reference === undefined || reference === null || reference === '' ? null : await this.require(reference);
    const raw = await this.host.call<Omit<Screenshot, 'capturedAt' | 'window'>>('screen.capture', { handle: window?.handle ?? 0, maxWidth }, 30_000);
    await this.audit.record('screenshot', { window: window?.title ?? null, width: raw.width, height: raw.height });
    return { ...raw, capturedAt: new Date().toISOString(), window };
  }

  async screens(): Promise<ScreenInfo[]> { return asList<ScreenInfo>(await this.host.call('screen.list')); }

  async elements(reference?: string | number | string[] | null, limit = 150): Promise<{ window: WindowInfo | null; elements: ElementInfo[] }> {
    const window = reference === undefined || reference === null || reference === '' ? await this.foreground() : await this.require(reference);
    const elements = asList<ElementInfo>(await this.host.call('elements.list', { handle: window?.handle ?? 0, limit }, 30_000));
    return { window, elements };
  }

  private async require(reference: string | number | string[]): Promise<WindowInfo> {
    const window = await this.find(reference);
    if (!window) throw new DesktopError('DESKTOP_WINDOW_NOT_FOUND', `لم أجد نافذة مفتوحة باسم «${(Array.isArray(reference) ? reference[reference.length - 1] ?? '' : String(reference)).slice(0, 60)}».`, 404);
    return window;
  }
}

export class DesktopInput {
  constructor(private readonly host: NativeHost, private readonly audit: DesktopAudit) {}

  /** Types into whatever has focus; refused when the focused field is a password field. */
  async type(text: string, options: { allowPassword?: boolean } = {}): Promise<{ result: string; characters: number }> {
    if (!text) throw new DesktopError('DESKTOP_INPUT_EMPTY', 'لا يوجد نص للكتابة.');
    if (text.length > 4000) throw new DesktopError('DESKTOP_INPUT_TOO_LONG', 'النص أطول من 4000 حرف.');
    if (!options.allowPassword && await this.host.call<boolean>('input.focusedIsPassword')) throw new DesktopError('DESKTOP_PASSWORD_FIELD', 'الحقل الذي عليه التركيز حقل كلمة مرور؛ هذه الكتابة لك أنت.', 403);
    const result = await this.host.call<string>('input.type', { text }, 60_000);
    await this.audit.record('input_type', { characters: text.length, result });
    return { result, characters: text.length };
  }

  async keys(combo: string): Promise<{ result: string; combo: string }> {
    const normalized = normalizeCombo(combo);
    const result = await this.host.call<string>('input.keys', { combo: normalized });
    if (result.startsWith('UNKNOWN_KEY')) throw new DesktopError('DESKTOP_KEY_UNKNOWN', `مفتاح غير معروف: ${result.slice('UNKNOWN_KEY:'.length)}`);
    await this.audit.record('input_keys', { combo: normalized, result });
    return { result, combo: normalized };
  }

  async click(x: number, y: number, options: { button?: 'left' | 'right' | 'middle'; double?: boolean } = {}): Promise<{ result: string }> {
    const result = await this.host.call<string>('input.click', { x: Math.round(x), y: Math.round(y), button: options.button ?? 'left', double: options.double ?? false });
    await this.audit.record('input_click', { x, y, button: options.button ?? 'left', double: options.double ?? false, result });
    return { result };
  }

  async move(x: number, y: number): Promise<{ result: string }> {
    return { result: await this.host.call<string>('input.move', { x: Math.round(x), y: Math.round(y) }) };
  }

  async scroll(delta: number): Promise<{ result: string }> {
    const steps = Math.max(-20, Math.min(20, Math.round(delta)));
    const result = await this.host.call<string>('input.scroll', { delta: steps });
    await this.audit.record('input_scroll', { delta: steps, result });
    return { result };
  }

  async cursor(): Promise<{ x: number; y: number }> {
    const [x, y] = asList<number>(await this.host.call('input.cursor'));
    return { x: x ?? 0, y: y ?? 0 };
  }

  async clipboardGet(): Promise<string> { return (await this.host.call<string>('clipboard.get')) ?? ''; }
  async clipboardSet(text: string): Promise<void> { await this.host.call('clipboard.set', { text }); await this.audit.record('clipboard_set', { characters: text.length }); }
}

const KEY_ALIASES: Record<string, string> = {
  'إنتر': 'enter', 'انتر': 'enter', 'إدخال': 'enter', 'ادخال': 'enter', 'مسافة': 'space', 'مسافه': 'space', 'تاب': 'tab', 'هروب': 'escape', 'إسكيب': 'escape', 'اسكيب': 'escape',
  'حذف': 'delete', 'باك سبيس': 'backspace', 'تراجع': 'backspace', 'كنترول': 'ctrl', 'كونترول': 'ctrl', 'التحكم': 'ctrl', 'شيفت': 'shift', 'ألت': 'alt', 'الت': 'alt', 'ويندوز': 'win',
  'أعلى': 'up', 'اعلى': 'up', 'أسفل': 'down', 'اسفل': 'down', 'يسار': 'left', 'يمين': 'right', 'بداية': 'home', 'نهاية': 'end',
  control: 'ctrl', command: 'win', cmd: 'win', super: 'win', windows: 'win', return: 'enter', esc: 'escape', del: 'delete', pgup: 'pageup', pgdn: 'pagedown', spacebar: 'space',
};

/** «ctrl + S», «كنترول+حفظ»? no: «كنترول + s» → "ctrl+s"; names are lower-case English for the host. */
export function normalizeCombo(combo: string): string {
  const parts = combo.normalize('NFKC').toLowerCase().split(/\s*\+\s*|\s+و\s+|\s+and\s+/u).map(part => part.trim()).filter(Boolean);
  if (!parts.length) throw new DesktopError('DESKTOP_KEY_EMPTY', 'لا يوجد مفتاح للضغط.');
  return parts.map(part => KEY_ALIASES[part] ?? part.replace(/\s+/gu, '')).join('+');
}
