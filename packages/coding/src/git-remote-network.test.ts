import { lookup } from 'node:dns/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { boundedGit } from './git.ts';
import { remoteFetch, remoteHead } from './git-remote.ts';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('./git.ts', () => ({ boundedGit: vi.fn() }));

const git = vi.mocked(boundedGit);
const dns = vi.mocked(lookup);
const commit = 'a'.repeat(40);
const capabilities = 'http.curloptResolve\nhttp.followRedirects\n';
const operations = [remoteHead, remoteFetch];

function setupGit(supportsPin = true) {
  git.mockImplementation(async (_dir, command) => ({ stdout: command[0] === 'help' ? (supportsPin ? capabilities : 'http.followRedirects\n')
    : command[0] === 'ls-remote' ? `${commit}\trefs/heads/main\n` : `${commit}\n`, stderr: '', exitCode: 0 }));
}

describe('remote skill Git transport', () => {
  beforeEach(() => { vi.resetAllMocks(); setupGit(); });

  it.each(operations)('passes the checked address and blocks implicit redirects in %p', async operation => {
    dns.mockResolvedValue([{ address: '2606:4700::1111', family: 6 }]);
    await expect(operation('/fixture', 'owner/repo', 'main')).resolves.toBe(commit);
    expect(dns).toHaveBeenCalledWith('github.com', { all: true, verbatim: true });
    const dispatch = git.mock.calls.find(([, command]) => ['fetch', 'ls-remote'].includes(command[0]));
    expect(dispatch?.[1]).toContain('https://github.com/owner/repo.git');
    expect(dispatch?.[2]?.extraConfig).toEqual(expect.arrayContaining([
      'http.curloptResolve=github.com:443:[2606:4700::1111]', 'http.followRedirects=false', 'http.proxy=',
    ]));
  });

  it.each(operations)('rejects a denied resolver result before invoking network Git in %p', async operation => {
    dns.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(operation('/fixture', 'owner/repo', 'main')).rejects.toMatchObject({ code: 'GIT_REMOTE_UNREACHABLE' });
    expect(git.mock.calls.some(([, command]) => ['fetch', 'ls-remote'].includes(command[0]))).toBe(false);
  });

  it('refuses to invoke network Git when the executable lacks address pinning', async () => {
    setupGit(false);
    dns.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    await expect(remoteHead('/fixture', 'owner/repo', 'main')).rejects.toMatchObject({ code: 'GIT_UNAVAILABLE' });
    expect(git.mock.calls.map(([, command]) => command)).toEqual([['help', '--config']]);
  });
});
