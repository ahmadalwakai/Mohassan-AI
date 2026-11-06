import { open, lstat, realpath, rename, unlink, link } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertNoLinks, boundedText, canonicalDirectory, containsPath, credentialLike, safeRelative, sensitivePath } from '@mohassan/coding/security';
import { SkillError } from './errors.ts';
import { sha256 } from './hash.ts';
import type { SkillToolAdapter, SkillToolContext } from './gateway.ts';

const MAX_BYTES = 64_000;
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const FileInput = z.object({ root: z.string().min(3).max(1000), path: z.string().min(1).max(180) }).strict();
const WriteInput = FileInput.extend({ content: z.string().max(MAX_BYTES), expectedHash: Hash.nullable() }).strict();
const FileOutput = z.object({ root: z.string(), path: z.string(), content: z.string(), hash: Hash, bytes: z.number().int().nonnegative().max(MAX_BYTES) }).strict();
const WriteOutput = z.object({ root: z.string(), path: z.string(), hash: Hash, bytes: z.number().int().nonnegative().max(MAX_BYTES), previousHash: Hash.nullable() }).strict();
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

async function target(input: {root: string; path: string}, context: SkillToolContext) {
  context.signal.throwIfAborted();
  const path = safeRelative(input.path);
  if (sensitivePath(path)) throw new SkillError('SKILL_FILE_SENSITIVE', 'لا تسمح أداة الملفات بالمسارات الحساسة.', 403);
  if (!context.declaredPaths.length || !context.declaredPaths.some(scope => path === scope || path.startsWith(`${scope}/`))) {
    throw new SkillError('SKILL_FILE_UNDECLARED', 'مسار الملف غير مصرح به في عقد المهارة.', 403);
  }
  const root = await canonicalDirectory(input.root, context.grantRoots);
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const granted = await Promise.all(context.grantRoots.map(value => realpath(value)));
  if (!granted.some(value => normalize(value) === normalize(root))) throw new SkillError('SKILL_FILE_ROOT_MISMATCH', 'يجب أن يطابق الجذر مجلداً ممنوحاً صراحة؛ المسار نسبي إلى ذلك المجلد.', 403);
  const absolute = join(root, ...path.split('/'));
  await assertNoLinks(absolute);
  // Parents must already exist; a write never creates an unreviewed directory tree.
  const parent = await realpath(dirname(absolute));
  if (!containsPath(root, parent)) throw new SkillError('SKILL_FILE_OUTSIDE_ROOT', 'الملف خارج المجلد المصرح به.', 403);
  return { root, path, absolute };
}

async function current(path: string): Promise<string | null> {
  try { return await boundedText(path, MAX_BYTES); }
  catch (error) { if (missing(error)) return null; throw error; }
}
const digest = (text: string | null) => text === null ? null : sha256(text);
const resourceKey = (path: string) => sha256(`file:${process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)}`);

/** Trusted host adapters for approved text files, not a sandbox for imported code.
 * DB resource ownership serializes cooperating workers. A malicious local process
 * with write access to the same directory remains outside this JS path boundary. */
export function createFileToolAdapters(): SkillToolAdapter[] {
  return [{
    id: 'file.read', input: FileInput, output: FileOutput,
    async execute(raw, context) {
      const input = FileInput.parse(raw), file = await target(input, context);
      await context.acquireResource(resourceKey(file.absolute));
      await context.assertActive();
      const content = await current(file.absolute);
      if (content === null) throw new SkillError('SKILL_FILE_NOT_FOUND', 'الملف المطلوب غير موجود.', 404);
      context.signal.throwIfAborted();
      return {root: file.root, path: file.path, content, hash: sha256(content), bytes: Buffer.byteLength(content, 'utf8')};
    },
    async verify(raw, result, context) {
      const input = FileInput.parse(raw), output = FileOutput.parse(result), file = await target(input, context);
      const content = await current(file.absolute);
      return content !== null && output.root === file.root && output.path === file.path && output.content === content
        && output.hash === sha256(content) && output.bytes === Buffer.byteLength(content, 'utf8');
    },
  }, {
    id: 'file.write', input: WriteInput, output: WriteOutput,
    async execute(raw, context) {
      const input = WriteInput.parse(raw);
      if (Buffer.byteLength(input.content, 'utf8') > MAX_BYTES || input.content.includes('\0') || credentialLike(input.content)) {
        throw new SkillError('SKILL_FILE_CONTENT_REJECTED', 'محتوى الملف غير مسموح أو يتجاوز حد النص.');
      }
      const file = await target(input, context);
      await context.acquireResource(resourceKey(file.absolute));
      await context.assertActive();
      const before = await current(file.absolute), beforeHash = digest(before), afterHash = sha256(input.content);
      if (beforeHash !== input.expectedHash) throw new SkillError('SKILL_FILE_CONFLICT', 'تغير الملف عن النسخة المعتمدة؛ يلزم طلب جديد.', 409);
      await context.savePreimage({root: file.root, path: file.path, before, beforeHash, afterHash});
      await context.assertActive();
      // Exclusive staging never follows an existing path. Recheck the destination
      // immediately before the atomic rename; no partial text is exposed.
      const staging = join(dirname(file.absolute), `.mohassan-${randomUUID()}.tmp`);
      let staged = false;
      try {
        const handle = await open(staging, 'wx', 0o600); staged = true;
        try { await handle.writeFile(input.content, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        await target(input, context);
        if (digest(await current(file.absolute)) !== beforeHash) throw new SkillError('SKILL_FILE_CONFLICT', 'تغير الملف قبل الكتابة.', 409);
        await context.assertActive(); context.signal.throwIfAborted();
        // An exclusive hard-link publish exposes the fully synced staging file
        // atomically and cannot overwrite a newly appeared unrelated file.
        if (before === null) {
          await link(staging, file.absolute);
          await unlink(staging); staged = false;
        } else {
          const info = await lstat(file.absolute);
          if (!info.isFile() || info.nlink !== 1 || info.isSymbolicLink()) throw new SkillError('SKILL_FILE_UNSAFE', 'الملف ليس ملفاً عادياً منفرداً.', 403);
          await rename(staging, file.absolute); staged = false;
        }
        const actual = await current(file.absolute);
        if (digest(actual) !== afterHash) throw new SkillError('SKILL_FILE_VERIFY_FAILED', 'تعذر إثبات نتيجة الكتابة.', 409);
        return {root: file.root, path: file.path, hash: afterHash, bytes: Buffer.byteLength(input.content, 'utf8'), previousHash: beforeHash};
      } finally {
        if (staged) await unlink(staging).catch(error => { if (!missing(error)) throw error; });
      }
    },
    async verify(raw, result, context) {
      const input = WriteInput.parse(raw), output = WriteOutput.parse(result), file = await target(input, context);
      const text = await current(file.absolute);
      return output.root === file.root && output.path === file.path && output.previousHash === input.expectedHash
        && output.hash === sha256(input.content) && digest(text) === output.hash && output.bytes === Buffer.byteLength(input.content, 'utf8');
    },
  }];
}
