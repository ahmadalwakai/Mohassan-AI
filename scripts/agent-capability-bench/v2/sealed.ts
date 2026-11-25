import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  capabilityAreas, capabilityBaselineCommit, capabilityCaseSchema, capabilityLanguages, CapabilityCorpusError, validateDistinct,
} from '../corpus.js';
import { mappingVersion as capabilityV2MappingVersion } from './mapping.js';

export { capabilityV2MappingVersion };
export const capabilityV2PayloadFile = 'payload.json';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const releasePath = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u);

const stratumSchema = z.strictObject({
  area: z.enum(capabilityAreas),
  language: z.enum(capabilityLanguages),
  count: z.number().int().positive(),
});

export const capabilityV2ManifestSchema = z.strictObject({
  schemaVersion: z.literal(2),
  baselineCommit: z.literal(capabilityBaselineCommit),
  mappingVersion: z.literal(capabilityV2MappingVersion),
  sealed: z.strictObject({
    sha256,
    caseCount: z.number().int().positive(),
    arabicCount: z.number().int().nonnegative(),
  }),
  strata: z.array(stratumSchema).min(1),
  files: z.record(releasePath, sha256),
});

export const capabilityV2PayloadSchema = z.strictObject({
  schemaVersion: z.literal(2),
  mappingVersion: z.literal(capabilityV2MappingVersion),
  cases: z.array(capabilityCaseSchema.refine(item => item.provenance.author === 'human' && /^human-[a-f0-9]{24}$/u.test(item.id))).min(1),
});

export type CapabilityV2Manifest = z.infer<typeof capabilityV2ManifestSchema>;
export type CapabilityV2Payload = z.infer<typeof capabilityV2PayloadSchema>;

function stratumLabel({ area, language }: Pick<z.infer<typeof stratumSchema>, 'area' | 'language'>): string {
  return `${area}/${language}`;
}

async function readBytes(path: string, label: 'manifest' | 'payload' | 'release'): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch {
    throw new CapabilityCorpusError(`Could not read the capability v2 ${label} file.`);
  }
}

function parseJson<T>(bytes: Buffer, schema: z.ZodType<T>, label: 'manifest' | 'payload'): T {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new CapabilityCorpusError(`The capability v2 ${label} file is not valid UTF-8 JSON.`);
  }
  const result = schema.safeParse(json);
  if (!result.success) throw new CapabilityCorpusError(`Invalid capability v2 ${label} schema.`);
  return result.data;
}

async function verifyRelease(path: string, { files, sealed }: CapabilityV2Manifest): Promise<Buffer> {
  const payloadPath = resolve(path);
  if (basename(payloadPath) !== capabilityV2PayloadFile) {
    throw new CapabilityCorpusError('Capability v2 requires the release bundle payload.json.');
  }
  if (files[capabilityV2PayloadFile] !== sealed.sha256) {
    throw new CapabilityCorpusError('The capability v2 payload fingerprint does not match the release manifest.');
  }

  const directory = dirname(payloadPath);
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(() => undefined);
  if (entries === undefined) throw new CapabilityCorpusError('Could not read the capability v2 release directory.');
  const expected = Object.entries(files);
  const actual = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!entry.isFile()) throw new CapabilityCorpusError('The capability v2 release must contain regular files only.');
    actual.add(relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/'));
  }
  if (actual.size !== expected.length || expected.some(([name]) => !actual.has(name))) {
    throw new CapabilityCorpusError('The capability v2 release file inventory does not match the manifest.');
  }

  const payload = await readBytes(payloadPath, 'payload');
  if (createHash('sha256').update(payload).digest('hex') !== sealed.sha256) {
    throw new CapabilityCorpusError('SHA-256 mismatch for the capability v2 payload file.');
  }
  for (const [name, digest] of expected) {
    if (name === capabilityV2PayloadFile) continue;
    const bytes = await readBytes(join(directory, name), 'release');
    if (createHash('sha256').update(bytes).digest('hex') !== digest) {
      throw new CapabilityCorpusError('SHA-256 mismatch for a capability v2 release file.');
    }
  }
  return payload;
}

export async function loadSealedCapabilityCorpus(paths: { manifest: string; sealed: string }) {
  const manifestBytes = await readBytes(paths.manifest, 'manifest');
  const manifest = parseJson(manifestBytes, capabilityV2ManifestSchema, 'manifest');
  const { sealed, strata } = manifest;
  const strataCounts = new Map(strata.map(row => [stratumLabel(row), row.count]));
  const expectedTotal = strata.reduce((count, row) => count + row.count, 0);
  const expectedArabic = strata.reduce((count, row) => count + (row.language === 'ar' ? row.count : 0), 0);
  if (strataCounts.size !== strata.length || expectedTotal !== sealed.caseCount || expectedArabic !== sealed.arabicCount) {
    throw new CapabilityCorpusError('Inconsistent capability v2 manifest counts.');
  }

  const payload = await verifyRelease(paths.sealed, manifest);
  const { cases } = parseJson(payload, capabilityV2PayloadSchema, 'payload');
  const actualCounts = new Map<string, number>();
  for (const item of cases) {
    const key = stratumLabel(item);
    actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1);
  }
  if (actualCounts.size !== strataCounts.size || strata.some(row => actualCounts.get(stratumLabel(row)) !== row.count)) {
    throw new CapabilityCorpusError('Case counts do not match the capability v2 strata.');
  }
  validateDistinct(cases);
  return { manifest, cases, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex') };
}
