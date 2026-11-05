import type { Kysely } from 'kysely';
import {
  SkillCompositionRequestSchema, SkillCompositionResultSchema, SkillContractSchema,
  type SkillCompositionResult, type SkillContract, type SkillPlanIssue, type SkillToolId,
} from '@mohassan/contracts';
import { composeSkillGraph } from './composer.ts';
import { detectSkillConflicts, requiresApproval, type ConflictNode } from './conflicts.ts';
import { skillContentHash } from './hash.ts';
import { buildPermissionSnapshot, type SkillEnvironment } from './permissions.ts';

const MAX_ISSUES = 200;
const json = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);

type Access = { tools: Set<SkillToolId>; scopes: Set<string> };

export function createSkillPlanner(db: Kysely<any>, options: { environment: () => Promise<SkillEnvironment> | SkillEnvironment; access: (ownerId: string, id: string) => Promise<Access> }) {
  /** Validates only. A valid plan grants nothing, and runs nothing. */
  return async function validateComposition(ownerId: string, input: unknown): Promise<SkillCompositionResult> {
    const request = SkillCompositionRequestSchema.parse(input);
    const issues: SkillPlanIssue[] = [];
    const ids = [...new Set(request.nodes.map((node) => node.skillId))];
    const rows = await db.selectFrom('skill_versions as v').innerJoin('skill_families as f', 'f.id', 'v.family_id').select(['v.id', 'v.status', 'v.level', 'v.contract', 'v.content_hash', 'f.active_version_id']).where('v.owner_id', '=', ownerId).where('v.id', 'in', ids).execute();
    const files = await db.selectFrom('skill_files').select(['version_id', 'path', 'kind', 'content']).where('version_id', 'in', rows.length ? rows.map((row) => row.id) : ['']).execute();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const contracts = new Map<string, SkillContract>();

    for (const node of request.nodes) {
      const row = byId.get(node.skillId);
      if (!row) { issues.push({ code: 'skill_not_found', severity: 'error', category: 'missing_skill', nodeId: node.id, message: 'المهارة غير موجودة.' }); continue; }
      const contract = SkillContractSchema.parse(json(row.contract));
      contracts.set(node.id, contract);
      if (skillContentHash(contract, files.filter((file) => file.version_id === row.id)) !== row.content_hash) issues.push({ code: 'skill_integrity_failed', severity: 'error', category: 'environment_failure', nodeId: node.id, message: 'لا تطابق محتويات المهارة بصمتها.' });
      if (row.status !== 'active' || row.active_version_id !== row.id) issues.push({ code: 'skill_not_active', severity: 'error', category: 'missing_skill', nodeId: node.id, message: `${contract.slug} ليست مفعّلة.` });
    }

    const graph = composeSkillGraph(request, contracts);
    issues.push(...graph.issues);
    const conflictNodes: ConflictNode[] = request.nodes.flatMap((node) => {
      const contract = contracts.get(node.id);
      if (!contract) return [];
      return [{ id: node.id, contract, instructions: files.find((file) => file.version_id === node.skillId && file.kind === 'instructions')?.content ?? '' }];
    });
    issues.push(...detectSkillConflicts(conflictNodes, graph.ordered));

    const snapshot = buildPermissionSnapshot(await options.environment());
    for (const node of request.nodes) {
      const contract = contracts.get(node.id);
      if (!contract) continue;
      const guiding = contract.level === 'instruction';
      const access = await options.access(ownerId, node.skillId);
      for (const tool of new Set(contract.requires.tools)) {
        const state = snapshot.tools[tool];
        // Guidance can still help without one tool, so it warns. An executing step cannot run at all.
        if (!state.available) issues.push({ code: 'tool_unavailable', severity: guiding ? 'warning' : 'error', category: 'missing_tool', nodeId: node.id, message: `${tool}: ${state.reason}` });
        if (!guiding && !access.tools.has(tool)) issues.push({ code: 'tool_not_granted', severity: 'error', category: 'missing_permission', nodeId: node.id, message: `لم تُمنح المهارة الأداة ${tool}.` });
      }
      if (!guiding) for (const scope of contract.requires.scopes) if (!access.scopes.has(scope)) issues.push({ code: 'scope_not_granted', severity: 'error', category: 'missing_permission', nodeId: node.id, message: `لم تُمنح المهارة الصلاحية ${scope}.` });
      if (contract.steps.some((step) => step.kind === 'model') && !snapshot.model) issues.push({ code: 'model_unavailable', severity: 'error', category: 'environment_failure', nodeId: node.id, message: 'النموذج غير مهيأ.' });
      if (contract.level === 'executable' && !snapshot.executable) issues.push({ code: 'isolation_gates_closed', severity: 'error', category: 'environment_failure', nodeId: node.id, message: 'بوابات العزل لم تكتمل.' });
    }

    return SkillCompositionResultSchema.parse({
      valid: !issues.some((entry) => entry.severity === 'error'), batches: graph.batches, issues: issues.slice(0, MAX_ISSUES),
      nodes: request.nodes.map((node) => {
        const contract = contracts.get(node.id);
        return { id: node.id, skillId: node.skillId, slug: contract?.slug ?? null, level: contract?.level ?? null, role: contract ? (contract.level === 'instruction' ? 'context' : 'execute') : null, sideEffects: contract?.sideEffects ?? null, requiresApproval: contract ? requiresApproval(contract) : false };
      }),
    });
  };
}
