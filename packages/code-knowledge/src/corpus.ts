import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Corpus } from './types.js';

const nonempty = z.string().refine(value => Boolean(value.trim()));
const https = z.string().refine(value => {
  if (/[\s<>"\\]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
});
const license = {
  license: nonempty.optional(),
  licenseUrl: https.optional(),
  copyrightNotice: nonempty.optional(),
};
const completeLicense = (value: { license?: string; licenseUrl?: string }) =>
  Boolean(value.license) === Boolean(value.licenseUrl);

const sourceSchema = z.object({
  ...license,
  id: nonempty,
  title: nonempty,
  kind: z.enum(['documentation', 'qa']),
  url: https,
  license: nonempty,
  licenseUrl: https,
  version: nonempty,
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
}).strict();
const attributionSchema = z.object({ name: nonempty, url: https.optional() }).strict();
const blockSchema = z.object({
  ...license,
  text: nonempty,
  language: nonempty.optional(),
  role: z.enum(['fix', 'failure']).optional(),
}).strict().refine(completeLicense);
const passageSchema = z.object({
  ...license,
  id: nonempty,
  sourceId: nonempty,
  title: nonempty,
  url: https,
  questionUrl: https.optional(),
  text: z.string(),
  code: z.array(blockSchema),
  tags: z.array(nonempty),
  symbols: z.array(nonempty).optional(),
  attribution: z.array(attributionSchema).optional(),
}).strict().refine(completeLicense);
const corpusSchema = z.object({
  sources: z.array(sourceSchema),
  passages: z.array(passageSchema),
}).strict();

export function validateCorpus(value: unknown): Corpus {
  const parsed = corpusSchema.safeParse(value);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join('.');
    throw new Error(`Invalid code knowledge corpus${path ? ` at ${path}` : ''}`);
  }
  const corpus = parsed.data;
  const sources = new Map(corpus.sources.map(source => [source.id, source]));
  if (sources.size !== corpus.sources.length) throw new Error('Duplicate code knowledge source ID');
  const ids = new Set<string>();
  for (const passage of corpus.passages) {
    const source = sources.get(passage.sourceId);
    if (!source) throw new Error('Code knowledge passage is missing its source card');
    if (ids.has(passage.id)) throw new Error('Duplicate code knowledge passage ID');
    if (source.kind === 'qa' && (!passage.attribution?.length || !passage.license || !passage.questionUrl)) {
      throw new Error('Q&A passage requires attribution, a post license, and a parent question link');
    }
    ids.add(passage.id);
  }
  return corpus;
}

export async function readCorpus(path: string): Promise<Corpus> {
  const content = await readFile(path, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error('Invalid code knowledge corpus JSON');
  }
  return validateCorpus(raw);
}

export async function writeCorpus(path: string, corpus: Corpus): Promise<void> {
  const valid = validateCorpus(corpus);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(valid)}\n`, { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
