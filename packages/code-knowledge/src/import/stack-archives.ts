import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { StackImportOptions, StackSite } from './stack-exchange.js';

const archiveBase = 'https://archive.org/download/stackexchange/';
const archiveVersion = '2024-04';
const archiveIndex = 'https://archive.org/details/stackexchange';

// The April 2024 dump was published by Stack Exchange and is pinned to archive.org's file digests.
const archiveChecksums = {
  'stackoverflow.com-Posts.7z': 'ea0b89fea1848593028a368b2bea046df9e835ef',
  'stackoverflow.com-Users.7z': '0350c00079e9a3473d5aae863cbaa7e93408c735',
  'unix.stackexchange.com.7z': '628c865b7667e093f890d76f0b0bfcfcc7ce6c1a',
  'dba.stackexchange.com.7z': '1534244d87f57f22e2d2a38a03de907a7c86e217',
  'devops.stackexchange.com.7z': 'f147fb407d7aedcee909f3a7aeacc4f7c204620a',
} as const;
type Archive = keyof typeof archiveChecksums;
const archivesBySite: Record<StackSite, readonly [Archive, Archive]> = {
  stackoverflow: ['stackoverflow.com-Posts.7z', 'stackoverflow.com-Users.7z'],
  unix: ['unix.stackexchange.com.7z', 'unix.stackexchange.com.7z'],
  dba: ['dba.stackexchange.com.7z', 'dba.stackexchange.com.7z'],
  devops: ['devops.stackexchange.com.7z', 'devops.stackexchange.com.7z'],
};

async function verify(path: string, archive: Archive): Promise<void> {
  const hash = createHash('sha1');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  if (hash.digest('hex') !== archiveChecksums[archive]) {
    throw new Error('Checksum mismatch for ' + archive + ', expected the Stack Exchange April 2024 dump');
  }
}

async function download(directory: string, archive: Archive): Promise<string> {
  const path = join(directory, archive);
  const exists = await stat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (exists) {
    await verify(path, archive);
    return path;
  }

  const staging = path + '.' + randomUUID() + '.partial';
  const response = await fetch(archiveBase + archive, { signal: AbortSignal.timeout(7_200_000) });
  if (response.status !== 200 || !response.body) throw new Error('HTTP ' + response.status + ' downloading ' + archive);
  try {
    // Node's native fetch body is a Node WHATWG stream. The repo also includes the DOM stream declarations.
    const body = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
    await pipeline(body, createWriteStream(staging, { flags: 'wx' }));
    await verify(staging, archive);
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
  return path;
}

function openMember(executable: string, archive: string, member: string): () => Readable {
  return () => Readable.from((async function* () {
    const child = spawn(executable, ['x', '-so', '-bso0', '-bsp0', archive, member], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.resume();
    const completion = new Promise<Error | undefined>(resolve => {
      child.once('error', error => resolve(error));
      child.once('close', (status, signal) => resolve(status === 0 ? undefined : new Error('7-Zip failed reading ' + member + ' (' + (signal ?? status) + ')')));
    });
    try {
      for await (const bytes of child.stdout) yield bytes;
      const failure = await completion;
      if (failure) throw failure;
    } finally {
      if (!child.stdout.readableEnded) child.kill();
      await completion;
    }
  })());
}

export async function downloadStackArchive(site: StackSite, cache: string, sevenZip = '7zz'): Promise<StackImportOptions> {
  const [posts, users] = archivesBySite[site];
  const postsPath = await download(cache, posts);
  const usersPath = posts === users ? postsPath : await download(cache, users);
  return {
    site, version: 'Stack Exchange April 2024 (' + archiveVersion + ')', sourceUrl: archiveIndex,
    posts: openMember(sevenZip, postsPath, 'Posts.xml'), users: openMember(sevenZip, usersPath, 'Users.xml'),
  };
}
