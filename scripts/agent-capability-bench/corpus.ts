import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { routedIntents } from '../../apps/server/src/assistant/routing-decision.js';
import { requestSources, requestOperations } from '../../apps/server/src/assistant/request-scope.js';
import { caseFixtureSchema } from './observe.js';
import { normalizedNumber } from './score.js';

export const capabilityBaselineCommit = 'c2a0ff765071657cf200b5ee7d12fabaad738c0b';
export const capabilityAreas = [
  'small-talk', 'factual', 'follow-up', 'comparison', 'explanation', 'calculation', 'multi-step',
  'document-file', 'coding', 'google-ads', 'desktop', 'memory', 'clarification', 'refusal',
] as const;
export const capabilityLanguages = ['ar', 'en'] as const;
export const capabilityVarieties = ['msa', 'gulf', 'levantine', 'egyptian', 'iraqi', 'english', 'mixed'] as const;

const nonblank = z.string().min(1).max(4000).refine(value => value.trim().length > 0);
const label = z.string().regex(/^[a-z][a-z0-9_.:-]{0,95}$/u);
const handler = z.enum([
  'resume', 'clarify', 'local_conversation', 'local_computation', 'local_status', 'memory', 'ads', 'computer',
  'browser', 'search', 'writing', 'planning', 'coding', 'reminder', 'image', 'media', 'model', 'unsupported',
]);
const status = z.enum([
  'completed', 'partial', 'blocked', 'cancelled', 'failed', 'interrupted', 'waiting_user', 'waiting_input', 'waiting_approval',
]);

export const capabilityExpectationSchema = z.object({
  source: z.array(z.enum(requestSources)).min(1).optional(),
  operation: z.array(z.enum(requestOperations)).min(1).optional(),
  route: z.array(z.enum([...routedIntents, 'reply', 'clarify'])).min(1).optional(),
  handler: z.array(handler).min(1).optional(),
  requiredTools: z.array(label).optional(),
  forbiddenTools: z.array(label).optional(),
  questionCount: z.union([z.literal(0), z.literal(1)]),
  status: z.array(status).min(1),
  requiredContent: z.array(z.object({
    anyOf: z.array(nonblank).min(1),
    match: z.enum(['literal', 'number']),
  }).strict().refine(assertion => assertion.match !== 'number' || assertion.anyOf.every(value => normalizedNumber(value) !== null))),
  forbiddenContent: z.array(nonblank),
  maxSteps: z.number().int().nonnegative(),
  verification: z.enum(['verified', 'unverified']).optional(),
}).strict().refine(value => Boolean(value.route || value.handler || value.requiredTools?.length), {
  message: 'A turn must assert a route, handler or chosen tool.',
}).refine(value => !value.requiredTools?.some(tool => value.forbiddenTools?.includes(tool)), {
  message: 'A turn cannot both require and forbid a tool.',
});

export const capabilityTurnSchema = z.object({
  text: z.string().max(4000),
  fields: z.record(z.string().regex(/^[a-z]{2,20}$/u), nonblank).optional(),
  answerQuestion: z.boolean().optional(),
  approve: z.boolean().optional(),
  expect: capabilityExpectationSchema,
}).strict().superRefine((turn, context) => {
  if (turn.approve !== undefined && (turn.text || turn.fields || turn.answerQuestion)) {
    context.addIssue({ code: 'custom', message: 'An approval turn carries a decision only.' });
  } else if (turn.fields) {
    const values = Object.values(turn.fields);
    const length = values.reduce((total, value) => total + value.length, 0) + (values.length > 1 ? values.length * 4 - 1 : 0);
    if (values.length < 1 || values.length > 6 || length > 4000) {
      context.addIssue({ code: 'custom', message: 'Field answers must satisfy the chat request limits.' });
    }
  } else if (turn.approve === undefined && !turn.text.trim()) {
    context.addIssue({ code: 'custom', message: 'A prose turn requires text.' });
  }
});

export const capabilityCaseSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{2,95}$/u),
  area: z.enum(capabilityAreas),
  language: z.enum(capabilityLanguages),
  variety: z.enum(capabilityVarieties),
  provenance: z.object({ author: nonblank, source: nonblank }).strict(),
  fixture: caseFixtureSchema.optional(),
  turns: z.array(capabilityTurnSchema).min(1),
}).strict().superRefine((item, context) => {
  if ((item.language === 'ar' && item.variety === 'english')
      || (item.language === 'en' && item.variety !== 'english' && item.variety !== 'mixed')) {
    context.addIssue({ code: 'custom', path: ['variety'], message: 'The wording variety must match the scoring language.' });
  }
  const [first] = item.turns;
  if (first?.fields || first?.answerQuestion || first?.approve !== undefined) {
    context.addIssue({ code: 'custom', path: ['turns', 0], message: 'A continuation requires an earlier turn.' });
  }
  if (item.area === 'clarification' && item.turns.reduce((count, turn) => count + turn.expect.questionCount, 0) !== 1) {
    context.addIssue({ code: 'custom', path: ['turns'], message: 'A clarification case must require exactly one question.' });
  }
});

const corpusSchema = z.object({ schemaVersion: z.literal(1), cases: z.array(capabilityCaseSchema).min(1) }).strict();
const partitionSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  caseCount: z.number().int().positive(),
  arabicCount: z.number().int().nonnegative(),
}).strict().refine(partition => partition.arabicCount <= partition.caseCount);
export const capabilityManifestSchema = z.object({
  schemaVersion: z.literal(1),
  baselineCommit: z.literal(capabilityBaselineCommit),
  development: partitionSchema,
  sealed: partitionSchema,
}).strict();

export type CapabilityExpectation = z.infer<typeof capabilityExpectationSchema>;
export type CapabilityTurn = z.infer<typeof capabilityTurnSchema>;
export type CapabilityCase = z.infer<typeof capabilityCaseSchema>;
export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;
type Partition = z.infer<typeof partitionSchema>;
type CorpusFile = 'manifest' | 'development' | 'sealed';

export class CapabilityCorpusError extends Error {}

async function readBytes(path: string, label: CorpusFile): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch {
    throw new CapabilityCorpusError(`Could not read the capability ${label} file.`);
  }
}

function parseJson<T>(bytes: Buffer, schema: z.ZodType<T>, label: CorpusFile): T {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new CapabilityCorpusError(`The capability ${label} file is not valid UTF-8 JSON.`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    // Report ordinal positions and fixed messages only. Inputs can contain sealed or personal text.
    const row = parsed.error.issues[0]?.path;
    const index = row?.[0] === 'cases' && typeof row[1] === 'number' ? ` at case ${row[1] + 1}` : '';
    throw new CapabilityCorpusError(`Invalid capability ${label} schema${index}.`);
  }
  return parsed.data;
}

function validateBalance({ development, sealed }: CapabilityManifest): void {
  const total = development.caseCount + sealed.caseCount;
  const arabic = development.arabicCount + sealed.arabicCount;
  const sealedEnglish = sealed.caseCount - sealed.arabicCount;
  if (total < 300 || arabic !== total / 2 || sealed.arabicCount !== arabic / 5 || sealedEnglish !== (total - arabic) / 5) {
    throw new CapabilityCorpusError('The capability manifest must declare at least 300 cases, equal Arabic and English counts, and 20% sealed in each language.');
  }
}

async function loadPartition(path: string, label: 'development' | 'sealed', partition: Partition): Promise<CapabilityCase[]> {
  const bytes = await readBytes(path, label);
  if (createHash('sha256').update(bytes).digest('hex') !== partition.sha256) {
    throw new CapabilityCorpusError(`SHA-256 mismatch for the capability ${label} file.`);
  }
  const { cases } = parseJson(bytes, corpusSchema, label);
  if (cases.length !== partition.caseCount || cases.filter(item => item.language === 'ar').length !== partition.arabicCount) {
    throw new CapabilityCorpusError(`Case counts do not match the capability ${label} declaration.`);
  }
  return cases;
}

function normalizeInput(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function validateDistinct(cases: readonly CapabilityCase[]): void {
  const ids = new Set<string>();
  const inputs = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) throw new CapabilityCorpusError('Duplicate capability case ID.');
    ids.add(item.id);
    const turns = item.turns.map(turn => {
      const fields = Object.entries(turn.fields ?? {}).sort(([a], [b]) => a.localeCompare(b, 'en'));
      return [normalizeInput(turn.text), fields.map(([key, value]) => [key, normalizeInput(value)]), Boolean(turn.answerQuestion), turn.approve];
    });
    const key = JSON.stringify(turns);
    if (inputs.has(key)) throw new CapabilityCorpusError('Duplicate normalized capability case input.');
    inputs.add(key);
  }
}

export async function loadCapabilityCorpus(paths: {
  manifest: string;
  development: string;
  sealed?: string;
}): Promise<{ manifest: CapabilityManifest; development: CapabilityCase[]; sealed?: CapabilityCase[] }> {
  const manifest = parseJson(await readBytes(paths.manifest, 'manifest'), capabilityManifestSchema, 'manifest');
  validateBalance(manifest);
  const development = await loadPartition(paths.development, 'development', manifest.development);
  const missingAreas = capabilityAreas.filter(area => !development.some(item => item.area === area));
  const missingVarieties = capabilityVarieties.filter(variety => !development.some(item => item.variety === variety));
  if (missingAreas.length || missingVarieties.length) {
    throw new CapabilityCorpusError(`Missing development coverage for: ${[...missingAreas, ...missingVarieties].join(', ')}.`);
  }
  if (paths.sealed === undefined) {
    validateDistinct(development);
    return { manifest, development };
  }
  const sealed = await loadPartition(paths.sealed, 'sealed', manifest.sealed);
  validateDistinct([...development, ...sealed]);
  return { manifest, development, sealed };
}
