import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseStringsInSource } from './capability-case-string-audit.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = process.argv[1];
const args = process.argv.slice(2);
const sealedFlag = args.indexOf('--sealed');

// NODE_OPTIONS also preloads this in npm. Observe only the official runner's sealed invocation.
if (script && resolve(script) === resolve(root, 'scripts/agent-capability-bench/run.ts') && sealedFlag >= 0) {
  const sealed = resolve(args[sealedFlag + 1] ?? '');
  const readFile = fs.readFile;
  let reads = 0;
  let corpus: Buffer | undefined;
  fs.readFile = (async (...readArgs: Parameters<typeof readFile>) => {
    const [path] = readArgs;
    const result = await readFile(...readArgs);
    if (typeof path === 'string' && resolve(path) === sealed) {
      reads++;
      if (Buffer.isBuffer(result)) corpus = result;
    }
    return result;
  }) as typeof readFile;
  syncBuiltinESMExports();

  process.on('exit', code => {
    if (code !== 0) return;
    try {
      if (reads !== 1 || !corpus) throw new Error('Expected a single buffered corpus read.');
      const matches = caseStringsInSource(root, corpus);
      if (matches.length) {
        console.error(`Sealed case-string audit failed:\n${matches.join('\n')}`);
        process.exitCode = 1;
      } else {
        console.log('Sealed case-string audit passed (one corpus read).');
      }
    } catch {
      console.error('Sealed case-string audit could not verify one buffered corpus read and the source tree.');
      process.exitCode = 1;
    }
  });
}
