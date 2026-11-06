import type { SkillContract } from '@mohassan/contracts';
import { sha256 } from './hash.ts';

export type SkillBenchmarkScope = 'instruction_delivery' | 'file_tool_correctness';
export type SkillBenchmarkCaseKind = 'deliver' | 'bounded_delivery' | 'revoked_delivery' | 'changed_delivery'
  | 'file_ascii' | 'file_unicode' | 'missing_grant' | 'outside_path' | 'stale_hash' | 'confirmed_rollback' | 'confirmed_crash';
export interface TrustedSkillBenchmarkCase { readonly id: string; readonly split: 'training' | 'holdout'; readonly kind: SkillBenchmarkCaseKind; readonly fixtureHash: string; readonly proofKind: 'instruction_context' | 'runtime_receipt' | 'file_observation' }
export interface TrustedSkillBenchmarkSuite {
  readonly id: string; readonly scope: SkillBenchmarkScope; readonly mode: 'instruction' | 'file.read' | 'file.write';
  readonly cases: readonly TrustedSkillBenchmarkCase[]; readonly suiteHash: string; readonly configHash: string; readonly verifierVersion: string;
  readonly measuredScope: string; readonly limitations: readonly string[];
}
export const BENCHMARK_ASCII = 'Fixed independent benchmark report: 41.\n';
export const BENCHMARK_UNICODE = 'تقرير تحقق مستقل: ٧٣ — دليل محفوظ. 🧪\n';
export const BENCHMARK_BEFORE = 'Original independently prepared fixture bytes.\n';
export const BENCHMARK_VERIFIER_VERSION = 'local-runtime-oracle-v1';
const cases = (items: [string, 'training' | 'holdout', SkillBenchmarkCaseKind][]) => Object.freeze(items.map(([id, split, kind]) => Object.freeze({ id, split, kind,
  proofKind: (['deliver', 'bounded_delivery', 'revoked_delivery', 'changed_delivery'].includes(kind) ? 'instruction_context' : ['missing_grant', 'outside_path', 'stale_hash'].includes(kind) ? 'file_observation' : 'runtime_receipt') as TrustedSkillBenchmarkCase['proofKind'],
  fixtureHash: sha256(JSON.stringify({ id, split, kind, ascii: BENCHMARK_ASCII, unicode: BENCHMARK_UNICODE, before: BENCHMARK_BEFORE, path: 'reports/result.txt', verifier: BENCHMARK_VERIFIER_VERSION })) })));
function suite(raw: Omit<TrustedSkillBenchmarkSuite, 'suiteHash' | 'configHash' | 'verifierVersion'>): TrustedSkillBenchmarkSuite {
  return Object.freeze({ ...raw, limitations: Object.freeze([...raw.limitations]), suiteHash: sha256(JSON.stringify(raw)), configHash: sha256(JSON.stringify({ node: process.version, platform: process.platform, root: 'owned-temp-only', database: 'isolated-pglite', providers: false, timeoutMs: 120000, maxTicks: 12, maxOutputBytes: 64000 })), verifierVersion: BENCHMARK_VERIFIER_VERSION });
}
/** Fixed trusted oracles. Candidate text and API input cannot define cases,
 * expected values, supported tools, evaluation rules or pass thresholds. */
export const SKILL_BENCHMARK_SUITES: readonly TrustedSkillBenchmarkSuite[] = Object.freeze([
  suite({ id: 'instruction-delivery-v1', scope: 'instruction_delivery', mode: 'instruction',
    measuredScope: 'Bounded instruction delivery, source provenance and revocation/hash protection; not semantic quality.',
    limitations: ['No model call or semantic-quality measurement.', 'Fixed local holdout cases, not a claim of generalization.', 'No sandbox or worker-crash measurement.'],
    cases: cases([['delivery-normal', 'training', 'deliver'], ['delivery-bounded', 'holdout', 'bounded_delivery'], ['delivery-content-changed', 'training', 'changed_delivery'], ['delivery-revoked', 'holdout', 'revoked_delivery']]) }),
  suite({ id: 'file-read-correctness-v1', scope: 'file_tool_correctness', mode: 'file.read',
    measuredScope: 'Single file.read contract through Runtime/Gateway in an owned temporary root, with exact-byte and permission checks.',
    limitations: ['No browser, model, executable, semantic-quality or sandbox guarantee.', 'No candidate worker-crash measurement for reads.'],
    cases: cases([['read-ascii', 'training', 'file_ascii'], ['read-unicode', 'holdout', 'file_unicode'], ['read-without-grant', 'training', 'missing_grant'], ['read-outside-declaration', 'holdout', 'outside_path']]) }),
  suite({ id: 'file-write-correctness-v1', scope: 'file_tool_correctness', mode: 'file.write',
    measuredScope: 'Single file.write contract through Runtime/Gateway: exact bytes, grant/path/hash protection, confirmed rollback and confirmed-receipt worker recovery.',
    limitations: ['No browser, model, executable, semantic-quality or sandbox guarantee.', 'Recovery covers a confirmed receipt before Runtime completion, not unknown mid-write effects.', 'Cooperating-worker file protection; no OS compare-and-swap guarantee against a hostile host writer.'],
    cases: cases([['write-ascii', 'training', 'file_ascii'], ['write-unicode', 'holdout', 'file_unicode'], ['write-without-grant', 'training', 'missing_grant'], ['write-outside-declaration', 'holdout', 'outside_path'], ['write-stale-hash', 'training', 'stale_hash'], ['write-confirmed-rollback', 'holdout', 'confirmed_rollback'], ['write-confirmed-crash', 'holdout', 'confirmed_crash']]) }),
]);
export function skillBenchmarkSuite(id: string): TrustedSkillBenchmarkSuite | undefined { return SKILL_BENCHMARK_SUITES.find(value => value.id === id); }
export function skillBenchmarkDefinition(id: string) {
  const value = skillBenchmarkSuite(id); if (!value) return undefined;
  return { id: value.id, scope: value.scope, suiteHash: value.suiteHash, configHash: value.configHash, verifierVersion: value.verifierVersion, independentHoldout: true, measuredScope: value.measuredScope, limitations: [...value.limitations],
    cases: value.cases.map(({ id: caseId, split, fixtureHash, proofKind }) => ({ id: caseId, split, fixtureHash, proofKind })) };
}
export const benchmarkSuites = Object.freeze(SKILL_BENCHMARK_SUITES.map(value => Object.freeze(skillBenchmarkDefinition(value.id)!)));
export const getSkillBenchmarkSuite = skillBenchmarkDefinition;
export function selectSkillBenchmarkSuite(contract: SkillContract): TrustedSkillBenchmarkSuite | undefined {
  const mode = contract.level === 'instruction' ? 'instruction' : contract.level === 'tool' && contract.steps.length === 1 ? contract.steps[0].tool : undefined;
  return SKILL_BENCHMARK_SUITES.find(value => value.mode === mode);
}
/** This intentionally limited signature admits no client-selected literal root,
 * tool chains, external capability or executable step. Unsupported is blocked. */
export function skillBenchmarkSupport(contract: SkillContract, selected: TrustedSkillBenchmarkSuite): string | null {
  if (contract.level === 'executable') return 'BENCHMARK_EXECUTABLE_UNSUPPORTED';
  if (contract.dependsOn.length || contract.conflicts.length) return 'BENCHMARK_DEPENDENCIES_UNSUPPORTED';
  if (selected.mode === 'instruction') return contract.level === 'instruction' && !contract.requires.tools.length && !contract.requires.scopes.length ? null : 'BENCHMARK_SCOPE_UNSUPPORTED';
  if (contract.level !== 'tool' || contract.steps.length !== 1 || contract.steps[0].kind !== 'tool' || contract.steps[0].tool !== selected.mode
    || contract.requires.tools.length !== 1 || contract.requires.tools[0] !== selected.mode || contract.requires.scopes.length) return 'BENCHMARK_SCOPE_UNSUPPORTED';
  const fields = selected.mode === 'file.write' ? ['content', 'expectedHash', 'path', 'root'] : ['path', 'root'];
  const step = contract.steps[0];
  if (JSON.stringify(contract.inputs.map(field => field.name).sort()) !== JSON.stringify(fields)
    || JSON.stringify(Object.keys(step.inputs).sort()) !== JSON.stringify(fields)
    || fields.some(field => step.inputs[field] !== `input.${field}`) || step.dependsOn.length
    || !contract.outputs.some(field => field.name === 'hash' && field.type === 'string')
    || !step.outputs.some(field => field.name === 'hash' && field.type === 'string')
    || !contract.requires.paths.includes('reports')) return 'BENCHMARK_CONTRACT_SIGNATURE_UNSUPPORTED';
  if (selected.mode === 'file.write' && contract.rollback.mode !== 'restore_preimage') return 'BENCHMARK_ROLLBACK_UNSUPPORTED';
  return null;
}

/** Generator-facing projection, deliberately independent of the public suite
 * catalog. It contains no holdout identities, hashes, values or results. */
export function trustedSkillBenchmarkTrainingContext(contract: SkillContract) {
  const selected = selectSkillBenchmarkSuite(contract);
  if (!selected || skillBenchmarkSupport(contract, selected)) return Object.freeze({ supported: false as const, reasonCode: 'FORGE_TRAINING_UNSUPPORTED' as const });
  const constraints = Object.freeze(selected.mode === 'instruction'
    ? ['Deliver only attributable instruction text within the context budget.', 'Keep source provenance and reject content whose hash changed.', 'Instruction delivery does not measure semantic quality or grant tool authority.']
    : ['Keep the original declared tool and input/output contract.', 'Use only the explicitly granted root and declared relative report path.', 'A missing grant must reject the operation.', ...(selected.mode === 'file.write' ? ['An expected content hash must protect existing report bytes.'] : ['Preserve exact source text and its digest.']), 'These are local file-tool checks; they do not establish general sandbox guarantees.']);
  return Object.freeze({ supported: true as const, trainingOnly: true as const, scope: selected.scope,
    measuredScope: selected.mode === 'instruction' ? 'Bounded instruction delivery and source provenance.' : 'Declared local file-tool correctness and authorization.',
    trainingCases: Object.freeze(selected.cases.filter(item => item.split === 'training').map(item => Object.freeze({ id: item.id, proofKind: item.proofKind }))), constraints });
}
