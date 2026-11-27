import { readdir, readFile } from 'node:fs/promises';

function unavailable(error: unknown): boolean {
  return ['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '');
}

export async function processFields(pid: number | string) {
  const value = await readFile(`/proc/${pid}/stat`, 'utf8');
  // After the closing comm parenthesis, fields 3 and 4 are state and PPID.
  // https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html (retrieved 2026-11-27).
  return value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/u);
}

export async function directChildren(parent: number): Promise<string[]> {
  try {
    const children = await readFile(`/proc/${parent}/task/${parent}/children`, 'utf8');
    return children.trim().split(/\s+/u).filter(Boolean);
  } catch (error) {
    if (!unavailable(error)) throw error;
  }
  // Some kernels omit the task `children` file. Compare PPID instead.
  const pids = (await readdir('/proc')).filter(entry => /^\d+$/u.test(entry));
  const found = await Promise.all(pids.map(async pid => {
    try {
      return Number((await processFields(pid))[1]) === parent ? pid : null;
    } catch (error) {
      if (!unavailable(error)) throw error;
      return null;
    }
  }));
  return found.filter((pid): pid is string => pid !== null);
}
