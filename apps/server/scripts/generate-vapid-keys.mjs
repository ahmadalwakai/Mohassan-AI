import { writeFile } from 'node:fs/promises';
import { generateVAPIDKeys } from 'web-push';

const outputFile = process.argv[2];
if (!outputFile || process.argv.length !== 3) {
  console.error('Usage: node apps/server/scripts/generate-vapid-keys.mjs <new-env-file>');
  process.exitCode = 1;
} else {
  const { publicKey, privateKey } = generateVAPIDKeys();
  try {
    await writeFile(outputFile, [
      'WEB_PUSH_VAPID_SUBJECT=',
      `WEB_PUSH_VAPID_PUBLIC_KEY=${publicKey}`,
      `WEB_PUSH_VAPID_PRIVATE_KEY=${privateKey}`,
      '',
    ].join('\n'), { flag: 'wx', mode: 0o600 });
    console.log('Wrote VAPID keys to the requested file. Set WEB_PUSH_VAPID_SUBJECT before enabling push.');
  } catch (error) {
    console.error(`Could not create the VAPID environment file (${error.code ?? 'write failed'}).`);
    process.exitCode = 1;
  }
}
