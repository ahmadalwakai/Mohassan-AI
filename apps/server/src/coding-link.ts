import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';
import { CodingDeviceListSchema, CodingDevicePairingSchema, type CodingDevice } from '@mohassan/contracts';
import {
  CODING_DEVICE_POLL_BODY_LIMIT, CODING_DEVICE_POLL_INTERVAL_MS, CODING_DEVICE_PROTOCOL_VERSION,
  CODING_EXECUTE_LEASE_MARGIN_MS, CODING_JOB_DEADLINES_MS, CODING_RESULT_HEADERS,
  CodingFinishedResultSchema, CodingJobResultSchemas, CodingJobSchema,
  CodingPairRequestSchema, CodingPairResponseSchema, CodingPollRequestSchema, CodingPollResponseSchema,
  type CodingJobKind, type CodingJobPayloads, type CodingJobResults,
} from '@mohassan/coding-link';
import { migrateCodingDeviceLink } from './coding-link-migration.js';
import { roleOf } from './members.js';

const pairPath = '/api/coding/device/pair';
const pollPath = '/api/coding/device/poll';
const devicesPath = '/api/coding/devices';
const pairValidityMs = 120_000;
const nonceWindowMs = 60_000;
const onlineWindowMs = 15_000;
const resultTimestamp = z.iso.datetime();
const uuid = z.uuid();
const emptyBody = z.strictObject({});
const loopbacks = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const decode = (value: unknown) => typeof value === 'string' ? JSON.parse(value) as unknown : value;
const instant = (value: Date | string) => new Date(value).getTime();

export function codingDeviceRoute(request: Pick<FastifyRequest, 'method' | 'url'>) {
  const path = request.url.split('?', 1)[0];
  return request.method === 'POST' && (path === pairPath || path === pollPath);
}

class CodingDeviceError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) { super(message); }
}
export function isCodingDeviceError(error: unknown): error is CodingDeviceError {
  return error instanceof CodingDeviceError;
}

const failureMessages = {
  CODING_DEVICE_DISABLED: 'ربط جهاز البرمجة غير مفعّل.',
  CODING_DEVICE_NOT_PAIRED: 'لم يُربط جهاز برمجة بحساب المالك.',
  CODING_DEVICE_OFFLINE: 'جهاز البرمجة المرتبط غير متصل.',
  CODING_DEVICE_SANDBOX_UNAVAILABLE: 'جهاز البرمجة متصل، وبيئة العزل عليه غير جاهزة.',
  CODING_DEVICE_TIMEOUT: 'انتهت مهلة مهمة البرمجة قبل إرسالها للجهاز.',
  CODING_DEVICE_RESULT_UNKNOWN: 'لم تصل نتيجة مهمة البرمجة من الجهاز. لن تُعاد المهمة تلقائيًا.',
  CODING_DEVICE_PATH_DENIED: 'مسار المشروع خارج المجلدات المسموحة على جهاز البرمجة.',
  CODING_DEVICE_VERSION: 'إصدار بروتوكول جهاز البرمجة غير متوافق مع الخادم.',
  CODING_DEVICE_BAD_RESULT: 'أرسل جهاز البرمجة نتيجة لا تطابق المهمة.',
  CODING_DEVICE_RESULT_TOO_LARGE: 'تجاوزت نتيجة جهاز البرمجة الحجم المسموح.',
  CODING_DEVICE_CANCELLED: 'أُلغيت مهمة البرمجة.',
} as const;

function fault(code: keyof typeof failureMessages, statusCode = 409) {
  return new CodingDeviceError(code, failureMessages[code], statusCode);
}

function codingFailure(code: string, message: unknown) {
  const known = failureMessages[code as keyof typeof failureMessages];
  if (code === 'CODING_DEVICE_TIMEOUT') return fault(code, 504);
  if (code === 'CODING_DEVICE_PATH_DENIED') return fault(code, 403);
  if (code === 'CODING_DEVICE_RESULT_TOO_LARGE') return fault(code, 413);
  if (known) return new CodingDeviceError(code, known);
  if (code === 'NO_PROVEN_FIX' && typeof message === 'string' && message.startsWith('تعذرت إعادة التسمية: ')) {
    const error = new CodingDeviceError(code, message);
    error.name = 'CodingError';
    return error;
  }
  return new CodingDeviceError(code, 'تعذر إكمال العمل على جهاز البرمجة.', 400);
}

interface OwnerSession { id: string; sessionId: string }
type JobRequest = z.infer<typeof CodingJobSchema>;
type JobStatus = 'queued' | 'dispatched' | 'succeeded' | 'failed' | 'cancelled' | 'expired' | 'unknown';
interface DispatchedJob { id: string; kind: string; payload: unknown; deadline_at: Date | string; progress: unknown }
type PollRequest = z.infer<typeof CodingPollRequestSchema>;
type Progress = PollRequest['progress'][number];
interface JobOptions {
  projectId?: string;
  signal?: AbortSignal;
  leaseToken?: string;
  onProgress?: (stage: string, message: string) => Promise<void>;
}

function assertDeviceTransport(request: FastifyRequest) {
  if (request.headers.origin !== undefined || Object.keys(request.headers).some(key => key.startsWith('sec-fetch-'))) {
    throw new CodingDeviceError('CODING_DEVICE_BROWSER_DENIED', 'هذا المسار مخصص لجهاز البرمجة المحلي.', 403);
  }
  const proxy = loopbacks.has(request.ip);
  const forwardedFor = request.headers['x-forwarded-for'];
  const forwardedFromLoopback = typeof forwardedFor === 'string' && loopbacks.has(forwardedFor.trim());
  const local = proxy && (forwardedFor === undefined || forwardedFromLoopback);
  if (!local && request.protocol !== 'https' && !(proxy && request.headers['x-forwarded-proto'] === 'https')) {
    throw new CodingDeviceError('CODING_DEVICE_TLS_REQUIRED', 'يحتاج جهاز البرمجة البعيد اتصال HTTPS.', 403);
  }
}

export async function createCodingDeviceLink(db: Kysely<any>, options: { enabled: boolean; now?: () => number }) {
  const { enabled, now = Date.now } = options;
  await migrateCodingDeviceLink(db);

  function requireEnabled() {
    if (!enabled) throw fault('CODING_DEVICE_DISABLED', 503);
  }

  function currentDevice(ownerId: string, tx: Kysely<any> = db) {
    return tx.selectFrom('coding_devices').select(['id', 'owner_id', 'name', 'last_seen_at', 'protocol_version', 'sandbox'])
      .where('owner_id', '=', ownerId).where('revoked_at', 'is', null);
  }

  function online(row: { last_seen_at: Date | string | null }) {
    return row.last_seen_at !== null && now() - instant(row.last_seen_at) < onlineWindowMs;
  }

  async function device(ownerId: string): Promise<CodingDevice | null> {
    if (!enabled) return null;
    const row = await currentDevice(ownerId).executeTakeFirst();
    if (!row) return null;
    const connected = online(row);
    const sandbox = connected
      ? row.protocol_version === CODING_DEVICE_PROTOCOL_VERSION
        ? decode(row.sandbox) as CodingDevice['sandbox']
        : { available: false, provider: null, message: failureMessages.CODING_DEVICE_VERSION }
      : { available: false, provider: null, message: failureMessages.CODING_DEVICE_OFFLINE };
    return { id: row.id, name: row.name, online: connected,
      lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null, sandbox };
  }

  async function audit(tx: Kysely<any>, ownerId: string, deviceId: string | null, event: string, outcome: string,
    job?: { id: string; kind: string; project_id: string | null }) {
    await tx.insertInto('coding_device_audit').values({
      id: randomUUID(), owner_id: ownerId, device_id: deviceId, event, outcome_code: outcome,
      job_id: job?.id ?? null, kind: job?.kind ?? null, project_id: job?.project_id ?? null,
    }).execute();
  }

  async function finishJobs(tx: Kysely<any>, ownerId: string, deviceId: string, from: JobStatus, to: JobStatus,
    code: string, filters: { id?: string; deadline?: Date; result?: unknown; message?: string | null; cancel?: boolean } = {}) {
    let query = tx.updateTable('coding_device_jobs').set({
      status: to, result_code: code, payload: null, finished_at: new Date(now()),
      result: filters.result === undefined ? null : JSON.stringify(filters.result),
      result_message: filters.message ?? null,
      ...(filters.cancel ? { cancel_requested_at: new Date(now()) } : {}),
    }).where('device_id', '=', deviceId).where('status', '=', from);
    if (filters.id) query = query.where('id', '=', filters.id);
    if (filters.deadline) query = query.where('deadline_at', '<=', filters.deadline);
    const rows = await query.returning(['id', 'kind', 'project_id']).execute();
    for (const job of rows) await audit(tx, ownerId, deviceId, 'result', code, job);
  }

  async function expireJobs(tx: Kysely<any>, ownerId: string, deviceId: string, id?: string) {
    const filters = { id, deadline: new Date(now()) };
    await finishJobs(tx, ownerId, deviceId, 'queued', 'expired', 'CODING_DEVICE_TIMEOUT', filters);
    await finishJobs(tx, ownerId, deviceId, 'dispatched', 'unknown', 'CODING_DEVICE_RESULT_UNKNOWN', filters);
  }

  async function revokeLocked(tx: Kysely<any>, row: { id: string; owner_id: string }, reason: string) {
    await tx.updateTable('coding_devices').set({ revoked_at: new Date(now()) }).where('id', '=', row.id).execute();
    await finishJobs(tx, row.owner_id, row.id, 'queued', 'cancelled', 'CODING_DEVICE_CANCELLED');
    await finishJobs(tx, row.owner_id, row.id, 'dispatched', 'unknown', 'CODING_DEVICE_RESULT_UNKNOWN');
    await audit(tx, row.owner_id, row.id, 'revoked', reason);
  }

  async function ownerLock(tx: Kysely<any>, ownerId: string) {
    // Serialize pairing and revocation while allowing the audit foreign key to check the same owner.
    await tx.selectFrom('user').select('id').where('id', '=', ownerId).forNoKeyUpdate().executeTakeFirstOrThrow();
  }

  async function createPairing(user: OwnerSession) {
    requireEnabled();
    const code = randomBytes(12).toString('base64url');
    const expiresAt = new Date(now() + pairValidityMs);
    await db.transaction().execute(async tx => {
      await ownerLock(tx, user.id);
      const session = await tx.selectFrom('session').select('id').where('id', '=', user.sessionId)
        .where('userId', '=', user.id).where('expiresAt', '>', new Date(now())).forShare().executeTakeFirst();
      if (!session) throw new CodingDeviceError('UNAUTHORIZED', 'سجل الدخول للمتابعة.', 401);
      await tx.deleteFrom('coding_device_pairings').where('owner_id', '=', user.id).where('consumed_at', 'is', null).execute();
      await tx.insertInto('coding_device_pairings').values({
        id: randomUUID(), owner_id: user.id, code_hash: digest(code), session_hash: digest(user.sessionId), expires_at: expiresAt,
      }).execute();
      await audit(tx, user.id, null, 'pairing_created', 'ISSUED');
    });
    return CodingDevicePairingSchema.parse({ code, expiresAt: expiresAt.toISOString() });
  }

  async function pair(input: z.infer<typeof CodingPairRequestSchema>) {
    requireEnabled();
    const deviceKey = randomBytes(32).toString('base64url');
    const deviceId = randomUUID();
    return db.transaction().execute(async tx => {
      const query = tx.selectFrom('coding_device_pairings').selectAll().where('code_hash', '=', digest(input.code));
      const candidate = await query.executeTakeFirst();
      const invalid = () => new CodingDeviceError('CODING_DEVICE_PAIRING_INVALID', 'رمز الربط غير صالح أو انتهت صلاحيته.', 401);
      if (!candidate || candidate.consumed_at || instant(candidate.expires_at) <= now()) throw invalid();
      // The owner row serializes issuing, consuming and replacing a pairing.
      await ownerLock(tx, candidate.owner_id);
      const pairing = await query.forUpdate().executeTakeFirst();
      if (!pairing || pairing.consumed_at || instant(pairing.expires_at) <= now() || await roleOf(tx, pairing.owner_id) !== 'owner') throw invalid();
      const session = await tx.selectFrom('session').select('id').where('userId', '=', pairing.owner_id)
        .where('expiresAt', '>', new Date(now()))
        .where(sql<string>`encode(sha256(convert_to(id, 'UTF8')), 'hex')`, '=', pairing.session_hash).forShare().executeTakeFirst();
      if (!session) throw invalid();
      const previous = await currentDevice(pairing.owner_id, tx).forUpdate().executeTakeFirst();
      if (previous) await revokeLocked(tx, previous, 'REPLACED');
      await tx.updateTable('coding_device_pairings').set({ consumed_at: new Date(now()) }).where('id', '=', pairing.id).execute();
      await tx.insertInto('coding_devices').values({ id: deviceId, name: input.name, key_hash: digest(deviceKey), owner_id: pairing.owner_id }).execute();
      await audit(tx, pairing.owner_id, deviceId, 'paired', 'PAIRED');
      return CodingPairResponseSchema.parse({ deviceId, deviceKey, pollIntervalMs: CODING_DEVICE_POLL_INTERVAL_MS });
    });
  }

  async function revoke(ownerId: string, deviceId: string) {
    requireEnabled();
    return db.transaction().execute(async tx => {
      await ownerLock(tx, ownerId);
      const row = await currentDevice(ownerId, tx).where('id', '=', deviceId).forUpdate().executeTakeFirst();
      if (!row) throw new CodingDeviceError('CODING_DEVICE_NOT_FOUND', 'لم يُعثر على جهاز البرمجة.', 404);
      await revokeLocked(tx, row, 'REVOKED');
      return { revoked: true };
    });
  }

  async function authenticate(tx: Kysely<any>, authorization: string | undefined) {
    const credentials = /^Bearer ([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
    const denied = () => new CodingDeviceError('CODING_DEVICE_UNAUTHORIZED', 'مفتاح جهاز البرمجة غير صالح.', 401);
    if (!credentials) throw denied();
    const row = await tx.selectFrom('coding_devices').selectAll().where('id', '=', credentials[1]!).forUpdate().executeTakeFirst();
    const equal = timingSafeEqual(Buffer.from(row?.key_hash ?? '0'.repeat(64), 'hex'), Buffer.from(digest(credentials[2]!), 'hex'));
    if (!row || row.revoked_at || !equal) throw denied();
    return row;
  }

  async function claimNonce(tx: Kysely<any>, deviceId: string, nonce: string, sentAt: string) {
    const sent = instant(sentAt);
    if (Math.abs(now() - sent) > nonceWindowMs) {
      throw new CodingDeviceError('CODING_DEVICE_STALE_POLL', 'وقت إرسال طلب الجهاز خارج المهلة المسموحة.', 409);
    }
    const claimed = await tx.insertInto('coding_device_nonces').values({
      device_id: deviceId, nonce, expires_at: new Date(sent + nonceWindowMs),
    }).onConflict(conflict => conflict.doNothing()).returning('nonce').executeTakeFirst();
    if (!claimed) throw new CodingDeviceError('CODING_DEVICE_REPLAY', 'سبق استلام طلب الجهاز هذا.', 409);
  }

  async function saveProgress(tx: Kysely<any>, active: { id: string; progress: unknown }, incoming: Progress[]) {
    const previous = decode(active.progress) as Progress[];
    const last = previous.at(-1)?.seq ?? 0;
    const additions = [...new Map(incoming.filter(event => event.jobId === active.id && event.seq > last)
      .map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq);
    if (additions.length && previous.length < 128) {
      await tx.updateTable('coding_device_jobs').set({ progress: JSON.stringify([...previous, ...additions].slice(0, 128)) })
        .where('id', '=', active.id).where('status', '=', 'dispatched').execute();
    }
  }

  function resultMatchesJob(job: JobRequest, result: unknown) {
    if (job.kind !== 'check' && job.kind !== 'execute' && job.kind !== 'verify') return true;
    if (job.kind === 'verify' && result === null) return true;
    const receipt = result as { projectId: string; baseCommit: string; branch?: string };
    return receipt.projectId === job.payload.project.id && receipt.baseCommit === job.payload.project.baseCommit
      && (job.kind === 'check' || receipt.branch === `mohassan/${job.payload.taskId}`);
  }

  async function acceptResult(tx: Kysely<any>, ownerId: string, deviceId: string, active: DispatchedJob | undefined, raw: unknown) {
    const finished = CodingFinishedResultSchema.safeParse(raw);
    const rawJobId = raw && typeof raw === 'object' && 'jobId' in raw ? raw.jobId : undefined;
    if (finished.success && finished.data.status === 'cancelled' && finished.data.jobId !== active?.id) {
      const cancelled = await tx.selectFrom('coding_device_jobs').select('id').where('id', '=', finished.data.jobId)
        .where('device_id', '=', deviceId).where('status', '=', 'unknown').where('cancel_requested_at', 'is not', null).executeTakeFirst();
      if (cancelled) await finishJobs(tx, ownerId, deviceId, 'unknown', 'cancelled', 'CODING_DEVICE_CANCELLED', { id: cancelled.id });
      return;
    }
    // A delayed response for a different job cannot affect the current dispatch.
    if (!active || typeof rawJobId === 'string' && uuid.safeParse(rawJobId).success && rawJobId !== active.id) return;
    const id = active.id;
    const invalid = () => finishJobs(tx, ownerId, deviceId, 'dispatched', 'failed', 'CODING_DEVICE_BAD_RESULT', { id });
    if (!finished.success) { await invalid(); return; }
    const result = finished.data;
    if (result.status === 'cancelled') {
      await finishJobs(tx, ownerId, deviceId, 'dispatched', 'cancelled', 'CODING_DEVICE_CANCELLED', { id });
      return;
    }
    if (result.status === 'failed') {
      const message = result.code === 'NO_PROVEN_FIX' && result.message?.startsWith('تعذرت إعادة التسمية: ') ? result.message : null;
      await finishJobs(tx, ownerId, deviceId, 'dispatched', 'failed', result.code, { id, message });
      return;
    }
    const job = CodingJobSchema.parse({ id, kind: active.kind, payload: decode(active.payload), deadlineAt: new Date(active.deadline_at).toISOString() });
    const validated = CodingJobResultSchemas[job.kind].safeParse(result.value);
    if (!validated.success || !resultMatchesJob(job, validated.data)) { await invalid(); return; }
    await finishJobs(tx, ownerId, deviceId, 'dispatched', 'succeeded', 'SUCCEEDED', { id, result: validated.data });
  }

  async function poll(authorization: string | undefined, input: PollRequest) {
    requireEnabled();
    const response = await db.transaction().execute(async tx => {
      const { id, owner_id: ownerId } = await authenticate(tx, authorization);
      await claimNonce(tx, id, input.nonce, input.sentAt);
      const version = input.status.protocolVersion;
      await tx.updateTable('coding_devices').set({
        last_seen_at: new Date(now()), protocol_version: version === CODING_DEVICE_PROTOCOL_VERSION ? version : null,
        sandbox: JSON.stringify(input.status.sandbox),
      }).where('id', '=', id).execute();
      if (version !== CODING_DEVICE_PROTOCOL_VERSION) return null;
      await expireJobs(tx, ownerId, id);
      const active = await tx.selectFrom('coding_device_jobs').select(['id', 'kind', 'payload', 'deadline_at', 'progress']).where('device_id', '=', id)
        .where('status', '=', 'dispatched').forUpdate().executeTakeFirst();
      if (active && input.progress.length) await saveProgress(tx, active, input.progress);
      if (input.result !== null) await acceptResult(tx, ownerId, id, active, input.result);
      const cancel = await tx.selectFrom('coding_device_jobs').select('id').where('device_id', '=', id)
        .where('status', '=', 'unknown').where('cancel_requested_at', 'is not', null)
        .where('deadline_at', '>', new Date(now() - nonceWindowMs)).orderBy('cancel_requested_at', 'desc').limit(32).execute();
      const cancelIds = cancel.map(row => row.id);
      if (!input.status.sandbox.available || input.activeJobId) return { job: null, cancel: cancelIds };
      const stillActive = await tx.selectFrom('coding_device_jobs').select('id').where('device_id', '=', id)
        .where('status', '=', 'dispatched').executeTakeFirst();
      if (stillActive) return { job: null, cancel: cancelIds };
      const next = await tx.selectFrom('coding_device_jobs').select(['id', 'kind', 'payload', 'deadline_at', 'project_id']).where('device_id', '=', id)
        .where('status', '=', 'queued').where('deadline_at', '>', new Date(now()))
        .orderBy('created_at').orderBy('id').limit(1).forUpdate().executeTakeFirst();
      if (!next) return { job: null, cancel: cancelIds };
      const job = CodingJobSchema.parse({ id: next.id, kind: next.kind, payload: decode(next.payload), deadlineAt: new Date(next.deadline_at).toISOString() });
      await tx.updateTable('coding_device_jobs').set({ status: 'dispatched', dispatched_at: new Date(now()) })
        .where('id', '=', next.id).execute();
      await audit(tx, ownerId, id, 'dispatch', 'DISPATCHED', next);
      return { job, cancel: cancelIds };
    });
    if (!response) throw fault('CODING_DEVICE_VERSION');
    return CodingPollResponseSchema.parse(response);
  }

  async function oversizedResult(request: FastifyRequest) {
    requireEnabled();
    assertDeviceTransport(request);
    const id = uuid.safeParse(request.headers[CODING_RESULT_HEADERS.jobId]);
    const nonce = uuid.safeParse(request.headers[CODING_RESULT_HEADERS.nonce]);
    const sentAt = resultTimestamp.safeParse(request.headers[CODING_RESULT_HEADERS.sentAt]);
    if (id.success && nonce.success && sentAt.success) {
      await db.transaction().execute(async tx => {
        const row = await authenticate(tx, request.headers.authorization);
        await claimNonce(tx, row.id, nonce.data, sentAt.data);
        await expireJobs(tx, row.owner_id, row.id);
        await finishJobs(tx, row.owner_id, row.id, 'dispatched', 'failed', 'CODING_DEVICE_RESULT_TOO_LARGE', { id: id.data });
      });
    }
    throw fault('CODING_DEVICE_RESULT_TOO_LARGE', 413);
  }

  async function run<K extends CodingJobKind>(ownerId: string, request: { kind: K; payload: CodingJobPayloads[K] },
    { projectId, signal, leaseToken, onProgress }: JobOptions = {}): Promise<CodingJobResults[K]> {
    requireEnabled();
    signal?.throwIfAborted();
    const id = randomUUID();
    const job = CodingJobSchema.parse({ ...request, id, deadlineAt: new Date(now() + CODING_JOB_DEADLINES_MS[request.kind]).toISOString() });
    const selectedProject = 'project' in job.payload ? job.payload.project : undefined;
    if (selectedProject && (selectedProject.ownerId !== ownerId || projectId && projectId !== selectedProject.id)) {
      throw new CodingDeviceError('PROJECT_FORBIDDEN', 'المشروع خارج النطاق المصرح.', 403);
    }
    const taskId = job.kind === 'execute' ? job.payload.taskId : null;
    const deviceId = await db.transaction().execute(async tx => {
      let deadline = instant(job.deadlineAt);
      if (taskId) {
        if (!leaseToken) throw new CodingDeviceError('CODING_AUTHORIZATION_LOST', 'لم يعد تفويض مهمة البرمجة صالحًا.');
        const task = await tx.selectFrom('tasks').select(['lease_expires_at', 'verification_only', 'cancellation_requested'])
          .where('id', '=', taskId).where('owner_id', '=', ownerId).where('lease_token', '=', leaseToken)
          .where('status', '=', 'running').where('project_id', '=', selectedProject!.id).forShare().executeTakeFirst();
        if (!task?.lease_expires_at || task.verification_only || task.cancellation_requested) {
          throw new CodingDeviceError('CODING_AUTHORIZATION_LOST', 'لم يعد تفويض مهمة البرمجة صالحًا.');
        }
        deadline = Math.min(deadline, instant(task.lease_expires_at) - CODING_EXECUTE_LEASE_MARGIN_MS);
      }
      if (taskId) {
        const previous = await tx.selectFrom('coding_device_jobs').select(['status', 'result_code', 'result_message'])
          .where('task_id', '=', taskId).executeTakeFirst();
        if (previous) throw codingFailure(
          previous.status === 'queued' || previous.status === 'dispatched' || previous.status === 'succeeded'
            ? 'CODING_DEVICE_RESULT_UNKNOWN' : previous.result_code,
          previous.result_message,
        );
      }
      if (deadline <= now()) throw fault('CODING_DEVICE_TIMEOUT', 504);
      const target = await currentDevice(ownerId, tx).forUpdate().executeTakeFirst();
      if (!target) throw fault('CODING_DEVICE_NOT_PAIRED', 503);
      if (!online(target)) throw fault('CODING_DEVICE_OFFLINE', 503);
      if (target.protocol_version !== CODING_DEVICE_PROTOCOL_VERSION) throw fault('CODING_DEVICE_VERSION');
      const sandbox = decode(target.sandbox) as CodingDevice['sandbox'];
      if (!sandbox.available) throw fault('CODING_DEVICE_SANDBOX_UNAVAILABLE', 503);
      signal?.throwIfAborted();
      const inserted = await tx.insertInto('coding_device_jobs').values({
        id, device_id: target.id, project_id: selectedProject?.id ?? projectId ?? null, task_id: taskId, kind: job.kind,
        payload: JSON.stringify(job.payload), status: 'queued', deadline_at: new Date(deadline),
      }).onConflict(conflict => conflict.column('task_id').doNothing()).returning('id').executeTakeFirst();
      if (!inserted) throw fault('CODING_DEVICE_RESULT_UNKNOWN');
      return target.id as string;
    });
    let cancellation: Promise<void> | undefined;
    const cancel = () => cancellation ??= db.transaction().execute(async tx => {
      await finishJobs(tx, ownerId, deviceId, 'queued', 'cancelled', 'CODING_DEVICE_CANCELLED', { id });
      await finishJobs(tx, ownerId, deviceId, 'dispatched', 'unknown', 'CODING_DEVICE_RESULT_UNKNOWN', { id, cancel: true });
    });
    const onAbort = () => { void cancel().catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    let delivered = 0;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const row = await db.selectFrom('coding_device_jobs').select(['status', 'deadline_at', 'progress', 'result', 'result_code', 'result_message'])
          .where('id', '=', id).executeTakeFirstOrThrow();
        if (onProgress) {
          const progress = decode(row.progress) as Progress[];
          for (const event of progress.slice(delivered)) await onProgress(event.stage, event.message);
          delivered = progress.length;
        }
        signal?.throwIfAborted();
        if (row.status === 'succeeded') return decode(row.result) as CodingJobResults[K];
        if (row.status !== 'queued' && row.status !== 'dispatched') {
          throw codingFailure(row.result_code, row.result_message);
        }
        if (instant(row.deadline_at) <= now()) {
          await db.transaction().execute(tx => expireJobs(tx, ownerId, deviceId, id));
          continue;
        }
        await delay(100, undefined, { signal });
      }
    } catch (error) {
      if (signal?.aborted || !isCodingDeviceError(error)) await cancel().catch(() => {});
      signal?.throwIfAborted();
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function maintain() {
    const due = await db.selectFrom('coding_device_jobs').innerJoin('coding_devices', 'coding_devices.id', 'coding_device_jobs.device_id')
      .select(['device_id', 'owner_id']).distinct().where('deadline_at', '<=', new Date(now()))
      .where('status', 'in', ['queued', 'dispatched']).execute();
    for (const row of due) await db.transaction().execute(tx => expireJobs(tx, row.owner_id, row.device_id));
    await db.deleteFrom('coding_device_nonces').where('expires_at', '<', new Date(now())).execute();
    await db.deleteFrom('coding_device_pairings').where('expires_at', '<', new Date(now())).execute();
  }

  async function recoverDeviceDispatch(tx: Kysely<any>, ownerId: string, taskId: string): Promise<boolean> {
    const job = await tx.selectFrom('coding_device_jobs as jobs').innerJoin('coding_devices as devices', 'devices.id', 'jobs.device_id')
      .select(['jobs.id', 'jobs.device_id', 'jobs.status']).where('devices.owner_id', '=', ownerId)
      .where('jobs.task_id', '=', taskId).where('jobs.kind', '=', 'execute').where('jobs.status', 'in', ['unknown', 'dispatched'])
      .forUpdate('jobs').executeTakeFirst();
    if (!job) return false;
    if (job.status === 'dispatched') {
      await finishJobs(tx, ownerId, job.device_id, 'dispatched', 'unknown', 'CODING_DEVICE_RESULT_UNKNOWN', {
        id: job.id, deadline: new Date(now()),
      });
    }
    return true;
  }

  return { enabled, device, run, createPairing, pair, revoke, poll, oversizedResult, maintain, recoverDeviceDispatch };
}

type CodingDeviceLink = Awaited<ReturnType<typeof createCodingDeviceLink>>;
export type { CodingDeviceLink };

function deviceReply(error: unknown, reply: FastifyReply) {
  if (isCodingDeviceError(error)) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'تحقق من حقول جهاز البرمجة.' } });
  const status = (error as FastifyError | undefined)?.statusCode;
  if (status === 413) return reply.code(status).send({ error: { code: 'REQUEST_TOO_LARGE', message: 'تجاوز الطلب الحجم المسموح.' } });
  if (status === 429) return reply.code(status).send({ error: { code: 'RATE_LIMITED', message: 'أُرسلت طلبات كثيرة. أعد المحاولة لاحقًا.' } });
  if (status && status >= 400 && status < 500) {
    return reply.code(status).send({ error: { code: 'VALIDATION_ERROR', message: 'تحقق من طلب جهاز البرمجة.' } });
  }
  return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'تعذر إكمال طلب جهاز البرمجة.' } });
}

export function registerCodingDeviceRoutes(app: FastifyInstance, link: CodingDeviceLink,
  owner: (request: FastifyRequest) => Promise<OwnerSession>) {
  const rate = (max: number, bodyLimit: number) => ({ bodyLimit, config: { rateLimit: { max, timeWindow: '1 minute' } } });
  const native = async (request: FastifyRequest) => assertDeviceTransport(request);
  const errorHandler = (error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => deviceReply(error, reply);

  app.post(`${devicesPath}/pairing`, { ...rate(3, 64), errorHandler }, async request => {
    const user = await owner(request);
    emptyBody.parse(request.body ?? {});
    return link.createPairing(user);
  });
  app.get(devicesPath, { ...rate(60, 64), errorHandler }, async request => {
    const device = await link.device((await owner(request)).id);
    return CodingDeviceListSchema.parse({ enabled: link.enabled, devices: device ? [device] : [] });
  });
  app.delete<{ Params: { id: string } }>(`${devicesPath}/:id`, { ...rate(10, 64), errorHandler }, async request => {
    const user = await owner(request);
    emptyBody.parse(request.body ?? {});
    return link.revoke(user.id, uuid.parse(request.params.id));
  });
  app.post(pairPath, { ...rate(5, 512), onRequest: native, errorHandler }, async request => {
    return link.pair(CodingPairRequestSchema.parse(request.body));
  });
  app.post(pollPath, {
    ...rate(240, CODING_DEVICE_POLL_BODY_LIMIT),
    onRequest: native,
    async errorHandler(error, request, reply) {
      if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        try { await link.oversizedResult(request); }
        catch (failure) { return deviceReply(failure, reply); }
      }
      return deviceReply(error, reply);
    },
  }, async request => link.poll(request.headers.authorization, CodingPollRequestSchema.parse(request.body)));

  if (link.enabled) {
    let maintenance: Promise<void> | undefined;
    const timer = setInterval(() => {
      maintenance ??= link.maintain().catch(() => {}).finally(() => { maintenance = undefined; });
    }, 5_000);
    timer.unref();
    app.addHook('preClose', async () => { clearInterval(timer); await maintenance; });
  }
}
