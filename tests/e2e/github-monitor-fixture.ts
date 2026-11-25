import { SafeNetwork, type SafeResponse } from '@mohassan/browser';
import pull from '../fixtures/monitors/github-pull.json' with { type: 'json' };

export function installGitHubMonitorFixture() {
  process.env.MOHASSAN_MONITORS_ENABLED = '1';
  process.env.MOHASSAN_MONITORS_V2 = '1';
  process.env.MOHASSAN_MONITORS_GITHUB = '1';

  SafeNetwork.prototype.request = async function (address, options = {}): Promise<SafeResponse> {
    const url = this.validate(address, options.allowedOrigins);
    const headers = new Headers(options.headers);
    if ((options.method ?? 'GET') !== 'GET' || options.body || headers.has('authorization') || headers.has('cookie')
      || headers.has('proxy-authorization')) {
      throw new Error('Expected a credential-free GitHub read');
    }
    options.signal?.throwIfAborted();
    await options.beforeDispatch?.();
    options.signal?.throwIfAborted();
    if (url.href === 'https://api.github.com/robots.txt') {
      return { status: 200, url: url.href, headers: { 'content-type': 'text/plain' }, body: Buffer.from('User-agent: *\nAllow: /') };
    }
    if (url.href === 'https://api.github.com/repos/owner/repo/pulls/42') {
      if (!headers.get('accept')?.includes('application/vnd.github+json')) throw new Error('Expected the GitHub REST media type');
      return { status: 200, url: url.href, headers: { 'content-type': 'application/json', etag: '"pull-open"' },
        body: Buffer.from(JSON.stringify(pull)) };
    }
    throw new Error('No offline network fixture for the requested source');
  };
}
