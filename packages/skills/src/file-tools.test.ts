import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileToolAdapters } from './file-tools.ts';
import { sha256 } from './hash.ts';
import type { SkillToolContext } from './gateway.ts';

const adapters = createFileToolAdapters(), reader = adapters[0], writer = adapters[1];
const directories: string[] = [];
async function fixture() {
  const created = await mkdtemp(join(tmpdir(), 'mohassan-skill-files-')); directories.push(created);
  const root = await realpath(created);
  const events: string[] = [];
  const context: SkillToolContext = {
    ownerId: 'owner', runId: 'run', nodeId: 'node', taskId: 'task', leaseToken: 'lease', versionId: 'version', contentHash: 'a'.repeat(64),
    signal: new AbortController().signal, idempotencyKey: 'node:1', grantRoots: [root], declaredPaths: ['report.txt'],
    assertActive: vi.fn(async () => { events.push('active'); }), acquireResource: vi.fn(async () => { events.push('lock'); }),
    savePreimage: vi.fn(async () => { events.push('preimage'); }), recordUsage: vi.fn(async () => {}),
  };
  return {root, context, events};
}
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const safe = resolve(directory), parent = resolve(tmpdir()) + sep;
    if (!safe.startsWith(parent) || !safe.includes('mohassan-skill-files-')) throw new Error('unsafe cleanup');
    await rm(safe, {recursive: true, force: true});
  }
});

describe('authorized file adapters', () => {
  it('creates and independently verifies a real UTF-8 file, preserving its preimage before dispatch', async () => {
    const {root, context, events} = await fixture();
    const input = {root, path: 'report.txt', content: 'تقرير من موقع اختبار محلي', expectedHash: null};
    const output = await writer.execute(input, context);
    expect(await readFile(join(root, 'report.txt'), 'utf8')).toBe(input.content);
    expect(context.savePreimage).toHaveBeenCalledWith({root, path: input.path, before: null, beforeHash: null, afterHash: sha256(input.content)});
    expect(events.indexOf('lock')).toBeLessThan(events.indexOf('preimage'));
    expect(await writer.verify(input, output, context)).toBe(true);
    expect(await readdir(root)).toEqual(['report.txt']);
    const read = await reader.execute({root, path: 'report.txt'}, context);
    expect(read.content).toBe(input.content);
    expect(await reader.verify({root, path: 'report.txt'}, read, context)).toBe(true);
    await writeFile(join(root, 'report.txt'), 'changed');
    expect(await writer.verify(input, output, context)).toBe(false);
    expect(await reader.verify({root, path: 'report.txt'}, read, context)).toBe(false);
  });
  it('replaces only an approved expected version and records the actual previous text', async () => {
    const {root, context} = await fixture(); await writeFile(join(root, 'report.txt'), 'before');
    const input = {root, path: 'report.txt', content: 'after', expectedHash: sha256('before')};
    const output = await writer.execute(input, context);
    expect(context.savePreimage).toHaveBeenCalledWith({root, path: 'report.txt', before: 'before', beforeHash: sha256('before'), afterHash: sha256('after')});
    expect(await writer.verify(input, output, context)).toBe(true);
    await expect(writer.execute(input, context)).rejects.toMatchObject({code: 'SKILL_FILE_CONFLICT'});
    expect(await readdir(root)).toEqual(['report.txt']);
  });
  it.each(['../escape.txt', '/escape.txt', 'C:/escape.txt', 'report.txt:secret', 'con.txt', '.env', 'credentials.json'])('rejects unsafe path %s before reading', async path => {
    const {root, context} = await fixture();
    context.declaredPaths = [path];
    await expect(reader.execute({root, path}, context)).rejects.toBeDefined();
    expect(context.acquireResource).not.toHaveBeenCalled();
  });
  it('does not borrow root permissions from another grant and rejects undeclared paths', async () => {
    const first = await fixture(), second = await fixture();
    await expect(writer.execute({root: second.root, path: 'report.txt', content: 'x', expectedHash: null}, first.context)).rejects.toBeDefined();
    await expect(writer.execute({root: first.root, path: 'other.txt', content: 'x', expectedHash: null}, first.context)).rejects.toMatchObject({code: 'SKILL_FILE_UNDECLARED'});
    first.context.declaredPaths = [];
    await expect(reader.execute({root: first.root, path: 'report.txt'}, first.context)).rejects.toMatchObject({code: 'SKILL_FILE_UNDECLARED'});
  });
  it('rejects Windows superscript device aliases for both file adapters before acquiring a resource', async () => {
    const {root, context} = await fixture();
    for (const path of ['COM¹.txt', 'COM².txt', 'COM³.txt', 'LPT¹.txt', 'LPT².txt', 'LPT³.txt']) {
      context.declaredPaths = [path];
      await expect(reader.execute({root, path}, context)).rejects.toMatchObject({code: 'UNSAFE_PATH'});
      await expect(writer.execute({root, path, content: 'fixture', expectedHash: null}, context)).rejects.toMatchObject({code: 'UNSAFE_PATH'});
    }
    expect(context.acquireResource).not.toHaveBeenCalled(); expect(context.savePreimage).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
  it('cannot shift the contract path by selecting a sensitive subdirectory as root', async () => {
    const {root, context} = await fixture(); await mkdir(join(root, 'secrets'));
    await writeFile(join(root, 'secrets', 'report.txt'), 'sensitive fixture without credential pattern');
    await expect(reader.execute({root: join(root, 'secrets'), path: 'report.txt'}, context)).rejects.toMatchObject({code: 'SKILL_FILE_ROOT_MISMATCH'});
  });
  it.each(['\0binary', 'ع'.repeat(40_000), '-----BEGIN PRIVATE KEY-----'])('rejects binary, oversized UTF-8, and credential content', async content => {
    const {root, context} = await fixture();
    await expect(writer.execute({root, path: 'report.txt', content, expectedHash: null}, context)).rejects.toMatchObject({code: 'SKILL_FILE_CONTENT_REJECTED'});
    expect(await readdir(root)).toEqual([]);
  });
  it('rejects hard links before exposing or replacing their contents', async () => {
    const {root, context} = await fixture(); await writeFile(join(root, 'original.txt'), 'private fixture');
    await link(join(root, 'original.txt'), join(root, 'report.txt'));
    await expect(reader.execute({root, path: 'report.txt'}, context)).rejects.toMatchObject({code: 'UNSUPPORTED_FILE'});
    await expect(writer.execute({root, path: 'report.txt', content: 'replacement', expectedHash: sha256('private fixture')}, context)).rejects.toMatchObject({code: 'UNSUPPORTED_FILE'});
    expect(await readFile(join(root, 'original.txt'), 'utf8')).toBe('private fixture');
  });
  it('rejects a junction to another root', async () => {
    const {root, context} = await fixture(), outside = await fixture();
    await symlink(outside.root, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    context.declaredPaths = ['linked'];
    await expect(writer.execute({root, path: 'linked/report.txt', content: 'x', expectedHash: null}, context)).rejects.toMatchObject({code: 'SYMLINK_REJECTED'});
    expect(await readdir(outside.root)).toEqual([]);
  });
  it('does not write if authority is revoked after the durable preimage', async () => {
    const {root, context} = await fixture(); await writeFile(join(root, 'report.txt'), 'before');
    let revoked = false;
    context.savePreimage = async () => { revoked = true; };
    context.assertActive = async () => { if (revoked) throw new Error('revoked'); };
    await expect(writer.execute({root, path: 'report.txt', content: 'after', expectedHash: sha256('before')}, context)).rejects.toThrow('revoked');
    expect(await readFile(join(root, 'report.txt'), 'utf8')).toBe('before');
    expect(await readdir(root)).toEqual(['report.txt']);
  });
  it('does not write after cancellation or a conflicting resource owner', async () => {
    const {root, context} = await fixture(); context.acquireResource = async () => { throw new Error('busy'); };
    const input = {root, path: 'report.txt', content: 'after', expectedHash: null};
    await expect(writer.execute(input, context)).rejects.toThrow('busy');
    context.signal = AbortSignal.abort();
    await expect(writer.execute(input, context)).rejects.toBeDefined();
    expect(await readdir(root)).toEqual([]);
  });
});
