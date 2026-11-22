import { realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path';
import { DesktopError } from './errors.ts';

/**
 * Where the engine may read and write. The owner's own folders are the default
 * roots; system folders and the repository's secrets are refused even inside a root.
 */
export interface PathPolicyOptions {
  roots: readonly string[];
  /** Absolute paths that are never touched, whatever the roots say. */
  protectedPaths?: readonly string[];
}

const WINDOWS = process.platform === 'win32';
const CASE_FOLD = (value: string) => (WINDOWS ? value.toLowerCase() : value);
/** Folders no desktop action may enter, even when an owner root is a whole drive. */
const SYSTEM_FOLDERS = WINDOWS
  ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData', 'C:\\$Recycle.Bin', 'C:\\System Volume Information', 'C:\\Recovery', 'C:\\PerfLogs']
  : ['/bin', '/boot', '/dev', '/etc', '/lib', '/proc', '/root', '/sbin', '/sys', '/usr'];
/** File names that hold secrets; refused everywhere. */
const SECRET_FILES = /^(?:\.env(?:\..+)?|.*\.pem|.*\.key|.*\.pfx|id_rsa|id_ed25519|credentials(?:\.json)?|owner-credentials\.txt)$/iu;

export const expandHome = (value: string): string => value.replace(/^~(?=$|[\\/])/u, homedir());

export function defaultRoots(): string[] {
  const home = homedir();
  return [home];
}

export const knownFolders = (): Record<string, string> => {
  const home = homedir();
  return {
    home,
    desktop: join(home, 'Desktop'),
    documents: join(home, 'Documents'),
    downloads: join(home, 'Downloads'),
    pictures: join(home, 'Pictures'),
    videos: join(home, 'Videos'),
    music: join(home, 'Music'),
  };
};

/** The real spelling of an existing path; a missing path keeps the nearest existing ancestor's real spelling. */
function canonical(path: string): string {
  let probe = path;
  const tail: string[] = [];
  for (let depth = 0; depth < 64; depth++) {
    try { return join(realpathSync.native(probe), ...tail.reverse()); } catch {
      const parent = dirname(probe);
      if (parent === probe) return path;
      tail.push(basename(probe));
      probe = parent;
    }
  }
  return path;
}

const inside = (candidate: string, root: string): boolean => {
  const rel = relative(CASE_FOLD(root), CASE_FOLD(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export class PathPolicy {
  readonly roots: string[];
  private readonly protectedPaths: string[];
  constructor(options: PathPolicyOptions) {
    // Roots are stored in their real spelling (no 8.3 short names, no links), as realpath reports paths later.
    this.roots = [...new Set(options.roots.map(root => canonical(resolve(expandHome(root)))))];
    if (!this.roots.length) throw new DesktopError('DESKTOP_NO_ROOTS', 'لا توجد مجلدات مسموح بها لمحرك سطح المكتب.', 503);
    this.protectedPaths = [...SYSTEM_FOLDERS, ...(options.protectedPaths ?? [])].map(path => resolve(path));
  }

  /** The first root is where new things go when the owner names no folder. */
  get primaryRoot(): string { return this.roots[0]!; }

  isInsideRoots(path: string): boolean {
    const absolute = resolve(expandHome(path));
    return this.roots.some(root => inside(absolute, root)) && !this.isProtected(absolute);
  }

  isProtected(path: string): boolean {
    const absolute = resolve(path);
    if (this.protectedPaths.some(protectedPath => inside(absolute, protectedPath))) return true;
    if (SECRET_FILES.test(basename(absolute))) return true;
    // The repository's own secret and data folders stay out of reach of a chat command.
    return /[\\/]\.data(?:[\\/]|$)|[\\/]node_modules(?:[\\/]|$)|[\\/]\.git(?:[\\/]|$)/iu.test(absolute);
  }

  /**
   * Resolves an owner-supplied path to an absolute path inside the roots.
   * Relative paths resolve against `base` (default: the primary root).
   * For an existing path, symbolic links and junctions are followed and the
   * real location is checked too, so a link cannot lead outside the roots.
   */
  async resolve(input: string, options: { base?: string; mustExist?: boolean; allowRoot?: boolean } = {}): Promise<string> {
    const text = expandHome(String(input ?? '').trim().replace(/^["'«»]+|["'«»]+$/gu, ''));
    if (!text) throw new DesktopError('DESKTOP_PATH_REQUIRED', 'يلزم تحديد المسار.');
    if (/[\u0000<>|?*]/u.test(text) || text.length > 1024) throw new DesktopError('DESKTOP_PATH_INVALID', 'المسار يحتوي رموزًا غير مسموحة.');
    const base = options.base ? resolve(expandHome(options.base)) : this.primaryRoot;
    const absolute = canonical(normalize(isAbsolute(text) ? resolve(text) : resolve(base, text)));
    if (WINDOWS && /^\\\\/u.test(absolute)) throw new DesktopError('DESKTOP_PATH_NETWORK', 'مسارات الشبكة غير مسموحة.');
    if (!this.isInsideRoots(absolute)) throw new DesktopError('DESKTOP_PATH_OUTSIDE', `المسار خارج المجلدات المسموح بها: ${absolute}`, 403);
    if (!options.allowRoot && this.roots.some(root => CASE_FOLD(root) === CASE_FOLD(absolute)) && parse(absolute).root === absolute) {
      throw new DesktopError('DESKTOP_PATH_IS_DRIVE', 'لا يُنفذ الإجراء على جذر القرص نفسه.', 403);
    }
    let probe = absolute;
    let exists = true;
    try { await lstat(probe); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      exists = false;
      if (options.mustExist) throw new DesktopError('DESKTOP_PATH_NOT_FOUND', `لم أجد المسار: ${absolute}`, 404);
      probe = dirname(absolute);
      // Walk up to the nearest existing ancestor so the real location can be checked.
      for (let depth = 0; depth < 64; depth++) {
        try { await lstat(probe); break; } catch { probe = dirname(probe); }
      }
    }
    try {
      const real = await realpath(probe);
      if (!this.isInsideRoots(real)) throw new DesktopError('DESKTOP_PATH_LINK_OUTSIDE', 'المسار يشير عبر رابط إلى موقع خارج المجلدات المسموح بها.', 403);
    } catch (error) {
      if (error instanceof DesktopError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    void exists;
    return absolute;
  }

  /** A short form for replies: `~\Documents\notes.txt` instead of the full home path. */
  display(path: string): string {
    const home = homedir();
    return inside(path, home) ? `~${sep}${relative(home, path)}`.replace(new RegExp(`\\${sep}$`), '') : path;
  }
}

/** True when the text looks like a file-system path rather than a word. */
export const looksLikePath = (text: string): boolean =>
  /^(?:[A-Za-z]:[\\/]|~[\\/]?|\.{1,2}[\\/]|\\\\|\/)/u.test(text.trim()) || /[\\/][^\s\\/]+/u.test(text.trim());

export const fileNameOf = (path: string): string => basename(path);
