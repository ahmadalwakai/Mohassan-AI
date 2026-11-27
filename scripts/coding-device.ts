import { runCodingDeviceFromDesktop } from '@mohassan/coding-link/bootstrap';

const shutdown = new AbortController();
process.once('SIGINT', () => shutdown.abort());
process.once('SIGTERM', () => shutdown.abort());

try {
  await runCodingDeviceFromDesktop({
    platform: process.platform, localAppData: process.env.LOCALAPPDATA,
    input: process.stdin, output: process.stdout, signal: shutdown.signal,
  });
} catch {
  process.stderr.write('تعذر بدء محرك البرمجة على هذا الجهاز.\n');
  process.exitCode = 1;
} finally {
  process.stdin.destroy();
}
