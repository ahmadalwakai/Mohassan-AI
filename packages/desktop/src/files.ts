import { cp, mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import type { DesktopAudit } from './audit.ts';
import { DesktopError } from './errors.ts';
import type { PathPolicy } from './paths.ts';
import { psQuote, runCommand } from './shell.ts';

export interface FileEntry { name: string; kind: 'file' | 'folder' | 'link' | 'other'; size: number; modifiedAt: string; hidden: boolean }
export interface Listing { path: string; display: string; parent: string | null; entries: FileEntry[]; truncated: boolean; total: number }
export interface FileContent { path: string; display: string; text: string; size: number; truncated: boolean; binary: boolean; modifiedAt: string }
export interface WriteResult { path: string; display: string; bytes: number; created: boolean; appended: boolean }
export interface SearchHit { path: string; display: string; kind: 'file' | 'folder'; size: number; modifiedAt: string }

const HIDDEN_NAMES = /^(?:desktop\.ini|thumbs\.db|ntuser\.(?:dat|ini|pol).*|\$recycle\.bin|iconcache.*)$/iu;
const SKIP_DIRS = new Set(['node_modules', '.git', 'appdata', '$recycle.bin', 'system volume information', '.next', '.venv', 'venv', '__pycache__', 'dist', 'build', '.cache']);
const MAX_WRITE = 2 * 1024 * 1024;

const isHidden = (name: string) => name.startsWith('.') || HIDDEN_NAMES.test(name);

/** Glob-ish name match: `*` and `?` wildcards; without wildcards a case-insensitive substring. */
export function nameMatcher(pattern: string): (name: string) => boolean {
  const text = pattern.trim().toLowerCase();
  if (!text) return () => true;
  if (!/[*?]/u.test(text)) return name => name.toLowerCase().includes(text);
  const regex = new RegExp(`^${text.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*').replace(/\?/gu, '.')}$`, 'iu');
  return name => regex.test(name);
}

export class DesktopFiles {
  constructor(private readonly policy: PathPolicy, private readonly audit: DesktopAudit) {}

  async list(path: string | undefined, options: { showHidden?: boolean; limit?: number; base?: string } = {}): Promise<Listing> {
    const target = await this.policy.resolve(path ?? this.policy.primaryRoot, { base: options.base, mustExist: true, allowRoot: true });
    const info = await stat(target);
    if (!info.isDirectory()) throw new DesktopError('DESKTOP_NOT_A_FOLDER', `هذا المسار ملف وليس مجلدًا: ${this.policy.display(target)}`);
    const limit = Math.min(Math.max(options.limit ?? 400, 1), 2000);
    const names = await readdir(target, { withFileTypes: true });
    const entries: FileEntry[] = [];
    for (const dirent of names) {
      const hidden = isHidden(dirent.name);
      if (hidden && !options.showHidden) continue;
      let size = 0, modifiedAt = '';
      try { const details = await stat(join(target, dirent.name)); size = details.isDirectory() ? 0 : details.size; modifiedAt = details.mtime.toISOString(); } catch { /* unreadable entry */ }
      entries.push({ name: dirent.name, kind: dirent.isSymbolicLink() ? 'link' : dirent.isDirectory() ? 'folder' : dirent.isFile() ? 'file' : 'other', size, modifiedAt, hidden });
    }
    entries.sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || a.name.localeCompare(b.name, 'ar'));
    const parentPath = dirname(target);
    return { path: target, display: this.policy.display(target), parent: parentPath !== target && this.policy.isInsideRoots(parentPath) ? parentPath : null, entries: entries.slice(0, limit), truncated: entries.length > limit, total: entries.length };
  }

  async read(path: string, options: { maxBytes?: number; base?: string } = {}): Promise<FileContent> {
    const target = await this.policy.resolve(path, { base: options.base, mustExist: true });
    const info = await stat(target);
    if (info.isDirectory()) throw new DesktopError('DESKTOP_IS_FOLDER', `هذا المسار مجلد: ${this.policy.display(target)}`);
    const maxBytes = Math.min(Math.max(options.maxBytes ?? 200_000, 1024), 2_000_000);
    const handle = await open(target, 'r');
    try {
      const take = Math.min(info.size, maxBytes);
      const buffer = Buffer.alloc(take);
      const { bytesRead } = await handle.read(buffer, 0, take, 0);
      const bytes = buffer.subarray(0, bytesRead);
      const binary = bytes.subarray(0, 8192).includes(0);
      await this.audit.record('file_read', { path: target, bytes: bytesRead });
      return { path: target, display: this.policy.display(target), text: binary ? '' : bytes.toString('utf8'), size: info.size, truncated: info.size > take, binary, modifiedAt: info.mtime.toISOString() };
    } finally { await handle.close(); }
  }

  async write(path: string, content: string, options: { overwrite?: boolean; append?: boolean; base?: string } = {}): Promise<WriteResult> {
    const target = await this.policy.resolve(path, { base: options.base });
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE) throw new DesktopError('DESKTOP_CONTENT_TOO_LARGE', 'المحتوى أكبر من 2 ميغابايت.');
    let exists = false;
    try { const info = await stat(target); exists = true; if (info.isDirectory()) throw new DesktopError('DESKTOP_IS_FOLDER', `يوجد مجلد بهذا الاسم: ${this.policy.display(target)}`); } catch (error) {
      if (error instanceof DesktopError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (exists && !options.overwrite && !options.append) throw new DesktopError('DESKTOP_FILE_EXISTS', `الملف موجود مسبقًا: ${this.policy.display(target)}. اطلب الكتابة فوقه أو الإضافة إليه صراحة.`, 409);
    await mkdir(dirname(target), { recursive: true });
    if (options.append && exists) {
      // Appended text starts on its own line unless the file already ends with one.
      const info = await stat(target);
      let needsBreak = false;
      if (info.size > 0) {
        const handle = await open(target, 'r');
        try { const last = Buffer.alloc(1); await handle.read(last, 0, 1, info.size - 1); needsBreak = last[0] !== 0x0a; } finally { await handle.close(); }
      }
      await writeFile(target, `${needsBreak ? '\n' : ''}${content}`, { encoding: 'utf8', flag: 'a' });
    } else await writeFile(target, content, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    await this.audit.record('file_write', { path: target, bytes, created: !exists, appended: Boolean(options.append && exists) });
    return { path: target, display: this.policy.display(target), bytes, created: !exists, appended: Boolean(options.append && exists) };
  }

  async mkdir(path: string, options: { base?: string } = {}): Promise<{ path: string; display: string; created: boolean }> {
    const target = await this.policy.resolve(path, { base: options.base });
    let created = true;
    try { const info = await stat(target); created = false; if (!info.isDirectory()) throw new DesktopError('DESKTOP_FILE_EXISTS', `يوجد ملف بهذا الاسم: ${this.policy.display(target)}`, 409); } catch (error) {
      if (error instanceof DesktopError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(target, { recursive: true });
    }
    await this.audit.record('folder_create', { path: target, created });
    return { path: target, display: this.policy.display(target), created };
  }

  async move(from: string, to: string, options: { overwrite?: boolean; base?: string } = {}): Promise<{ from: string; to: string; display: string }> {
    const source = await this.policy.resolve(from, { base: options.base, mustExist: true });
    let target = await this.policy.resolve(to, { base: options.base });
    try { const info = await stat(target); if (info.isDirectory()) target = join(target, basename(source)); } catch { /* new name */ }
    try { await stat(target); if (!options.overwrite) throw new DesktopError('DESKTOP_FILE_EXISTS', `الوجهة موجودة مسبقًا: ${this.policy.display(target)}`, 409); } catch (error) {
      if (error instanceof DesktopError) throw error;
    }
    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
    await this.audit.record('move', { from: source, to: target });
    return { from: source, to: target, display: this.policy.display(target) };
  }

  async copy(from: string, to: string, options: { base?: string } = {}): Promise<{ from: string; to: string; display: string }> {
    const source = await this.policy.resolve(from, { base: options.base, mustExist: true });
    let target = await this.policy.resolve(to, { base: options.base });
    try { const info = await stat(target); if (info.isDirectory()) target = join(target, basename(source)); } catch { /* new name */ }
    await cp(source, target, { recursive: true, errorOnExist: true, force: false });
    await this.audit.record('copy', { from: source, to: target });
    return { from: source, to: target, display: this.policy.display(target) };
  }

  /** Sends a file or folder to the Recycle Bin; nothing is deleted permanently. */
  async recycle(path: string, options: { base?: string } = {}): Promise<{ path: string; display: string; kind: 'file' | 'folder' }> {
    const target = await this.policy.resolve(path, { base: options.base, mustExist: true });
    const info = await stat(target);
    const kind = info.isDirectory() ? 'folder' : 'file';
    if (process.platform === 'win32') {
      const method = kind === 'folder' ? 'DeleteDirectory' : 'DeleteFile';
      const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${method}(${psQuote(target)}, 'OnlyErrorDialogs', 'SendToRecycleBin'); 'OK'`;
      const result = await runCommand(script, { cwd: dirname(target), shell: 'powershell', timeoutMs: 30_000 });
      if (!result.stdout.includes('OK')) throw new DesktopError('DESKTOP_RECYCLE_FAILED', `تعذر نقل العنصر إلى سلة المحذوفات: ${(result.stderr || result.stdout).trim().slice(0, 300)}`, 502);
    } else {
      const trash = join(this.policy.primaryRoot, '.mohassan-trash');
      await mkdir(trash, { recursive: true });
      await rename(target, join(trash, `${Date.now()}-${basename(target)}`));
    }
    await this.audit.record('recycle', { path: target, kind });
    return { path: target, display: this.policy.display(target), kind };
  }

  async search(root: string | undefined, pattern: string, options: { limit?: number; maxDepth?: number; base?: string } = {}): Promise<{ root: string; hits: SearchHit[]; truncated: boolean; scanned: number }> {
    const start = await this.policy.resolve(root ?? this.policy.primaryRoot, { base: options.base, mustExist: true, allowRoot: true });
    const matches = nameMatcher(pattern);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500), maxDepth = Math.min(Math.max(options.maxDepth ?? 6, 1), 12);
    const hits: SearchHit[] = [];
    let scanned = 0, truncated = false;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (hits.length >= limit || scanned > 50_000) { truncated = true; return; }
      let dirents;
      try { dirents = await readdir(directory, { withFileTypes: true }); } catch { return; }
      for (const dirent of dirents) {
        scanned++;
        const full = join(directory, dirent.name);
        if (matches(dirent.name) && !isHidden(dirent.name)) {
          let size = 0, modifiedAt = '';
          try { const info = await stat(full); size = info.isDirectory() ? 0 : info.size; modifiedAt = info.mtime.toISOString(); } catch { /* skip */ }
          hits.push({ path: full, display: this.policy.display(full), kind: dirent.isDirectory() ? 'folder' : 'file', size, modifiedAt });
          if (hits.length >= limit) { truncated = true; return; }
        }
        if (dirent.isDirectory() && !dirent.isSymbolicLink() && depth < maxDepth && !SKIP_DIRS.has(dirent.name.toLowerCase()) && !isHidden(dirent.name)) await walk(full, depth + 1);
      }
    };
    await walk(start, 0);
    return { root: start, hits, truncated, scanned };
  }

  async info(path: string, options: { base?: string } = {}): Promise<{ path: string; display: string; kind: 'file' | 'folder'; size: number; modifiedAt: string; createdAt: string; name: string; relativeToRoot: string }> {
    const target = await this.policy.resolve(path, { base: options.base, mustExist: true, allowRoot: true });
    const details = await stat(target);
    return { path: target, display: this.policy.display(target), kind: details.isDirectory() ? 'folder' : 'file', size: details.size, modifiedAt: details.mtime.toISOString(), createdAt: details.birthtime.toISOString(), name: basename(target), relativeToRoot: relative(this.policy.primaryRoot, target) };
  }

  async readRaw(path: string): Promise<Buffer> {
    const target = await this.policy.resolve(path, { mustExist: true });
    return readFile(target);
  }
}
