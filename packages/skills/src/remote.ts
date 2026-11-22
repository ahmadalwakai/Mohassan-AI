import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { safeRelative, sensitivePath } from '@mohassan/coding/security';
import { SkillRemoteStatusSchema, SkillRemoteSyncSchema, type SkillRemoteConfig, type SkillRemoteItem, type SkillRemoteStartResult, type SkillRemoteStatus, type SkillRemoteSync } from '@mohassan/contracts';
import { SkillError, SkillPolicyError } from './errors.ts';
import { buildSkillSource, type SkillSourceEntry } from './importer.ts';
import { countImportedVersions, MAX_GITHUB_SKILLS, MAX_GITHUB_VERSIONS_PER_OWNER, MAX_IMPORTED_TOTAL_BYTES, storeImmutableSkill } from './import-store.ts';
import { classifySkillFile } from './inspector.ts';
import type { createSkillLifecycle } from './lifecycle.ts';
import { pruneGithubSkillVersions } from './prune.ts';

/** One entry of a Git tree, with `path` relative to the listed folder. */
export interface SkillRemoteEntry { mode: string; type: 'blob' | 'tree' | 'commit'; objectId: string; size: number | null; path: string }
/** What the sync needs from Git. Tests inject a fake; `remote-git.ts` adapts the restricted runner. Nothing fetched is ever executed. */
export interface SkillRemoteTransport {
  /** The commit the configured branch points at upstream. */
  head(signal: AbortSignal): Promise<string>;
  /** The commit available locally; fetches when it is missing and returns the commit actually stored. */
  ensure(commit: string, signal: AbortSignal): Promise<string>;
  /** Direct children of the skills folder; `path` is the child name. */
  children(commit: string, signal: AbortSignal): Promise<SkillRemoteEntry[]>;
  /** Every file below one skill folder with sizes; `path` is relative to that folder. */
  entries(commit: string, slug: string, signal: AbortSignal): Promise<SkillRemoteEntry[]>;
  blob(objectId: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>;
  /** Optional: many blobs in one read, with the sizes the listing announced. Any failure falls back to `blob` per file. */
  readBlobs?(requests: readonly { objectId: string; size: number }[], signal: AbortSignal): Promise<Map<string, Uint8Array>>;
}
export interface SkillRemoteOptions {
  config: SkillRemoteConfig | null;
  /** Set when the environment named a repository but the values were invalid; the feature then stays off. */
  problem?: string | null;
  engineEnabled: boolean;
  transport: SkillRemoteTransport | null;
  /** A lifecycle that does not rebuild the skill graph itself: the sync rebuilds it once per batch of activations. */
  lifecycle: Pick<ReturnType<typeof createSkillLifecycle>, 'inspect' | 'activateByPolicy'>;
  audit(tx: Kysely<any>, ownerId: string, targetId: string, event: string, detail?: Record<string, unknown>): Promise<void>;
  rebuildGraph?(tx: Kysely<any>, ownerId: string): Promise<void>;
  now?: () => Date;
}
export type SkillRemoteCause = 'schedule' | 'manual';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+){0,7}$/;
const MAX_SKILLS = MAX_GITHUB_SKILLS, MAX_FILES = 40, MAX_FILE_BYTES = 64000, KEEP_ROWS = 50, FIRST_TICK_MS = 15_000;
/** A run that has not finished in 30 minutes stops; its progress is kept and the next run continues from there. */
const RUN_LIMIT_MS = 30 * 60_000;
/** A live run writes its progress this often; a running row silent for INTERRUPTED_AFTER_MS belongs to a process that died. */
const HEARTBEAT_MS = 10_000, INTERRUPTED_AFTER_MS = 10 * 60_000;
/** Skills planned together: their blobs are read in one Git process, bounded by count and by announced bytes. */
const GROUP_SKILLS = 50, GROUP_BYTES = 4 * 1_048_576;
/** The skill graph is rebuilt after this many activations and once at the end, instead of after every single one. */
const GRAPH_EVERY = 100;
const MAX_REPORT_ITEMS = 200, MAX_REPORT_ORPHANS = 200;
const json = (value: unknown): any => (typeof value === 'string' ? JSON.parse(value) : value);
const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const errorCode = (error: unknown) => { const code = (error as { code?: unknown } | null)?.code; return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'SKILL_REMOTE_SYNC_FAILED'; };
const isAbort = (error: unknown) => (error as { name?: string } | null)?.name === 'AbortError' || (error as { code?: string } | null)?.code === 'ABORTED';
const emptyCounts = () => ({ total: 0, unchanged: 0, activated: 0, pendingReview: 0, rejected: 0, errors: 0, pruned: 0 });
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function tally(items: readonly SkillRemoteItem[], pruned: number) {
  const counts = emptyCounts(); counts.total = items.length; counts.pruned = pruned;
  for (const item of items) {
    if (item.outcome === 'unchanged') counts.unchanged++;
    else if (item.outcome === 'activated') counts.activated++;
    else if (item.outcome === 'pending_review') counts.pendingReview++;
    else if (item.outcome === 'rejected' || item.outcome === 'incompatible') counts.rejected++;
    else if (item.outcome === 'error') counts.errors++;
  }
  return counts;
}

const OUTCOME_RANK: Record<SkillRemoteItem['outcome'], number> = { error: 0, rejected: 1, incompatible: 1, pending_review: 2, activated: 3, skipped: 4, unchanged: 5 };
/** Pure: the items a report keeps. Up to 200 the report lists every skill; above that it keeps what needs the owner first. */
export function compactRemoteItems(items: readonly SkillRemoteItem[]): { items: SkillRemoteItem[]; omitted: number } {
  if (items.length <= MAX_REPORT_ITEMS) return { items: [...items], omitted: 0 };
  const kept = [...items].sort((a, b) => OUTCOME_RANK[a.outcome] - OUTCOME_RANK[b.outcome] || compare(a.slug, b.slug)).slice(0, MAX_REPORT_ITEMS);
  return { items: kept.sort((a, b) => compare(a.slug, b.slug)), omitted: items.length - kept.length };
}

/** Everything that must hold before a single blob is read. A violation fails this skill only. */
function validateEntries(entries: readonly SkillRemoteEntry[]): void {
  if (entries.length > MAX_FILES) throw new SkillError('SKILL_TOO_LARGE', 'تحتوي المهارة ملفات أكثر من المسموح.');
  let total = 0;
  for (const entry of entries) {
    if (entry.mode === '120000') throw new SkillError('SKILL_REMOTE_SYMLINK', 'تحتوي المهارة رابطاً رمزياً؛ لا يُقبل.');
    if (entry.mode === '160000' || entry.type === 'commit') throw new SkillError('SKILL_REMOTE_SUBMODULE', 'تحتوي المهارة وحدة فرعية؛ لا تُقبل.');
    if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) throw new SkillError('SKILL_FILE_UNSUPPORTED', 'نوع مدخل غير مدعوم في المهارة.');
    if (entry.size === null || !Number.isSafeInteger(entry.size) || entry.size > MAX_FILE_BYTES) throw new SkillError('SKILL_TOO_LARGE', 'ملف في المهارة أكبر من المسموح.');
    total += entry.size;
    if (total > MAX_IMPORTED_TOTAL_BYTES) throw new SkillError('SKILL_TOO_LARGE', 'تجاوزت المهارة الحجم المسموح.');
    let path: string;
    try { path = safeRelative(entry.path); } catch { throw new SkillError('SKILL_FILE_UNSUPPORTED', 'مسار ملف غير صالح في المهارة.'); }
    if (sensitivePath(path)) throw new SkillError('SKILL_FILE_UNSUPPORTED', 'مسار حساس داخل المهارة.');
    if (path !== 'skill.contract.json' && !classifySkillFile(path)) throw new SkillError('SKILL_FILE_UNSUPPORTED', `نوع ملف غير مدعوم: ${path}`);
  }
}

function syncDto(row: any): SkillRemoteSync {
  const report = json(row.report) ?? {};
  const progress = report.progress && Number.isSafeInteger(report.progress.processed) && Number.isSafeInteger(report.progress.total) ? { processed: report.progress.processed, total: report.progress.total } : null;
  return SkillRemoteSyncSchema.parse({
    id: row.id, repo: row.repo, ref: row.ref, path: row.path, commit: row.commit_sha ?? null, cause: row.cause, status: row.status, errorCode: row.error_code ?? null,
    startedAt: iso(row.started_at), finishedAt: row.finished_at ? iso(row.finished_at) : null, unchanged: report.unchanged === true,
    counts: { ...emptyCounts(), ...(report.counts ?? {}) }, items: report.items ?? [], itemsOmitted: report.itemsOmitted ?? 0,
    orphans: report.orphans ?? [], orphansOmitted: report.orphansOmitted ?? 0, progress,
  });
}

interface Planned { slug: string; treeId: string; entries: SkillRemoteEntry[]; bytes: number }

/** Polls one public GitHub repository and feeds its skill folders through the ordinary import → quarantine → inspection path.
 * Activation happens only through `activateByPolicy`; nothing here creates grants or touches tool/executable skills.
 * A run saves its progress as it goes, so a stopped, interrupted or timed-out run is continued by the next one. */
export function createSkillRemote(db: Kysely<any>, options: SkillRemoteOptions) {
  const now = options.now ?? (() => new Date()), createdAt = now().getTime();
  const runs = new Map<string, { controller: AbortController; promise: Promise<void> }>();

  function ready(): { config: SkillRemoteConfig; transport: SkillRemoteTransport } {
    if (!options.config) throw new SkillError('SKILL_REMOTE_NOT_CONFIGURED', 'لم يُضبط مستودع مهارات على هذا الخادم.', 409);
    if (!options.engineEnabled || !options.transport) throw new SkillError('SKILL_REMOTE_UNAVAILABLE', 'محرك المهارات غير مفعّل؛ المزامنة متوقفة.', 409);
    return { config: options.config, transport: options.transport };
  }
  const rowsFor = (ownerId: string, config: SkillRemoteConfig) => db.selectFrom('skill_remote_syncs')
    .where('owner_id', '=', ownerId).where('repo', '=', config.repo).where('ref', '=', config.ref).where('path', '=', config.path);
  const lastSucceeded = (ownerId: string, config: SkillRemoteConfig) => rowsFor(ownerId, config).select(['id', 'commit_sha', 'trees']).where('status', '=', 'succeeded')
    .orderBy('started_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
  /** The tree map to compare against: the newest finished row, which may be a stopped run's progress; else the last success. */
  async function baseTrees(ownerId: string, config: SkillRemoteConfig, succeeded: { trees: unknown } | undefined): Promise<Record<string, string>> {
    const latest = await rowsFor(ownerId, config).select(['trees']).where('status', '<>', 'running').orderBy('started_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
    const trees = (latest ? json(latest.trees) : null) ?? {};
    return Object.keys(trees).length ? trees : (succeeded ? json(succeeded.trees) : null) ?? {};
  }
  async function finish(id: string, status: 'succeeded' | 'failed', data: { commit: string | null; trees: Record<string, string>; report: Record<string, unknown>; errorCode?: string }) {
    await db.updateTable('skill_remote_syncs').set({ status, commit_sha: data.commit, trees: JSON.stringify(data.trees), report: JSON.stringify(data.report), error_code: data.errorCode ?? null, finished_at: now() })
      .where('id', '=', id).where('status', '=', 'running').execute();
  }
  async function readVersion(ownerId: string, id: string) {
    const row = await db.selectFrom('skill_versions as v').innerJoin('skill_families as f', 'f.id', 'v.family_id')
      .select(['v.id', 'v.status', 'v.revision', 'v.version', 'v.content_hash', 'f.active_version_id']).where('v.owner_id', '=', ownerId).where('v.id', '=', id).executeTakeFirstOrThrow();
    const inspection = await db.selectFrom('skill_inspections').select('verdict').where('version_id', '=', id).where('content_hash', '=', row.content_hash).orderBy('created_at', 'desc').executeTakeFirst();
    return { status: row.status as string, revision: row.revision as number, version: row.version as string, active: row.active_version_id === row.id, verdict: (inspection?.verdict ?? null) as SkillRemoteItem['verdict'] };
  }
  const itemOf = (slug: string, outcome: SkillRemoteItem['outcome'], extra: Partial<SkillRemoteItem> = {}): SkillRemoteItem => ({ slug, outcome, deduplicated: false, versionId: null, version: null, verdict: null, code: null, message: null, ...extra });
  const failedItem = (slug: string, error: unknown) => itemOf(slug, 'error', { code: errorCode(error), message: error instanceof Error ? error.message.slice(0, 300) : null });

  /** Lists and checks one changed skill; returns a finished item when nothing has to be read. */
  async function plan(slug: string, treeId: string, previousTree: string | undefined, commit: string, transport: SkillRemoteTransport, signal: AbortSignal): Promise<{ item: SkillRemoteItem } | { planned: Planned }> {
    if (previousTree === treeId) return { item: itemOf(slug, 'unchanged') };
    try {
      const entries = await transport.entries(commit, slug, signal);
      validateEntries(entries);
      return { planned: { slug, treeId, entries, bytes: entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0) } };
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw error;
      return { item: failedItem(slug, error) };
    }
  }
  /** One Git read for the blobs of a whole group. A failure is not an error: each skill then reads its own files, so one bad object fails one skill. */
  async function readGroup(group: readonly Planned[], transport: SkillRemoteTransport, signal: AbortSignal): Promise<Map<string, Uint8Array> | null> {
    if (!transport.readBlobs || !group.length) return null;
    const requests = new Map<string, number>();
    for (const planned of group) for (const entry of planned.entries) requests.set(entry.objectId, entry.size ?? 0);
    try { return await transport.readBlobs([...requests].map(([objectId, size]) => ({ objectId, size })), signal); }
    catch (error) { if (signal.aborted || isAbort(error)) throw error; return null; }
  }

  async function syncSkill(ownerId: string, planned: Planned, prefetched: Map<string, Uint8Array> | null, commit: string, config: SkillRemoteConfig, transport: SkillRemoteTransport, signal: AbortSignal, quota: { pruned: number; exhausted: boolean }): Promise<SkillRemoteItem> {
    const { slug } = planned;
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }), files: SkillSourceEntry[] = [];
      for (const entry of planned.entries) {
        const bytes = prefetched?.get(entry.objectId) ?? await transport.blob(entry.objectId, MAX_FILE_BYTES, signal);
        let content: string;
        try { content = decoder.decode(bytes); } catch { throw new SkillError('SKILL_SOURCE_REJECTED', 'ملف في المهارة ليس نص UTF-8 صالحاً.'); }
        files.push({ path: entry.path, content });
      }
      const locator = `github:${config.repo}@${commit}:${config.path}/${slug}`;
      const source = buildSkillSource(files, { root: locator, defaultSlug: slug });
      // The graph is rebuilt by the run, not by every store.
      const store = () => db.transaction().execute((tx) => storeImmutableSkill(tx, ownerId, source, { origin: 'local_import', source: { kind: 'github', locator }, audit: options.audit }));
      let stored: Awaited<ReturnType<typeof store>>;
      try { stored = await store(); }
      catch (error) {
        // At the GitHub limit, retention runs and this skill is tried once more; once retention frees nothing, the limit stands for the rest of the run.
        if (!(error instanceof SkillError && error.code === 'SKILL_QUOTA_EXCEEDED') || quota.exhausted) throw error;
        const { pruned } = await pruneGithubSkillVersions(db, ownerId);
        quota.pruned += pruned;
        if (!pruned) { quota.exhausted = true; throw error; }
        stored = await store();
      }
      let version = await readVersion(ownerId, stored.id);
      // A run that stopped between storing and inspecting resumes here: the stored version is still quarantined.
      if (version.status === 'quarantined') { await options.lifecycle.inspect(ownerId, stored.id, { expectedRevision: version.revision }); version = await readVersion(ownerId, stored.id); }
      const base = { deduplicated: stored.deduplicated, versionId: stored.id, version: version.version, verdict: version.verdict };
      if (version.status === 'rejected' || version.status === 'incompatible') return itemOf(slug, version.status, base);
      // Never re-activate what the owner rolled back from or revoked, and never touch what is already active.
      if (version.active) return itemOf(slug, 'skipped', { ...base, code: 'ALREADY_ACTIVE' });
      if (version.status === 'deprecated' || version.status === 'revoked' || version.status === 'stale') return itemOf(slug, 'skipped', { ...base, code: version.status.toUpperCase() });
      if (!config.autoActivate) return itemOf(slug, 'pending_review', { ...base, code: 'AUTO_ACTIVATE_OFF' });
      try {
        await options.lifecycle.activateByPolicy(ownerId, stored.id, { expectedRevision: version.revision, proof: { repo: config.repo, ref: config.ref, commit } });
        return itemOf(slug, 'activated', base);
      } catch (error) {
        if (error instanceof SkillPolicyError) return itemOf(slug, 'pending_review', { ...base, code: error.reason, message: error.message });
        throw error;
      }
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw error;
      return failedItem(slug, error);
    }
  }

  async function orphansOf(ownerId: string, previousTrees: Record<string, string>, present: ReadonlySet<string>) {
    const orphans: { slug: string; versionId: string }[] = [];
    for (const slug of Object.keys(previousTrees).filter((slug) => !present.has(slug)).sort()) {
      const active = await db.selectFrom('skill_families as f').innerJoin('skill_versions as v', 'v.id', 'f.active_version_id').innerJoin('skill_sources as s', 's.version_id', 'v.id')
        .select('v.id').where('f.owner_id', '=', ownerId).where('f.slug', '=', slug).where('s.kind', '=', 'github').executeTakeFirst();
      if (active) orphans.push({ slug, versionId: active.id });
    }
    return orphans;
  }

  async function run(ownerId: string, id: string, cause: SkillRemoteCause, config: SkillRemoteConfig, transport: SkillRemoteTransport, signal: AbortSignal): Promise<void> {
    // `progress` is the tree map as far as this run got: the base, plus every skill handled. A stopped run leaves it behind for the next.
    const progress: Record<string, string> = {}, items: SkillRemoteItem[] = [], counters = { processed: 0, total: 0 };
    const quota = { pruned: 0, exhausted: false };
    let activatedSinceGraph = 0, graphDirty = false;
    const progressReport = () => ({ heartbeatAt: now().toISOString(), progress: { ...counters }, counts: tally(items, quota.pruned) });
    let flushing: Promise<unknown> = Promise.resolve();
    const flush = () => db.updateTable('skill_remote_syncs').set({ trees: JSON.stringify(progress), report: JSON.stringify(progressReport()) }).where('id', '=', id).where('status', '=', 'running').execute();
    const heartbeat = setInterval(() => { flushing = flushing.then(flush).catch(() => undefined); }, HEARTBEAT_MS);
    heartbeat.unref();
    const stopHeartbeat = async () => { clearInterval(heartbeat); await flushing; };
    const rebuild = async () => {
      if (!graphDirty || !options.rebuildGraph) return;
      graphDirty = false; activatedSinceGraph = 0;
      await db.transaction().execute((tx) => options.rebuildGraph!(tx, ownerId));
    };
    try {
      const previous = await lastSucceeded(ownerId, config);
      const base = await baseTrees(ownerId, config, previous);
      Object.assign(progress, base);
      // A stop that arrived during the reads above must not wait on the network.
      signal.throwIfAborted();
      const head = await transport.head(signal);
      if (cause === 'schedule' && previous?.commit_sha === head) {
        await stopHeartbeat();
        await finish(id, 'succeeded', { commit: head, trees: base, report: { unchanged: true, counts: emptyCounts(), items: [], orphans: [] } });
        return;
      }
      signal.throwIfAborted();
      const commit = await transport.ensure(head, signal);
      signal.throwIfAborted();
      const children = (await transport.children(commit, signal)).filter((entry) => entry.type === 'tree' && SLUG.test(entry.path)).sort((a, b) => compare(a.path, b.path));
      if (children.length > MAX_SKILLS) throw new SkillError('SKILL_REMOTE_TOO_MANY', 'يحتوي المستودع مهارات أكثر من المسموح.', 409);
      counters.total = children.length;
      const trees: Record<string, string> = {};
      const record = (slug: string, treeId: string, item: SkillRemoteItem) => {
        items.push(item); counters.processed++;
        if (item.outcome === 'error') { delete progress[slug]; return; }
        trees[slug] = treeId; progress[slug] = treeId;
      };
      for (let index = 0; index < children.length;) {
        signal.throwIfAborted();
        const group: Planned[] = [];
        let bytes = 0;
        while (index < children.length && group.length < GROUP_SKILLS && bytes < GROUP_BYTES) {
          const child = children[index++];
          const planned = await plan(child.path, child.objectId, base[child.path], commit, transport, signal);
          if ('item' in planned) record(child.path, child.objectId, planned.item);
          else { group.push(planned.planned); bytes += planned.planned.bytes; }
        }
        const prefetched = await readGroup(group, transport, signal);
        for (const planned of group) {
          signal.throwIfAborted();
          const item = await syncSkill(ownerId, planned, prefetched, commit, config, transport, signal, quota);
          record(planned.slug, planned.treeId, item);
          if (item.outcome === 'activated') { graphDirty = true; if (++activatedSinceGraph >= GRAPH_EVERY) await rebuild(); }
        }
      }
      const orphans = await orphansOf(ownerId, base, new Set(children.map((child) => child.path)));
      // Keep orphaned slugs in the tree map so the notice stays until the owner revokes or the skill returns.
      for (const orphan of orphans) trees[orphan.slug] = base[orphan.slug];
      await rebuild();
      // Routine retention after a complete pass; versions deleted earlier in this run to make room are counted too.
      quota.pruned += (await pruneGithubSkillVersions(db, ownerId)).pruned;
      await stopHeartbeat();
      const kept = compactRemoteItems(items);
      await finish(id, 'succeeded', { commit, trees, report: {
        unchanged: false, progress: { ...counters }, counts: tally(items, quota.pruned), items: kept.items, itemsOmitted: kept.omitted,
        orphans: orphans.slice(0, MAX_REPORT_ORPHANS), orphansOmitted: Math.max(0, orphans.length - MAX_REPORT_ORPHANS),
      } });
      const keep = await db.selectFrom('skill_remote_syncs').select('id').where('owner_id', '=', ownerId).orderBy('started_at', 'desc').orderBy('id', 'desc').limit(KEEP_ROWS).execute();
      await db.deleteFrom('skill_remote_syncs').where('owner_id', '=', ownerId).where('status', '<>', 'running').where('id', 'not in', keep.map((row) => row.id)).execute();
    } catch (error) {
      await stopHeartbeat();
      const code = signal.aborted || isAbort(error) ? 'SKILL_REMOTE_SYNC_ABORTED' : errorCode(error);
      console.error(JSON.stringify({ level: 'error', event: 'skill_remote_sync_failed', code }));
      // Activations made before the stop still reach the graph, and the progress so far is the next run's starting point.
      await rebuild().catch(() => undefined);
      const kept = compactRemoteItems(items);
      await finish(id, 'failed', { commit: null, trees: progress, report: {
        unchanged: false, progress: { ...counters }, counts: tally(items, quota.pruned), items: kept.items, itemsOmitted: kept.omitted, orphans: [], orphansOmitted: 0,
      }, errorCode: code }).catch(() => undefined);
    }
  }

  /** Running rows whose last heartbeat (or start, before the first one) is older than INTERRUPTED_AFTER_MS: their process died.
   * Their progress stays in the row, so the next run continues from it. */
  async function recoverStale(ownerId?: string): Promise<number> {
    let query = db.updateTable('skill_remote_syncs').set({ status: 'failed', error_code: 'SKILL_REMOTE_SYNC_INTERRUPTED', finished_at: now() })
      .where('status', '=', 'running').where(sql<Date>`COALESCE((report->>'heartbeatAt')::timestamptz, started_at)`, '<', new Date(now().getTime() - INTERRUPTED_AFTER_MS));
    if (ownerId) query = query.where('owner_id', '=', ownerId);
    return (await query.returning('id').execute()).length;
  }

  async function start(ownerId: string, cause: SkillRemoteCause): Promise<SkillRemoteStartResult> {
    const { config, transport } = ready();
    // A row left running by a process that died would otherwise block every later sync of this owner.
    await recoverStale(ownerId);
    const id = randomUUID();
    try { await db.insertInto('skill_remote_syncs').values({ id, owner_id: ownerId, repo: config.repo, ref: config.ref, path: config.path, cause, status: 'running' }).execute(); }
    catch (error) { if ((error as { code?: string } | null)?.code === '23505') throw new SkillError('SKILL_REMOTE_SYNC_RUNNING', 'توجد مزامنة جارية بالفعل.', 409); throw error; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RUN_LIMIT_MS); timer.unref();
    const promise = run(ownerId, id, cause, config, transport, controller.signal).catch(() => undefined).finally(() => { clearTimeout(timer); runs.delete(id); });
    runs.set(id, { controller, promise });
    return { started: true, syncId: id };
  }

  async function pending(ownerId: string) {
    const waiting = db.selectFrom('skill_versions as v').innerJoin('skill_families as f', 'f.id', 'v.family_id').innerJoin('skill_sources as s', 's.version_id', 'v.id')
      .where('v.owner_id', '=', ownerId).where('s.kind', '=', 'github').where('v.status', '=', 'inspected').where(sql<boolean>`f.active_version_id IS DISTINCT FROM v.id`);
    const [rows, total] = await Promise.all([
      waiting.select(['v.id', 'f.slug', 'v.name', 'v.version', 'v.content_hash']).orderBy('v.created_at', 'desc').orderBy('v.id').limit(20).execute(),
      waiting.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    const result = [];
    for (const row of rows) {
      const inspection = await db.selectFrom('skill_inspections').select('verdict').where('version_id', '=', row.id).where('content_hash', '=', row.content_hash).orderBy('created_at', 'desc').executeTakeFirst();
      result.push({ id: row.id, slug: row.slug, name: row.name, version: row.version, verdict: inspection?.verdict ?? null });
    }
    return { pending: result, pendingTotal: Number(total.n) };
  }

  async function status(ownerId: string): Promise<SkillRemoteStatus> {
    const config = options.config;
    const [lastRow, success, runningRow, used, waiting] = await Promise.all([
      db.selectFrom('skill_remote_syncs').selectAll().where('owner_id', '=', ownerId).orderBy('started_at', 'desc').orderBy('id', 'desc').executeTakeFirst(),
      db.selectFrom('skill_remote_syncs').select(['commit_sha', 'finished_at']).where('owner_id', '=', ownerId).where('status', '=', 'succeeded').orderBy('started_at', 'desc').orderBy('id', 'desc').executeTakeFirst(),
      db.selectFrom('skill_remote_syncs').select('id').where('owner_id', '=', ownerId).where('status', '=', 'running').executeTakeFirst(),
      countImportedVersions(db, ownerId, 'github'),
      pending(ownerId),
    ]);
    const last = lastRow ? syncDto(lastRow) : null;
    let nextSyncAt: string | null = null;
    if (config && options.engineEnabled && options.transport && config.intervalMinutes > 0) {
      // An estimate: the scheduler ticks 15 s after boot and then every interval; a missed tick runs at the next one.
      const scheduled = Math.max(createdAt + FIRST_TICK_MS, last ? new Date(last.startedAt).getTime() + config.intervalMinutes * 60_000 : 0);
      nextSyncAt = new Date(Math.max(scheduled, now().getTime())).toISOString();
    }
    return SkillRemoteStatusSchema.parse({
      configured: Boolean(config), engineEnabled: options.engineEnabled, problem: options.problem ?? null,
      repo: config?.repo ?? null, ref: config?.ref ?? null, path: config?.path ?? null, autoActivate: config?.autoActivate ?? false, intervalMinutes: config?.intervalMinutes ?? 0,
      running: Boolean(runningRow), last, lastSuccess: success?.commit_sha && success.finished_at ? { commit: success.commit_sha, finishedAt: iso(success.finished_at) } : null,
      nextSyncAt, pending: waiting.pending, pendingTotal: waiting.pendingTotal, quota: { used, limit: MAX_GITHUB_VERSIONS_PER_OWNER },
    });
  }

  /** Called once at boot. A live run in another process keeps its heartbeat fresh and is never taken for a dead one. */
  async function recoverInterrupted(): Promise<number> { return recoverStale(); }
  async function shutdown(): Promise<void> {
    for (const entry of runs.values()) entry.controller.abort();
    await Promise.allSettled([...runs.values()].map((entry) => entry.promise));
  }

  return { status, start, recoverInterrupted, shutdown };
}
export type SkillRemoteControl = ReturnType<typeof createSkillRemote>;
