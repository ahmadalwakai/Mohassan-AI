import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { SkillContractSchema } from '@mohassan/contracts';
import { SkillPortfolioQuerySchema, SkillPortfolioSchema, SkillQualityDetailSchema, type SkillPortfolio, type SkillQualitySnapshot, type SkillQualityDetail } from '../../contracts/src/skill-quality.ts';
import { readBenchmarkEvaluation } from './benchmark.ts';
import { compareSkillQuality, scoreSkillEvaluation } from './quality.ts';
import { SkillError } from './errors.ts';
import { sha256 } from './hash.ts';

const LIMITS = Object.freeze({ versions: 200, runs: 50, nodes: 144, evidence: 64, files: 40000, evaluations: 10, legacy: 50 });
const json = (value: unknown): any => typeof value === 'string' ? JSON.parse(value) : value;
const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const owner = (value: string) => z.string().min(1).max(200).parse(value);
const versions = (db: Kysely<any>, ownerId: string) => db.selectFrom('skill_versions as v').innerJoin('skill_families as f', 'f.id', 'v.family_id')
  .where('v.owner_id', '=', ownerId).where('f.owner_id', '=', ownerId);

async function quality(db: Kysely<any>, ownerId: string, versionId: string, contentHash: string): Promise<SkillQualityDetail> {
  const candidates = await db.selectFrom('skill_benchmark_runs').select('id').where('owner_id', '=', ownerId).where('candidate_id', '=', versionId)
    .orderBy('started_at', 'desc').orderBy('id', 'desc').limit(LIMITS.evaluations + 1).execute();
  const evaluations: SkillQualitySnapshot[] = []; let invalidEvaluations = 0;
  for (const row of candidates.slice(0, LIMITS.evaluations)) {
    try {
      const evaluation = await readBenchmarkEvaluation(db, ownerId, row.id);
      if (evaluation.candidate.versionId !== versionId) { invalidEvaluations++; continue; }
      evaluations.push(scoreSkillEvaluation(evaluation));
    } catch (error) {
      // Corrupt or unavailable evidence is shown as missing coverage, never as a pass.
      if (error instanceof SkillError || error instanceof z.ZodError) invalidEvaluations++;
      else throw error;
    }
  }
  const measured = evaluations.filter(item => item.candidate.measuredCases > 0);
  return SkillQualityDetailSchema.parse({ versionId, contentHash, evaluations,
    drift: evaluations.length >= 2 ? compareSkillQuality(evaluations[1], evaluations[0]) : null,
    coverage: !measured.length ? 'none' : measured.some(item => item.candidateContentHash === contentHash) ? 'measured' : 'historical_only',
    truncated: candidates.length > LIMITS.evaluations, invalidEvaluations, readOnly: true });
}

/** Direct owned lookup keeps older versions visible outside the portfolio window. No seeding. */
export async function readSkillQuality(db: Kysely<any>, ownerId: string, versionId: string): Promise<SkillQualityDetail> {
  owner(ownerId); z.uuid().parse(versionId);
  const read = async (tx: Kysely<any>) => {
    const version = await versions(tx, ownerId).select(['v.id', 'v.content_hash']).where('v.id', '=', versionId).executeTakeFirst();
    if (!version) throw new SkillError('SKILL_NOT_FOUND', 'لم يُعثر على المهارة.', 404);
    return quality(tx, ownerId, version.id, version.content_hash);
  };
  return db.isTransaction ? read(db) : db.transaction().setIsolationLevel('repeatable read').execute(read);
}

async function legacyChecklist(db: Kysely<any>, ownerId: string): Promise<SkillPortfolio['legacyChecklist']> {
  const rows = await db.selectFrom('memory_skill_versions as v').innerJoin('memory_skill_families as f', 'f.id', 'v.family_id')
    .select(['v.id', 'v.name', 'v.manifest_hash']).where('v.owner_id', '=', ownerId).where('f.owner_id', '=', ownerId)
    .orderBy('v.updated_at', 'desc').orderBy('v.id').limit(LIMITS.legacy + 1).execute();
  const items: SkillPortfolio['legacyChecklist']['items'] = [];
  for (const row of rows.slice(0, LIMITS.legacy)) {
    const evaluation = await db.selectFrom('memory_skill_evaluations').select(['id', 'created_at',
      sql<unknown>`result->'passed'`.as('passed'), sql<unknown>`result->'caseCount'`.as('case_count'),
      sql<unknown>`result->'candidateScore'`.as('candidate_score'), sql<unknown>`result->'holdoutScore'`.as('holdout_score'), sql<unknown>`result->'safetyScore'`.as('safety_score')])
      .where('owner_id', '=', ownerId).where('skill_id', '=', row.id).where('manifest_hash', '=', row.manifest_hash).where('kind', '=', 'benchmark')
      .orderBy('created_at', 'desc').orderBy('id').executeTakeFirst();
    const measured = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
    items.push({ versionId: row.id, name: row.name, manifestHash: row.manifest_hash, evaluationId: evaluation?.id ?? null,
      createdAt: evaluation ? iso(evaluation.created_at) : null, passed: typeof evaluation?.passed === 'boolean' ? evaluation.passed : null,
      caseCount: Number.isSafeInteger(evaluation?.case_count) && Number(evaluation?.case_count) >= 0 ? Number(evaluation?.case_count) : null,
      candidateScore: measured(evaluation?.candidate_score), holdoutScore: measured(evaluation?.holdout_score), safetyScore: measured(evaluation?.safety_score) });
  }
  return { scope: 'checklist_structure', readOnly: true, truncated: rows.length > LIMITS.legacy, items };
}

export async function readSkillPortfolio(db: Kysely<any>, ownerId: string, input: unknown = {}): Promise<SkillPortfolio> {
  owner(ownerId); const query = SkillPortfolioQuerySchema.parse(input);
  const read = async (tx: Kysely<any>) => {
    const total = await versions(tx, ownerId).select(eb => eb.fn.countAll().as('count')).executeTakeFirstOrThrow();
    const columns = ['v.id', 'v.family_id', 'v.name', 'v.version', 'v.level', 'v.status', 'v.content_hash', 'f.slug', 'f.active_version_id'] as const;
    const page = await versions(tx, ownerId).select(columns).orderBy('v.updated_at', 'desc').orderBy('v.id').limit(query.limit).offset(query.offset).execute();
    const analysis = await versions(tx, ownerId).select([...columns, 'v.contract']).orderBy('v.updated_at', 'desc').orderBy('v.id').limit(LIMITS.versions + 1).execute();
    const window = analysis.slice(0, LIMITS.versions), ids = window.map(row => row.id);
    const items: SkillPortfolio['items'] = [];
    for (const row of page) items.push({ id: row.id, familyId: row.family_id, slug: row.slug, name: row.name, version: row.version,
      contentHash: row.content_hash, level: row.level, status: row.status, active: row.active_version_id === row.id, quality: await quality(tx, ownerId, row.id, row.content_hash) });
    const runs = await tx.selectFrom('skill_runs as r').innerJoin('tasks as t', 't.id', 'r.parent_task_id')
      .select(['r.id', 'r.parent_task_id', 'r.status', 'r.created_at', 'r.finished_at']).where('r.owner_id', '=', ownerId).where('t.owner_id', '=', ownerId)
      .orderBy('r.created_at', 'desc').orderBy('r.id').limit(LIMITS.runs + 1).execute();
    const recentRuns: SkillPortfolio['recentRuns'] = [], observed = new Map<string, { runs: number; tools: Set<string>; dependencies: Set<string> }>();
    let nodesTruncated = false;
    for (const run of runs.slice(0, LIMITS.runs)) {
      const nodes = await tx.selectFrom('skill_run_nodes as n').innerJoin('skill_versions as v', 'v.id', 'n.version_id').innerJoin('skill_families as f', 'f.id', 'v.family_id')
        .select(['n.version_id', 'n.content_hash', 'n.tool', 'n.attempt', 'f.slug', 'v.content_hash as current_hash'])
        .where('n.run_id', '=', run.id).where('n.owner_id', '=', ownerId).where('v.owner_id', '=', ownerId).where('f.owner_id', '=', ownerId)
        .orderBy('n.node_id').limit(LIMITS.nodes + 1).execute();
      const evidence = await tx.selectFrom('skill_evidence as e').innerJoin('tasks as t', 't.id', 'e.task_id')
        .select('e.id').where('e.run_id', '=', run.id).where('e.owner_id', '=', ownerId).where('t.owner_id', '=', ownerId)
        .orderBy('e.created_at', 'desc').orderBy('e.id').limit(LIMITS.evidence + 1).execute();
      const bounded = nodes.slice(0, LIMITS.nodes); nodesTruncated ||= nodes.length > LIMITS.nodes;
      recentRuns.push({ id: run.id, parentTaskId: run.parent_task_id, status: run.status, createdAt: iso(run.created_at), finishedAt: run.finished_at ? iso(run.finished_at) : null,
        versionIds: [...new Set<string>(bounded.map(row => row.version_id))], evidenceIds: evidence.slice(0, LIMITS.evidence).map(row => row.id), evidenceTruncated: evidence.length > LIMITS.evidence });
      const current = bounded.filter(row => row.content_hash === row.current_hash), seen = new Set<string>();
      for (const node of current) {
        const item = observed.get(node.version_id) ?? { runs: 0, tools: new Set<string>(), dependencies: new Set<string>() };
        if (!seen.has(node.version_id)) { item.runs++; seen.add(node.version_id); }
        if (node.tool && node.attempt > 0) item.tools.add(node.tool);
        for (const peer of current) if (peer.version_id !== node.version_id) item.dependencies.add(peer.slug);
        observed.set(node.version_id, item);
      }
    }
    const files = ids.length ? await tx.selectFrom('skill_files').select(['version_id', 'path', 'kind', 'content_hash', 'size_bytes'])
      .where('version_id', 'in', ids).orderBy('version_id').orderBy('path').limit(LIMITS.files + 1).execute() : [];
    const filesTruncated = files.length > LIMITS.files, fingerprints = new Map<string, string[]>(), suggestions: SkillPortfolio['suggestions'] = [];
    if (!filesTruncated) for (const id of ids) {
      const selected = files.filter(file => file.version_id === id); if (!selected.length || selected.length > 200) continue;
      const fingerprint = sha256(JSON.stringify(selected.map(file => [file.path, file.kind, file.content_hash, file.size_bytes])));
      fingerprints.set(fingerprint, [...fingerprints.get(fingerprint) ?? [], id]);
    }
    for (const [fingerprint, versionIds] of fingerprints) if (versionIds.length > 1) suggestions.push({ kind: 'duplicate_file_set', versionIds, fingerprint,
      tools: [], dependencies: [], sampleRuns: 0, reviewOnly: true, proofOfUnnecessaryDependency: false });
    let invalidContracts = false;
    for (const version of window) {
      let parsed;
      try { parsed = SkillContractSchema.safeParse(json(version.contract)); } catch { invalidContracts = true; continue; }
      if (!parsed.success) { invalidContracts = true; continue; }
      const usage = observed.get(version.id); if (!usage?.runs || nodesTruncated) continue;
      const common = { versionIds: [version.id], fingerprint: null, sampleRuns: usage.runs, reviewOnly: true as const, proofOfUnnecessaryDependency: false as const };
      const tools = parsed.data.requires.tools.filter(tool => !usage.tools.has(tool)), dependencies = parsed.data.dependsOn.filter(slug => !usage.dependencies.has(slug));
      if (tools.length) suggestions.push({ ...common, kind: 'declared_tools_not_observed', tools, dependencies: [] });
      if (dependencies.length) suggestions.push({ ...common, kind: 'declared_dependencies_not_observed', tools: [], dependencies });
    }
    return SkillPortfolioSchema.parse({ items, total: Number(total.count), offset: query.offset, limit: query.limit,
      truncated: analysis.length > LIMITS.versions || nodesTruncated || invalidContracts || filesTruncated || suggestions.length > 400,
      analysisWindow: { versions: window.length, versionLimit: LIMITS.versions, runs: recentRuns.length, runLimit: LIMITS.runs, runsTruncated: runs.length > LIMITS.runs || nodesTruncated, filesTruncated },
      suggestions: suggestions.slice(0, 400), recentRuns, legacyChecklist: await legacyChecklist(tx, ownerId), readOnly: true, permissionsGranted: false });
  };
  return db.isTransaction ? read(db) : db.transaction().setIsolationLevel('repeatable read').execute(read);
}
