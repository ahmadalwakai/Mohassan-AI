import { SafeNetwork } from '../../browser/src/network.ts';
import { boundedGit } from './git.ts';
import { CodingError } from './security.ts';

const origin = 'https://github.com';
const network = new SafeNetwork();
const pinOption = 'http.curloptResolve';

/** Pass the address SafeNetwork checked to Git's HTTPS transport, retaining the TLS hostname. */
export async function pinnedGitNetworkConfig(cwd: string, url: string, signal?: AbortSignal): Promise<string[]> {
  const { stdout } = await boundedGit(cwd, ['help', '--config'], { signal });
  if (!stdout.split(/\r?\n/).includes(pinOption)) {
    throw new CodingError('GIT_UNAVAILABLE', 'لا يدعم إصدار Git تثبيت عنوان الشبكة لخادم المهارات.');
  }
  const { address } = await network.pin(url, [origin]);
  signal?.throwIfAborted();
  const pinned = address.family === 6 ? `[${address.address}]` : address.address;
  return [`${pinOption}=github.com:443:${pinned}`, 'http.proxy='];
}
