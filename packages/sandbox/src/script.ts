import { createHash } from 'node:crypto';
import { realpath as jsRealpath } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { SandboxFile, SandboxTestResult } from './index.ts';

export const sandboxScriptLimits = Object.freeze({ inputBytes: 65536, outputBytes: 1048576, outputFiles: 32, entries: 128, depth: 8 });
export interface SandboxScriptInput { files: SandboxFile[]; entry: string; inputJson: string; signal?: AbortSignal; timeoutMs?: number; memoryMb?: number; outputMaxBytes?: number }
export interface SandboxOutputFile { path: string; content: string; bytes: number; sha256: string }
export interface SandboxScriptResult extends SandboxTestResult { outputs: SandboxOutputFile[]; outputManifestHash: string }
export class SandboxOutputError extends Error { readonly code = 'SANDBOX_OUTPUT_REJECTED'; }
// The JavaScript resolver walks links with lstat. The native one fails on a folder that is a
// volume mount point, which is where quota outputs live; junctions and symlinks are still resolved.
const realpath = promisify(jsRealpath);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fail = (message: string): never => { throw new SandboxOutputError(message); };
export function safeSandboxPath(path: string): boolean {
  return typeof path === 'string' && path.length <= 240 && /^[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)*$/u.test(path)
    && !path.split('/').some(part => ['.', '..', '.git', '.data', 'node_modules'].includes(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part) || part.endsWith('.') || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part));
}
const Schema = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() }).strict()).min(1).max(99), entry: z.string(), inputJson: z.string(),
  signal: z.custom<AbortSignal>(value => value instanceof AbortSignal).optional(), timeoutMs: z.number().int().min(100).max(20000).optional(),
  memoryMb: z.number().int().min(16).max(512).optional(), outputMaxBytes: z.number().int().min(1).max(sandboxScriptLimits.outputBytes).optional(),
}).strict();
export function validateSandboxScript(raw: SandboxScriptInput): SandboxScriptInput {
  const input = Schema.parse(raw);
  if (new Set(input.files.map(file => file.path.toLowerCase())).size !== input.files.length || input.files.some(file => !safeSandboxPath(file.path) || file.path.toLowerCase() === '.mohassan-input.json') || input.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), Buffer.byteLength(input.inputJson)) > 512 * 1024) fail('Invalid or excessive script snapshot.');
  if (!safeSandboxPath(input.entry) || !/\.(mjs|cjs|js)$/.test(input.entry) || !input.files.some(file => file.path === input.entry)) fail('The fixed JavaScript entry must exist in the snapshot.');
  if (Buffer.byteLength(input.inputJson) > sandboxScriptLimits.inputBytes) fail('Script input exceeds the JSON byte bound.');
  const data: unknown = JSON.parse(input.inputJson);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) fail('Script input must be a JSON object.');
  let nodes = 0; const queue: { value: unknown; depth: number }[] = [{ value: data, depth: 0 }];
  while (queue.length) {
    const { value, depth } = queue.pop()!;
    if (++nodes > 4096 || depth > 16) fail('Script input exceeds its structural bound.');
    if (typeof value === 'number' && !Number.isFinite(value)) fail('Script input contains a non-finite number.');
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { if (['__proto__', 'prototype', 'constructor'].includes(key) || key.length > 256) fail('Script input contains an unsupported key.'); queue.push({ value: child, depth: depth + 1 }); }
  }
  return input;
}
const samePath = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

/** Called only after the native Job and all its processes have terminated.
 * This reads a private output directory; it never publishes into a user root. */
export async function collectSandboxOutputs(directory: string, maxBytes: number = sandboxScriptLimits.outputBytes): Promise<{ outputs: SandboxOutputFile[]; outputManifestHash: string }> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > sandboxScriptLimits.outputBytes) fail('Invalid output byte limit.');
  const root = resolve(directory), rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !samePath(await realpath(root), root)) fail('Output root is not a canonical directory.');
  const outputs: SandboxOutputFile[] = [], names = new Set<string>(); let entries = 0, total = 0;
  async function walk(current: string, prefix: string, depth: number): Promise<void> {
    if (depth > sandboxScriptLimits.depth) fail('Output nesting exceeds its limit.');
    const listing = await opendir(current);
    for await (const entry of listing) {
      if (++entries > sandboxScriptLimits.entries) fail('Output directory exceeds its entry limit.');
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, absolute = join(current, entry.name);
      if (!safeSandboxPath(path) || names.has(path.toLowerCase())) fail('Unsafe or colliding output path.'); names.add(path.toLowerCase());
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || !samePath(await realpath(absolute), absolute)) fail('Output links are forbidden.');
      if (info.isDirectory()) { await walk(absolute, path, depth + 1); continue; }
      if (!info.isFile() || info.nlink !== 1 || outputs.length >= sandboxScriptLimits.outputFiles || info.size > maxBytes - total) fail('Output type, link count or size exceeds its limit.');
      const handle = await open(absolute, 'r');
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size) fail('Output changed while opening.');
        // Never call unbounded readFile on an untrusted-sized artifact.
        const buffer = Buffer.alloc(before.size + 1); let length = 0;
        while (length < buffer.length) { const chunk = await handle.read(buffer, length, buffer.length - length, length); if (!chunk.bytesRead) break; length += chunk.bytesRead; }
        const after = await handle.stat(), named = await lstat(absolute);
        if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1 || named.ino !== before.ino || named.dev !== before.dev || named.isSymbolicLink()) fail('Output changed during collection.');
        const bytes = buffer.subarray(0, length); if (bytes.includes(0)) fail('Binary output is unsupported.');
        let content: string; try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return fail('Output must contain valid UTF-8.'); }
        total += length; outputs.push({ path, content, bytes: length, sha256: digest(bytes) });
      } finally { await handle.close(); }
    }
  }
  await walk(root, '', 0); outputs.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (Buffer.byteLength(JSON.stringify(outputs)) > sandboxScriptLimits.outputBytes) fail('Output receipt exceeds its wire byte limit.');
  return { outputs, outputManifestHash: digest(JSON.stringify(outputs.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })))) };
}
