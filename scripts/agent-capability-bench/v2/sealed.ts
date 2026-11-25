import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  capabilityAreas, capabilityBaselineCommit, capabilityCaseSchema, capabilityLanguages, CapabilityCorpusError, validateDistinct,
} from '../corpus.js';
import { mappingVersion as capabilityV2MappingVersion } from './mapping.js';

export { capabilityV2MappingVersion };

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
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    caseCount: z.number().int().positive(),
    arabicCount: z.number().int().nonnegative(),
  }),
  strata: z.array(stratumSchema).min(1),
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

async function readBytes(path: string, label: 'manifest' | 'payload'): Promise<Buffer> {
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

  const payload = await readBytes(paths.sealed, 'payload');
  if (createHash('sha256').update(payload).digest('hex') !== sealed.sha256) {
    throw new CapabilityCorpusError('SHA-256 mismatch for the capability v2 payload file.');
  }
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
