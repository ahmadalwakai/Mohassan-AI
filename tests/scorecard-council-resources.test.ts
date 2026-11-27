import { beforeEach, describe, expect, it, vi } from 'vitest';
import { directChildren } from '../scripts/scorecard/council-resources.js';

const { readdir, readFile } = vi.hoisted(() => ({
  readdir: vi.fn<() => Promise<string[]>>(),
  readFile: vi.fn<(file: string, encoding: string) => Promise<string>>(),
}));
vi.mock('node:fs/promises', () => ({ readdir, readFile }));

beforeEach(() => vi.resetAllMocks());

describe('council worker process discovery', () => {
  it('uses the kernel task child list when available', async () => {
    readFile.mockResolvedValue('37 41\n');
    expect(await directChildren(33)).toEqual(['37', '41']);
    expect(readdir).not.toHaveBeenCalled();
  });

  it('falls back to PPID and ignores vanished or inaccessible processes', async () => {
    readdir.mockResolvedValue(['37', '41', '42', '43', 'net']);
    readFile.mockImplementation(async target => {
      switch (target) {
        case '/proc/37/stat': return '37 (worker) with parens) S 33 1 1';
        case '/proc/41/stat': return '41 (unrelated) S 1 1 1';
        case '/proc/43/stat': throw Object.assign(new Error(), { code: 'EACCES' });
        default: throw Object.assign(new Error(), { code: 'ENOENT' });
      }
    });
    expect(await directChildren(33)).toEqual(['37']);
    expect(readFile).not.toHaveBeenCalledWith('/proc/net/stat', 'utf8');
  });
});
