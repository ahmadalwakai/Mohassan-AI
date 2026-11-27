import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import {
  CodingEngine, createRepairDemoProject, deterministicCodingMessage, generateDeterministicEdits,
  inspectProject, lookupImports, searchProjectFiles, type SandboxRunner,
} from '@mohassan/coding';
import { WindowsAppContainerSandbox } from '@mohassan/sandbox';
import { CodingJobPayloadSchemas } from '@mohassan/coding-link';
import { ProjectSchema, RegisterProjectSchema, type CodingWorkspace, type Project } from '@mohassan/contracts';
import { verifyRecoveryAuthority, type VerificationRecoveryContext } from '@mohassan/runtime';
import { codingDeviceRoute, createCodingDeviceLink, isCodingDeviceError, registerCodingDeviceRoutes } from './coding-link.js';

type DeviceLink = Awaited<ReturnType<typeof createCodingDeviceLink>>;
type ProjectLocation = 'server' | 'device';
type Inspection = Pick<Awaited<ReturnType<typeof inspectProject>>, 'path' | 'baseCommit' | 'candidateEditablePaths' | 'testFiles'>;

export interface CodingConfig {
  dataDir?: string;
  allowedRoots?: string[];
  sandbox?: SandboxRunner;
  deviceLink?: DeviceLink;
}
export interface CodingProjectRegistrationOptions {
  expectedBaseCommit: string;
  persist: <T>(write: (db: Kysely<any>) => Promise<T>) => Promise<T>;
  signal?: AbortSignal;
}
interface InspectionContext {
  ownerId: string;
  projectId?: string;
  signal?: AbortSignal;
}

function projectDto(row: any): Project {
  return ProjectSchema.parse({
    id: row.id, ownerId: row.owner_id, name: row.name, path: row.repo_path, baseCommit: row.base_commit,
    allowedPaths: row.allowed_paths, testProfile: row.test_profile, createdAt: new Date(row.created_at).toISOString(),
  });
}
function fault(code: string, message: string, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}
function unavailable() {
  return fault('SANDBOX_UNAVAILABLE', 'لم يثبت توفر بيئة عزل؛ لم يُشغّل كود.', 503);
}
function pathKey(path: string, location: ProjectLocation) {
  const windows = location === 'device' ? /^[a-z]:[\\/]/i.test(path) : process.platform === 'win32';
  return windows ? path.toLowerCase() : path;
}
function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export async function createCodingControl(db: Kysely<any>, config: CodingConfig) {
  const dataDir = config.dataDir ? resolve(config.dataDir) : null;
  const roots = [...(config.allowedRoots ?? []), ...(dataDir ? [dataDir] : [])];
  const sandbox = config.sandbox ?? new WindowsAppContainerSandbox();
  const isolated = dataDir ? await sandbox.available() : { available: false, provider: null, message: 'لم يُجهز مجلد عمل لمحرك البرمجة.' };
  const availability = { ...isolated, message: isolated.available ? deterministicCodingMessage : isolated.message };
  const engine = dataDir && availability.available ? new CodingEngine({ dataDir, allowedRoots: roots, sandbox, generateEdits: generateDeterministicEdits }) : null;
  const link = config.deviceLink;
  const defaultLocation: ProjectLocation = !engine && link?.enabled ? 'device' : 'server';

  function deviceLink() {
    if (!link?.enabled) throw unavailable();
    return link;
  }
  async function projects(ownerId: string) {
    return (await db.selectFrom('coding_projects').selectAll().where('owner_id', '=', ownerId)
      .orderBy('created_at', 'desc').execute()).map(projectDto);
  }
  async function workspace(ownerId: string): Promise<CodingWorkspace> {
    const device = link?.enabled ? await link.device(ownerId) : null;
    const deviceSandbox = device?.sandbox ?? { available: false, provider: null, message: 'لم يُربط جهاز لمحرك البرمجة.' };
    return { projects: await projects(ownerId), sandbox: defaultLocation === 'device' ? deviceSandbox : availability, device };
  }
  async function project(ownerId: string, id: string): Promise<{ selected: Project; location: ProjectLocation }> {
    const row = await db.selectFrom('coding_projects').selectAll().where('id', '=', id).where('owner_id', '=', ownerId).executeTakeFirst();
    if (!row) throw fault('PROJECT_NOT_FOUND', 'لم يُعثر على المشروع.', 404);
    return { selected: projectDto(row), location: row.location === 'device' ? 'device' : 'server' };
  }
  async function inspectLocal(path: string): Promise<Inspection> {
    // The implicit demo root might not exist until the first demo is created.
    const hasImplicitRoot = dataDir && await lstat(dataDir).then(() => true, (error: NodeJS.ErrnoException) => error.code !== 'ENOENT');
    const { path: canonicalPath, baseCommit, candidateEditablePaths, testFiles } = await inspectProject(path, hasImplicitRoot ? roots : config.allowedRoots ?? []);
    return { path: canonicalPath, baseCommit, candidateEditablePaths, testFiles };
  }
  async function inspect(path: string, context?: InspectionContext): Promise<Inspection> {
    const registered = context?.projectId ? await project(context.ownerId, context.projectId) : null;
    const location = registered?.location ?? defaultLocation;
    const selectedPath = registered?.selected.path ?? path;
    if (location === 'server') return inspectLocal(selectedPath);
    const ownerId = context?.ownerId ?? (await db.selectFrom('workspace_owner').select('owner_id').where('id', '=', 1).executeTakeFirst())?.owner_id;
    return deviceLink().run(ownerId ?? '', { kind: 'inspect', payload: { path: selectedPath } },
      { projectId: registered?.selected.id, signal: context?.signal });
  }
  async function saveProject(ownerId: string, name: string, requestedPaths: string[], inspected: Inspection,
    location: ProjectLocation, options?: CodingProjectRegistrationOptions): Promise<Project> {
    if (options && inspected.baseCommit !== options.expectedBaseCommit) {
      throw fault('PROJECT_HEAD_CHANGED', 'تغير HEAD منذ طلب الموافقة؛ يلزم طلب موافقة جديد لتسجيل المشروع.');
    }
    const allowedPaths = [...new Set(requestedPaths)].sort();
    if (allowedPaths.length !== requestedPaths.length || allowedPaths.some(path => !inspected.candidateEditablePaths.includes(path))) {
      throw fault('INVALID_EDIT_SCOPE', 'اختر ملفات تنفيذ موجودة؛ الاختبارات والإعدادات محمية.', 400);
    }
    const scope = [pathKey(inspected.path, location), inspected.baseCommit, allowedPaths];
    const scopeHash = digest(JSON.stringify(location === 'device' ? [location, ...scope] : scope));
    const write = async (connection: Kysely<any>): Promise<Project> => {
      const row = await connection.insertInto('coding_projects').values({
        id: randomUUID(), owner_id: ownerId, name, repo_path: inspected.path, base_commit: inspected.baseCommit,
        allowed_paths: JSON.stringify(allowedPaths), test_profile: 'node-test', scope_hash: scopeHash, location,
      }).onConflict(conflict => conflict.columns(['owner_id', 'scope_hash']).doNothing()).returningAll().executeTakeFirst();
      return projectDto(row ?? await connection.selectFrom('coding_projects').selectAll().where('owner_id', '=', ownerId)
        .where('scope_hash', '=', scopeHash).executeTakeFirstOrThrow());
    };
    return options ? options.persist(write) : write(db);
  }
  async function register(ownerId: string, input: unknown, options?: CodingProjectRegistrationOptions): Promise<Project> {
    if (!dataDir && defaultLocation === 'server') throw fault('CODING_NOT_CONFIGURED', 'محرك البرمجة غير مجهز.', 503);
    const request = RegisterProjectSchema.parse(input);
    const inspected = await inspect(request.path, { ownerId, signal: options?.signal });
    return saveProject(ownerId, request.name, request.allowedPaths, inspected, defaultLocation, options);
  }
  async function demo(ownerId: string): Promise<Project> {
    const name = 'مشروع تجربة الجمع';
    if (defaultLocation === 'device') {
      const created = await deviceLink().run(ownerId, { kind: 'demo', payload: { ownerId } });
      return saveProject(ownerId, name, created.allowedPaths, created, 'device');
    }
    if (!dataDir) throw fault('CODING_NOT_CONFIGURED', 'محرك البرمجة غير مجهز.', 503);
    const created = await createRepairDemoProject(join(dataDir, 'demos', digest(ownerId).slice(0, 20)));
    return register(ownerId, { name, path: created.path, allowedPaths: created.allowedPaths });
  }
  async function execute(goal: string, context: {
    signal: AbortSignal; taskId: string; ownerId: string; projectId: string; leaseToken: string;
    onProgress?: (stage: string, message: string) => Promise<void>;
    onModelReceipt?: (receipt: { model: string; usage: { inputTokens: number; outputTokens: number } }) => Promise<void>;
  }) {
    const { ownerId, projectId, taskId, signal, leaseToken, onProgress, onModelReceipt } = context;
    if ((await db.selectFrom('tasks').select('verification_only').where('id', '=', taskId)
      .where('owner_id', '=', ownerId).executeTakeFirst())?.verification_only) {
      throw fault('SKILL_VERIFY_READ_ONLY', 'استعادة التحقق لا تسمح بتنفيذ جديد.');
    }
    if (!engine && !link?.enabled) throw unavailable();
    const { selected, location } = await project(ownerId, projectId);
    if (location === 'server' && !engine) throw unavailable();
    if (location === 'device') deviceLink();
    const resource = digest(JSON.stringify([location, pathKey(selected.path, location)]));
    const token = randomUUID();
    const claimed = await sql<{ token: string }>`INSERT INTO coding_project_locks(resource_key,project_id,task_id,token,expires_at)
      VALUES(${resource},${selected.id},${taskId},${token},CURRENT_TIMESTAMP+interval '240 seconds')
      ON CONFLICT(resource_key) DO UPDATE SET project_id=EXCLUDED.project_id,task_id=EXCLUDED.task_id,token=EXCLUDED.token,expires_at=EXCLUDED.expires_at
      WHERE coding_project_locks.expires_at<CURRENT_TIMESTAMP RETURNING token`.execute(db);
    if (claimed.rows[0]?.token !== token) throw fault('PROJECT_BUSY', 'توجد مهمة أخرى تعمل على هذا المشروع.');
    let release = true;
    try {
      if (location === 'device') {
        return await deviceLink().run(ownerId, { kind: 'execute', payload: { project: selected, goal, taskId } },
          { projectId, leaseToken, signal, onProgress });
      }
      return await engine!.execute({ taskId, ownerId, goal, project: selected, signal, onProgress, onModelReceipt });
    } catch (error) {
      // A replacement device can point at the same checkout while an unconfirmed run is still stopping.
      if (location === 'device' && link?.enabled) {
        const unknown = isCodingDeviceError(error) && error.code === 'CODING_DEVICE_RESULT_UNKNOWN';
        const abortUnconfirmed = signal.aborted && await db.transaction()
          .execute(tx => link.recoverDeviceDispatch(tx, ownerId, taskId)).catch(() => true);
        release = !unknown && !abortUnconfirmed;
      }
      throw error;
    } finally {
      if (release) await db.deleteFrom('coding_project_locks').where('resource_key', '=', resource).where('token', '=', token).execute();
    }
  }
  async function verify(raw: unknown, context: {
    taskId: string; ownerId: string; projectId: string; signal: AbortSignal;
  } & VerificationRecoveryContext) {
    if ((!engine && !link?.enabled) || !await verifyRecoveryAuthority(db, context)) return null;
    const { selected, location } = await project(context.ownerId, context.projectId);
    const result = location === 'device'
      ? await verifyOnDevice(raw, selected, context.taskId, context.signal)
      : await engine?.verify(raw, { taskId: context.taskId, project: selected, signal: context.signal }) ?? null;
    return await verifyRecoveryAuthority(db, context) ? result : null;
  }
  async function verifyOnDevice(raw: unknown, selected: Project, taskId: string, signal: AbortSignal) {
    const parsed = CodingJobPayloadSchemas.verify.safeParse({ project: selected, taskId, result: raw });
    if (!parsed.success) return null;
    return deviceLink().run(selected.ownerId, { kind: 'verify', payload: parsed.data },
      { projectId: selected.id, signal });
  }
  async function instructions(ownerId: string, projectId: string, baseCommit?: string) {
    const { selected, location } = await project(ownerId, projectId);
    if (location === 'device') {
      return await deviceLink().run(ownerId, { kind: 'instructions', payload: { project: selected, baseCommit } }, { projectId }) ?? undefined;
    }
    const inspected = await inspectProject(selected.path, roots);
    if (baseCommit && inspected.baseCommit !== baseCommit) throw fault('PROJECT_HEAD_CHANGED', 'تغير HEAD منذ الفحص.');
    return inspected.instructions;
  }
  async function trackedPaths(ownerId: string, projectId: string, baseCommit: string) {
    const { selected, location } = await project(ownerId, projectId);
    if (selected.baseCommit !== baseCommit) return [];
    if (location === 'device') {
      return deviceLink().run(ownerId, { kind: 'trackedPaths', payload: { project: selected, baseCommit } }, { projectId });
    }
    const inspected = await inspectProject(selected.path, roots);
    return inspected.baseCommit === baseCommit ? inspected.files.map(file => file.path) : [];
  }
  async function search(ownerId: string, projectId: string, query: string) {
    const { selected, location } = await project(ownerId, projectId);
    if (location === 'device') return deviceLink().run(ownerId, { kind: 'search', payload: { project: selected, query } }, { projectId });
    return searchProjectFiles((await inspectProject(selected.path, roots)).files, query);
  }
  async function imports(ownerId: string, projectId: string, reference: string) {
    const { selected, location } = await project(ownerId, projectId);
    if (location === 'device') return deviceLink().run(ownerId, { kind: 'imports', payload: { project: selected, reference } }, { projectId });
    return lookupImports((await inspectProject(selected.path, roots)).files, reference);
  }
  async function check(ownerId: string, projectId: string, signal: AbortSignal) {
    if (!engine && !link?.enabled) throw unavailable();
    const { selected, location } = await project(ownerId, projectId);
    if (location === 'device') return deviceLink().run(ownerId, { kind: 'check', payload: { project: selected } }, { projectId, signal });
    if (!engine) throw unavailable();
    return engine.check({ ownerId, project: selected, signal });
  }
  return {
    available: Boolean(engine || link?.enabled), workspace, projects, inspect, register, demo,
    execute: Object.assign(execute, { recoverDeviceDispatch: link?.recoverDeviceDispatch }),
    verify, sandbox, search, imports, check, trackedPaths, instructions,
  };
}

export async function createApplicationCoding(db: Kysely<any>, config: {
  codingDataDir?: string; codingAllowedRoots?: string[]; sandboxRunner?: SandboxRunner; codingDeviceLink?: boolean;
}) {
  const link = await createCodingDeviceLink(db, { enabled: config.codingDeviceLink === true });
  const coding = await createCodingControl(db, {
    dataDir: config.codingDataDir, allowedRoots: config.codingAllowedRoots, sandbox: config.sandboxRunner, deviceLink: link,
  });
  function mountCodingRoutes(app: FastifyInstance, owner: (request: FastifyRequest) => Promise<{ id: string; sessionId: string }>) {
    const errorHandler = (error: unknown, request: FastifyRequest, reply: Parameters<typeof app.errorHandler>[2]) => {
      if (isCodingDeviceError(error)) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return app.errorHandler(error, request, reply);
    };
    registerCodingDeviceRoutes(app, link, owner);
    app.get('/api/coding/projects', async request => coding.workspace((await owner(request)).id));
    app.post('/api/coding/projects', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, errorHandler },
      async request => coding.register((await owner(request)).id, request.body));
    app.post('/api/coding/projects/demo', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, errorHandler }, async request => {
      const user = await owner(request);
      z.strictObject({}).parse(request.body ?? {});
      return coding.demo(user.id);
    });
  }
  return { coding, mountCodingRoutes, codingDeviceRoute };
}
