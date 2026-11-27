import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getModelEntry } from '../packages/model-relations/src/registry.js';

const script = fileURLToPath(new URL('../scripts/cloud-linux/install-model-store.sh', import.meta.url));
const packTool = fileURLToPath(new URL('../scripts/models/pack-store.mjs', import.meta.url));
const checkout = fileURLToPath(new URL('../', import.meta.url));
const weights = 'artifacts/test model/current.bin';
const otherWeights = 'artifacts/another model/current.bin';
const ocrWeights = 'weights.bin';
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const describeLinux = process.platform === 'linux' ? describe : describe.skip;

type FixtureFile = { area: 'models' | 'ocr'; path: string; contents: string };

describeLinux('model store installer', () => {
  let root: string;
  let live: string;
  let bundle: string;
  let checker: string;
  let group: string;
  let gid: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'model-store-install-'));
    live = join(root, 'models');
    bundle = join(root, 'upload');
    checker = join(root, 'registry-check.mjs');
    group = execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim();
    gid = Number(execFileSync('id', ['-g'], { encoding: 'utf8' }).trim());
    writeFileSync(checker, `
      import { createHash } from 'node:crypto';
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      const [, , , manifest, , models, , ocr] = process.argv;
      const registry = ${JSON.stringify({ models: [weights, otherWeights], ocr: [ocrWeights] })};
      for (const { area, path, sha256 } of JSON.parse(readFileSync(manifest)).files) {
        if (!registry[area].includes(path)) throw new Error('Unknown registry path: ' + path);
        const staged = readFileSync(join(area === 'ocr' ? ocr : models, path));
        if (sha256 !== createHash('sha256').update(staged).digest('hex')) throw new Error('Wrong staged hash.');
      }
    `);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function write(path: string, bytes: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }

  function upload(...fixtures: FixtureFile[]) {
    const files = fixtures.map(({ area, path, contents }) => {
      write(join(bundle, 'files', area, path), contents);
      return { area, path, sizeBytes: Buffer.byteLength(contents), sha256: digest(contents) };
    });
    const manifest = JSON.stringify({ schemaVersion: 1, files, totalBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0) });
    write(join(bundle, 'manifest.json'), manifest);
    return digest(manifest);
  }

  function shell(...args: string[]) {
    return spawnSync('bash', ['-euc', 'source "$1"; shift; install_model_store "$@"', 'test', script, group, process.execPath, checker, ...args], { encoding: 'utf8' });
  }

  function install(manifestDigest: string, ...args: string[]) {
    return shell('install', bundle, '--store', live, '--manifest-sha256', manifestDigest, ...args);
  }

  function previous(directory: string) {
    const prefix = `${directory.split('/').at(-1)}.previous-`;
    const backups = readdirSync(root).filter(path => path.startsWith(prefix));
    expect(backups).toHaveLength(1);
    return join(root, backups[0]!);
  }

  function expectPermissions(path: string, mode: number) {
    const info = statSync(path);
    expect(info.mode & 0o777).toBe(mode);
    expect(info.uid).toBe(process.geteuid!());
    expect(info.gid).toBe(gid);
  }

  it('exchanges the live directory, adds files without dropping existing models, and rolls back by exchange', () => {
    write(join(live, weights), 'original');
    const oldStore = statSync(live);
    const openReader = openSync(join(live, weights), 'r');
    try {
      const result = install(upload({ area: 'models', path: otherWeights, contents: 'new file' }));
      expect(result.status, result.stderr).toBe(0);
      const backup = previous(live);
      expect(result.stdout).toContain(backup);
      expect(statSync(backup).ino).toBe(oldStore.ino);
      expect(statSync(live).ino).not.toBe(oldStore.ino);
      expect(readFileSync(openReader, 'utf8')).toBe('original');
      expect(readFileSync(join(live, weights), 'utf8')).toBe('original');
      expect(readFileSync(join(live, otherWeights), 'utf8')).toBe('new file');
      expectPermissions(live, 0o750);
      expectPermissions(dirname(join(live, otherWeights)), 0o750);
      expectPermissions(join(live, weights), 0o640);
      expectPermissions(join(live, otherWeights), 0o640);

      const rollback = shell('rollback', backup, '--store', live);
      expect(rollback.status, rollback.stderr).toBe(0);
      expect(statSync(live).ino).toBe(oldStore.ino);
      expect(existsSync(join(live, otherWeights))).toBe(false);
      expect(readFileSync(join(backup, otherWeights), 'utf8')).toBe('new file');
    } finally {
      closeSync(openReader);
    }
  });

  it('publishes an initial model store with OCR in the canonical subdirectory', () => {
    const result = install(upload({ area: 'ocr', path: ocrWeights, contents: 'OCR export' }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('Previous');
    expect(readFileSync(join(live, 'artifacts/vision/ocr-v1', ocrWeights), 'utf8')).toBe('OCR export');
  });

  it('keeps older backups across later installs and refuses rollback outside the store siblings', () => {
    write(join(live, weights), 'first');
    const initial = install(upload({ area: 'models', path: weights, contents: 'second' }));
    expect(initial.status, initial.stderr).toBe(0);
    const first = previous(live);
    const next = install(upload({ area: 'models', path: weights, contents: 'third' }));
    expect(next.status, next.stderr).toBe(0);
    expect(readFileSync(join(first, weights), 'utf8')).toBe('first');
    expect(readdirSync(root).filter(name => name.startsWith('models.previous-'))).toHaveLength(2);
    const refused = shell('rollback', bundle, '--store', live);
    expect(refused.status).toBe(1);
    expect(readFileSync(join(live, weights), 'utf8')).toBe('third');
  });

  it('checks both roots before exchanging either and retains both previous stores', () => {
    const ocr = join(root, 'ocr');
    write(join(live, weights), 'old weights');
    write(join(ocr, ocrWeights), 'old OCR');
    const modelBefore = statSync(live).ino;
    const ocrBefore = statSync(ocr).ino;
    const receipt = upload(
      { area: 'models', path: weights, contents: 'new weights' },
      { area: 'ocr', path: ocrWeights, contents: 'new OCR' },
    );
    write(join(bundle, 'files', 'ocr', ocrWeights), 'bad OCR');
    const rejected = install(receipt, '--ocr-dir', ocr);
    expect(rejected.status, rejected.stderr).toBe(1);
    expect(rejected.stderr).toContain('SHA-256 mismatch');
    expect(readdirSync(root).sort()).toEqual(['models', 'ocr', 'registry-check.mjs', 'upload']);
    expect(statSync(live).ino).toBe(modelBefore);
    expect(statSync(ocr).ino).toBe(ocrBefore);

    write(join(bundle, 'files', 'ocr', ocrWeights), 'new OCR');
    const applied = install(receipt, '--ocr-dir', ocr);
    expect(applied.status, applied.stderr).toBe(0);
    expect(readFileSync(join(live, weights), 'utf8')).toBe('new weights');
    expect(readFileSync(join(ocr, ocrWeights), 'utf8')).toBe('new OCR');
    expect(statSync(previous(live)).ino).toBe(modelBefore);
    expect(statSync(previous(ocr)).ino).toBe(ocrBefore);
  });

  it('refuses a changed manifest, extra files, symlinks, hard links and traversal', () => {
    const receipt = upload({ area: 'models', path: weights, contents: 'fixture' });
    const payload = join(bundle, 'files', 'models');
    const verifiedFile = join(payload, weights);
    expect(install(digest('different manifest')).stderr).toContain('manifest SHA-256');

    const extra = join(payload, 'extra');
    write(extra, 'extra file');
    expect(install(receipt).stderr).toContain('Uploaded paths or sizes');
    rmSync(extra);
    rmSync(verifiedFile);

    const external = join(root, 'outside');
    write(external, 'fixture');
    symlinkSync(external, verifiedFile);
    expect(install(receipt).stderr).toContain('ordinary file or directory');
    rmSync(verifiedFile);
    linkSync(external, verifiedFile);
    expect(install(receipt).stderr).toContain('ordinary file or directory');

    const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
    manifest.files[0].path = '../../outside';
    const edited = JSON.stringify(manifest);
    write(join(bundle, 'manifest.json'), edited);
    expect(install(digest(edited)).stderr).toContain('Invalid relative path');
    expect(existsSync(live)).toBe(false);
  });

  it('does not publish an otherwise valid upload with a path outside the registry', () => {
    const result = install(upload({ area: 'models', path: 'unexpected.bin', contents: 'unregistered' }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown registry path');
    expect(existsSync(live)).toBe(false);
    expect(readdirSync(root).sort()).toEqual(['registry-check.mjs', 'upload']);
  });

  it('accepts a pinned bundle produced and verified by the real registry tools', () => {
    const source = join(root, 'source');
    const artifact = getModelEntry('refusal')!.artifacts[0]!;
    const bytes = readFileSync(join(checkout, artifact.path));
    write(join(source, artifact.path), bytes.toString('utf8'));
    const pack = spawnSync(process.execPath, [packTool, '--root', source, '--out', bundle, '--write'], { encoding: 'utf8' });
    expect(pack.status, pack.stderr).toBe(0);
    checker = packTool;
    const result = install(digest(readFileSync(join(bundle, 'manifest.json'))));
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(live, artifact.path))).toEqual(bytes);
  });
});
