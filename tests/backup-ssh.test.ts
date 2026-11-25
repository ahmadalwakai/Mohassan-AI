import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const publisher = fileURLToPath(new URL('../scripts/cloud-linux/backup-publish.sh', import.meta.url));
const forcedCommand = fileURLToPath(new URL('../scripts/cloud-linux/backup-ssh-command.sh', import.meta.url));

const shell = (command: string, script: string, ...args: string[]) =>
  spawnSync('bash', ['-euc', command, 'test', script, ...args]);

const digest = (dump: Buffer) => createHash('sha256').update(dump).digest('hex');

const describeLinux = process.platform === 'linux' ? describe : describe.skip;

describeLinux('backup pull SSH protocol', () => {
  let root: string;
  let published: string;
  let group: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mohassan-ssh-pull-'));
    published = join(root, 'newest');
    mkdirSync(published);
    group = execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function publish(name: string, dump: Buffer) {
    const manifest = JSON.stringify({ sha256: digest(dump), sizeBytes: dump.length });
    const dumpPath = join(root, `${name}.dump`);
    const manifestPath = join(root, `${name}.json`);
    writeFileSync(dumpPath, dump);
    writeFileSync(manifestPath, manifest);
    const result = shell('source "$1"; publish_backup "$2" "$3" "$4" "$5"', publisher, dumpPath, manifestPath, published, group);
    expect(result.status, result.stderr.toString()).toBe(0);
    return manifest;
  }

  function request(command: string) {
    return shell('source "$1"; serve_backup "$2" "$3"', forcedCommand, command, published);
  }

  it('serves only the newest pinned pair and sends the dump bytes unchanged', () => {
    const older = 'mohassan-2026-11-24';
    const newest = 'mohassan-2026-11-25';
    const oldDump = Buffer.from([13, 37]);
    const newestDump = Buffer.from([0, 255, 13, 10, 128]);
    publish(older, oldDump);
    const manifest = publish(newest, newestDump);
    publish(newest, newestDump);

    const identifier = `${newest} ${digest(newestDump)}`;
    expect(request('list').stdout.toString()).toBe(`${identifier}\n`);
    expect(request(`dump ${identifier}`).stdout).toEqual(newestDump);
    expect(request(`manifest ${identifier}`).stdout.toString()).toBe(manifest);
    expect(readdirSync(published).sort()).toEqual(['current', `${newest}-${digest(newestDump)}`]);

    for (const command of ['', 'id', 'list; id', 'receipt', 'dump ../../etc/passwd', `dump ${older} ${digest(oldDump)}`]) {
      const refused = request(command);
      expect(refused.status).toBe(1);
      expect(refused.stdout).toHaveLength(0);
    }
  });

  it('refuses symlinked input without publishing a generation', () => {
    const pair = join(root, 'mohassan-2026-11-25');
    writeFileSync(join(root, 'unpublished-bytes'), 'fixture');
    symlinkSync(join(root, 'unpublished-bytes'), `${pair}.dump`);
    writeFileSync(`${pair}.json`, '{}');
    expect(shell('source "$1"; publish_backup "$2" "$3" "$4" "$5"', publisher, `${pair}.dump`, `${pair}.json`, published, group).status).toBe(1);
    expect(request('list').status).toBe(1);
    expect(readdirSync(published)).toEqual([]);
  });
});
