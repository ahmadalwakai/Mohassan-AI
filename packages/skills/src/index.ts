import type { Kysely } from 'kysely';
import { createSkillGrants } from './grants.ts';
import { createSkillImporter } from './importer.ts';
import { createSkillLifecycle } from './lifecycle.ts';
import type { SkillEnvironment } from './permissions.ts';
import { createSkillPlanner } from './planner.ts';
import { createSkillRegistry } from './registry.ts';
import { createInstructionContext } from './preload.ts';
import { rebuildSkillGraph } from './graph.ts';

export { skillsMigration } from './migration.ts';
export { createSkillForgeControl } from './forge.ts';
export { builtinSkills, type BuiltinSkill } from './builtin/index.ts';
export { SkillError } from './errors.ts';
export { sha256, skillContentHash, skillContentMatches } from './hash.ts';
export { INSPECTOR_VERSION, inspectSkill } from './inspector.ts';
export { parseSkillManifest } from './frontmatter.ts';
export { composeSkillGraph } from './composer.ts';
export { detectSkillConflicts } from './conflicts.ts';
export { buildPermissionSnapshot, type PermissionSnapshot, type SkillEnvironment } from './permissions.ts';
export { routeInstructionSkills, type SkillContextMetadata } from './router.ts';
export { compileInstructionContext, DEFAULT_SKILL_CONTEXT_CHARS, MAX_SKILL_CONTEXT_CHARS, type CompiledSkillContext, type SkillContextSource } from './compiler.ts';
export { preloadInstructionMetadata } from './preload.ts';
export { createSkillScheduler, type SkillChildSpec, type SkillAdvanceContext, type SkillAdvanceResult, type SkillRunResult } from './scheduler.ts';
export { hashSkillData, canonicalSkillJson, canonicalSkillEvidenceJson, appendSkillEvidence, type SkillNodeClaim, type SkillNodeResult, type SkillNodeOutcome, type SkillNodePreimage } from './evidence.ts';
export { createToolGateway, type SkillToolAdapter, type SkillToolContext } from './gateway.ts';
export { createScriptExecutor, SkillScriptError, SKILL_SCRIPT_RESULT_FILE, type SkillScriptExecutor, type SkillScriptReceipt, type SkillScriptSandbox } from './executor.ts';
export { createFileToolAdapters } from './file-tools.ts';
export { decideRecovery, SkillFailureProofSchema, MAX_SKILL_RETRY_DELAY_MS, type SkillFailureProof, type SkillRecoveryDecision } from './fallback.ts';
export { createSkillRollbackControl, type SkillRollbackContext } from './rollback.ts';
export { classifyGap, recordSkillGap, listSkillGaps } from './gaps.ts';
export { rebuildSkillGraph, readSkillGraph, relatedSkills } from './graph.ts';
export { scoreSkillEvaluation, compareSkillQuality } from './quality.ts';
export { readSkillPortfolio, readSkillQuality } from './portfolio.ts';
export { createSkillBenchmarkControl } from './benchmark.ts';

export interface SkillControlOptions {
  /** Instruction context is opt-in; disabled mode performs no loading or seeding. */
  enabled?: boolean;
  allowedRoots?: readonly string[];
  /** Isolation gates G1–G8. Executable skills stay off until something proves them open. */
  executableReady?: () => Promise<boolean>;
  /** What the host can do right now. Without it every tool counts as unavailable. */
  environment?: () => Promise<SkillEnvironment> | SkillEnvironment;
  now?: () => Date;
}

export function createSkillControl(db: Kysely<any>, options: SkillControlOptions = {}) {
  const allowedRoots = options.allowedRoots ?? [];
  const rebuildGraph = async (tx: Kysely<any>, ownerId: string): Promise<void> => { await rebuildSkillGraph(tx, ownerId); };
  const registry = createSkillRegistry(db, { rebuildGraph });
  const importLocal = createSkillImporter(db, { allowedRoots, audit: registry.audit, view: registry.view, rebuildGraph });
  const lifecycle = createSkillLifecycle(db, { audit: registry.audit, executableReady: options.executableReady ?? (async () => false), rebuildGraph });
  const grants = createSkillGrants(db, { allowedRoots, audit: registry.audit, now: options.now });
  const environment = options.environment ?? (() => ({ capabilities: [], modelReady: false, visionReady: false, executableReady: false }));
  const validateComposition = createSkillPlanner(db, { environment, access: grants.effective });
  const instructionContext = createInstructionContext(db, options.enabled === true);
  async function acted(ownerId: string, id: string, act: Promise<void>) { await act; return registry.detail(ownerId, id); }
  return {
    list: registry.list, detail: registry.detail, fileContent: registry.fileContent, importLocal, validateComposition, ...instructionContext,
    inspect: (ownerId: string, id: string, input: unknown) => acted(ownerId, id, lifecycle.inspect(ownerId, id, input)),
    activate: (ownerId: string, id: string, input: unknown) => acted(ownerId, id, lifecycle.activate(ownerId, id, input)),
    revoke: (ownerId: string, id: string, input: unknown) => acted(ownerId, id, lifecycle.revoke(ownerId, id, input)),
    rollback: (ownerId: string, id: string, input: unknown) => acted(ownerId, id, lifecycle.rollback(ownerId, id, input)),
    createGrant: grants.create, revokeGrant: grants.revoke, effectiveAccess: grants.effective,
  };
}
export type SkillControl = ReturnType<typeof createSkillControl>;
