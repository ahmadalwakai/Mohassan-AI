import { createHash } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';

/** A Phase 5 wire contract, not a claim that Phase 2 already implements it. */
export const LOCAL_MODEL_PROTOCOL = 'mohassan.execution.local.v1' as const;
export type TransportJson = null | boolean | number | string | TransportJson[] | { [key: string]: TransportJson };

export interface ModelIdentity {
  readonly modelId: string;
  readonly tokenizerId: string;
  readonly checkpointId: string;
}

export interface ModelCapabilities {
  readonly protocol: typeof LOCAL_MODEL_PROTOCOL;
  readonly identity: ModelIdentity;
  readonly capabilities: readonly string[];
  readonly maxInputBytes: number;
  readonly maxOutputTokens: number;
}

export interface ModelTaskSubmission {
  readonly requestId: string;
  readonly taskId: string;
  readonly capability: string;
  readonly contract: TransportJson;
  readonly context: TransportJson;
  readonly maxOutputTokens: number;
}

interface ModelResponseBase {
  readonly requestId: string;
  readonly taskId: string;
  readonly identity: ModelIdentity;
}

export type ModelCandidateResponse = ModelResponseBase & (
  | { readonly status: 'candidate'; readonly proposal: TransportJson; readonly outputTokens: number }
  | { readonly status: 'missing_context'; readonly missingContextKeys: readonly string[] }
  | { readonly status: 'unsupported'; readonly capability: string }
);

export interface ModelTransport {
  discover(signal: AbortSignal): Promise<ModelCapabilities>;
  submit(request: ModelTaskSubmission, signal: AbortSignal): Promise<ModelCandidateResponse>;
}

export type TransportErrorCode =
  | 'invalid_configuration' | 'isolation_unavailable' | 'invalid_request' | 'duplicate_request'
  | 'model_identity_mismatch' | 'unsupported_capability' | 'invalid_model_output'
  | 'model_process_failure' | 'resource_exhaustion' | 'timeout' | 'cancelled'
  | 'process_cleanup_failed';

/** Deliberately excludes peer messages, raw stdout/stderr, arguments, and prompts. */
export class ModelTransportError extends Error {
  constructor(readonly code: TransportErrorCode) {
    super(`Local execution model transport: ${code}.`);
    this.name = 'ModelTransportError';
  }
}

export interface ModelProcessLimits {
  readonly memoryBytes: number;
  readonly cpuTimeMs: number;
  readonly maxProcesses: number;
  readonly maxInputBytes: number;
  readonly maxMessageBytes: number;
  readonly maxOutputBytes: number;
  readonly maxStderrBytes: number;
  readonly maxOutputTokens: number;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
}

export interface LocalModelProcessConfig {
  /** An operator-supplied absolute executable; no Python location is assumed. */
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Explicit environment only. This module never reads or mutates process.env. */
  readonly environment: Readonly<Record<string, string>>;
  readonly identity: ModelIdentity;
  readonly readOnlyPaths: readonly string[];
  readonly limits: ModelProcessLimits;
  /** Bounded replay protection; entries are never evicted to permit a retry. */
  readonly maxRememberedRequestIds: number;
}

export interface LocalModelLaunchSpec extends LocalModelProcessConfig {
  readonly protocol: typeof LOCAL_MODEL_PROTOCOL;
  readonly configurationHash: string;
  readonly shell: false;
  readonly windowsHide: true;
  readonly network: 'deny_all';
  readonly filesystemWrites: 'deny_all';
}

export interface LocalModelContainmentEvidence {
  readonly evidenceId: string;
  readonly configurationHash: string;
  readonly verified: true;
  readonly localOnly: true;
  readonly networkDenied: true;
  readonly fileAccessRestricted: true;
  readonly fileWritesDenied: true;
  readonly memoryLimitEnforced: true;
  readonly cpuLimitEnforced: true;
  readonly processCountEnforced: true;
  readonly descendantsContained: true;
  readonly terminationFencesFutureLaunches: true;
}

/**
 * This is a trusted host boundary, not model-supplied evidence. prepare MUST NOT
 * launch code. launch MUST apply the attested OS restrictions before any child
 * instruction runs. An ordinary child_process.spawn wrapper is insufficient.
 */
export interface LocalModelContainmentAdapter {
  prepare(spec: LocalModelLaunchSpec, signal: AbortSignal): Promise<PreparedLocalModelProcess>;
}

export interface PreparedLocalModelProcess {
  readonly evidence: LocalModelContainmentEvidence;
  launch(signal: AbortSignal): Promise<ChildProcessWithoutNullStreams>;
  /**
   * Must atomically revoke this lease, kill/wait for the entire tree, and fence
   * even a pending launch. Must work after cancellation and be idempotent.
   */
  terminateAll(): Promise<{ readonly terminated: true; readonly descendantsTerminated: true; readonly launchFenced: true }>;
  /** Release handles after terminateAll; MUST NEVER detach any surviving child. */
  dispose(): Promise<void>;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,255}$/;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 32_768;

function fail(code: TransportErrorCode): never { throw new ModelTransportError(code); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function id(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('invalid_model_output');
}
function identity(value: unknown): ModelIdentity {
  if (!record(value)) return fail('invalid_model_output');
  keys(value, ['modelId', 'tokenizerId', 'checkpointId']);
  if (!id(value.modelId) || !id(value.tokenizerId) || !id(value.checkpointId)) return fail('invalid_model_output');
  return Object.freeze({ modelId: value.modelId, tokenizerId: value.tokenizerId, checkpointId: value.checkpointId });
}
function sameIdentity(a: ModelIdentity, b: ModelIdentity): boolean {
  return a.modelId === b.modelId && a.tokenizerId === b.tokenizerId && a.checkpointId === b.checkpointId;
}

export { copyJson, id, identity, integer, keys, record, sameIdentity };

/** No getters, toJSON hooks, nonfinite numbers, cycles, or prototype-bearing input. */
function copyJson(value: unknown, errorCode: TransportErrorCode): TransportJson {
  let remaining = MAX_JSON_NODES;
  const visit = (entry: unknown, depth: number): TransportJson => {
    if (--remaining < 0 || depth > MAX_JSON_DEPTH) return fail(errorCode);
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    if (!entry || typeof entry !== 'object') return fail(errorCode);
    const prototype: unknown = Object.getPrototypeOf(entry);
    if (Array.isArray(entry)) {
      if (prototype !== Array.prototype || entry.length > remaining) return fail(errorCode);
      const result: TransportJson[] = [];
      for (let i = 0; i < entry.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, String(i));
        if (!descriptor || !('value' in descriptor)) return fail(errorCode);
        result.push(visit(descriptor.value, depth + 1));
      }
      return result;
    }
    if (prototype !== Object.prototype && prototype !== null) return fail(errorCode);
    const result: { [key: string]: TransportJson } = Object.create(null) as { [key: string]: TransportJson };
    const names = Object.keys(entry);
    if (names.length > remaining) return fail(errorCode);
    for (const name of names) {
      if (name === '__proto__' || name === 'constructor' || name === 'prototype') return fail(errorCode);
      const descriptor = Object.getOwnPropertyDescriptor(entry, name);
      if (!descriptor || !('value' in descriptor)) return fail(errorCode);
      result[name] = visit(descriptor.value, depth + 1);
    }
    return result;
  };
  return visit(value, 0);
}

export function validateConfig(config: LocalModelProcessConfig): LocalModelLaunchSpec {
  const localPath = (value: string) => typeof value === 'string' && isAbsolute(value) && !/^[\\/]{2}/.test(value) && !value.includes('\0');
  if (!localPath(config.executable) || !localPath(config.cwd)) fail('invalid_configuration');
  if (!Array.isArray(config.args) || config.args.length > 128 || config.args.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))) fail('invalid_configuration');
  if (!Array.isArray(config.readOnlyPaths) || config.readOnlyPaths.length === 0 || config.readOnlyPaths.length > 128 || config.readOnlyPaths.some(path => !localPath(path))) fail('invalid_configuration');
  if (!id(config.identity.modelId) || !id(config.identity.tokenizerId) || !id(config.identity.checkpointId)) fail('invalid_configuration');
  if (!record(config.environment) || Object.entries(config.environment).some(([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string' || value.length > 32_768 || value.includes('\0'))) fail('invalid_configuration');
  if (Object.keys(config.environment).length > 128 || !integer(config.maxRememberedRequestIds, 1, 100_000)) fail('invalid_configuration');
  const limits = config.limits;
  if (!integer(limits.memoryBytes, 1, 1_099_511_627_776) || !integer(limits.cpuTimeMs, 1, 86_400_000) || !integer(limits.maxProcesses, 1, 64)
    || !integer(limits.maxInputBytes, 1, 16_777_216) || !integer(limits.maxMessageBytes, limits.maxInputBytes, 16_777_216)
    || !integer(limits.maxOutputBytes, limits.maxMessageBytes, 67_108_864) || !integer(limits.maxStderrBytes, 0, 1_048_576)
    || !integer(limits.maxOutputTokens, 1, 8192) || !integer(limits.startupTimeoutMs, 1, 600_000)
    || !integer(limits.requestTimeoutMs, 1, 600_000) || !integer(limits.cleanupTimeoutMs, 1, 60_000)) fail('invalid_configuration');
  const frozen = {
    executable: config.executable, args: Object.freeze([...config.args]), cwd: config.cwd,
    environment: Object.freeze({ ...config.environment }), identity: Object.freeze({ ...config.identity }),
    readOnlyPaths: Object.freeze([...config.readOnlyPaths]), limits: Object.freeze({ ...limits }),
    maxRememberedRequestIds: config.maxRememberedRequestIds,
    protocol: LOCAL_MODEL_PROTOCOL, shell: false as const, windowsHide: true as const,
    network: 'deny_all' as const, filesystemWrites: 'deny_all' as const,
  };
  const configurationHash = createHash('sha256').update(JSON.stringify(frozen)).digest('hex');
  return Object.freeze({ ...frozen, configurationHash });
}

function assertContainment(evidence: LocalModelContainmentEvidence, spec: LocalModelLaunchSpec): void {
  if (!evidence || !id(evidence.evidenceId) || evidence.configurationHash !== spec.configurationHash
    || evidence.verified !== true || evidence.localOnly !== true || evidence.networkDenied !== true
    || evidence.fileAccessRestricted !== true || evidence.fileWritesDenied !== true
    || evidence.memoryLimitEnforced !== true || evidence.cpuLimitEnforced !== true
    || evidence.processCountEnforced !== true || evidence.descendantsContained !== true
    || evidence.terminationFencesFutureLaunches !== true) fail('isolation_unavailable');
}

function abortError(signal: AbortSignal): ModelTransportError {
  return signal.reason instanceof ModelTransportError ? signal.reason : new ModelTransportError('cancelled');
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => undefined); return Promise.reject(abortError(signal)); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(abortError(signal)); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { cleanup(); if (signal.aborted) reject(abortError(signal)); else resolve(value); }, () => { cleanup(); reject(signal.aborted ? abortError(signal) : new ModelTransportError('model_process_failure')); });
  });
}

function timed<T>(action: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ModelTransportError('process_cleanup_failed')), timeoutMs);
    Promise.resolve().then(action).then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); reject(new ModelTransportError('process_cleanup_failed')); });
  });
}

export function parseReady(raw: Record<string, unknown>, spec: LocalModelLaunchSpec): ModelCapabilities {
  keys(raw, ['protocol', 'kind', 'identity', 'capabilities', 'limits']);
  if (raw.protocol !== LOCAL_MODEL_PROTOCOL || raw.kind !== 'ready') return fail('invalid_model_output');
  const pinned = identity(raw.identity);
  if (!sameIdentity(pinned, spec.identity)) return fail('model_identity_mismatch');
  if (!Array.isArray(raw.capabilities) || raw.capabilities.length > 128 || raw.capabilities.some(value => !id(value)) || new Set(raw.capabilities).size !== raw.capabilities.length || !record(raw.limits)) return fail('invalid_model_output');
  keys(raw.limits, ['maxInputBytes', 'maxOutputTokens']);
  if (!integer(raw.limits.maxInputBytes, 1, 16_777_216) || !integer(raw.limits.maxOutputTokens, 1, 8192)) return fail('invalid_model_output');
  return Object.freeze({ protocol: LOCAL_MODEL_PROTOCOL, identity: pinned, capabilities: Object.freeze([...raw.capabilities] as string[]),
    maxInputBytes: Math.min(raw.limits.maxInputBytes, spec.limits.maxInputBytes), maxOutputTokens: Math.min(raw.limits.maxOutputTokens, spec.limits.maxOutputTokens) });
}

export function parseResponse(raw: Record<string, unknown>, request: ModelTaskSubmission, spec: LocalModelLaunchSpec): ModelCandidateResponse {
  if (raw.protocol !== LOCAL_MODEL_PROTOCOL || raw.requestId !== request.requestId || raw.taskId !== request.taskId) return fail('invalid_model_output');
  const pinned = identity(raw.identity);
  if (!sameIdentity(pinned, spec.identity)) return fail('model_identity_mismatch');
  if (raw.kind === 'error') {
    keys(raw, ['protocol', 'kind', 'requestId', 'taskId', 'identity', 'code']);
    const allowed: readonly TransportErrorCode[] = ['invalid_request', 'unsupported_capability', 'invalid_model_output', 'model_process_failure', 'resource_exhaustion', 'timeout', 'cancelled'];
    if (typeof raw.code !== 'string' || !allowed.includes(raw.code as TransportErrorCode)) return fail('invalid_model_output');
    return fail(raw.code as TransportErrorCode);
  }
  if (raw.kind !== 'result') return fail('invalid_model_output');
  const base = { requestId: request.requestId, taskId: request.taskId, identity: pinned };
  if (raw.status === 'candidate') {
    keys(raw, ['protocol', 'kind', 'requestId', 'taskId', 'identity', 'status', 'proposal', 'outputTokens']);
    if (!integer(raw.outputTokens, 0, request.maxOutputTokens)) return fail('invalid_model_output');
    return { ...base, status: 'candidate', proposal: copyJson(raw.proposal, 'invalid_model_output'), outputTokens: raw.outputTokens };
  }
  if (raw.status === 'missing_context') {
    keys(raw, ['protocol', 'kind', 'requestId', 'taskId', 'identity', 'status', 'missingContextKeys']);
    if (!Array.isArray(raw.missingContextKeys) || raw.missingContextKeys.length < 1 || raw.missingContextKeys.length > 64 || raw.missingContextKeys.some(value => !id(value))) return fail('invalid_model_output');
    return { ...base, status: 'missing_context', missingContextKeys: Object.freeze([...raw.missingContextKeys] as string[]) };
  }
  if (raw.status === 'unsupported') {
    keys(raw, ['protocol', 'kind', 'requestId', 'taskId', 'identity', 'status', 'capability']);
    if (raw.capability !== request.capability) return fail('invalid_model_output');
    return { ...base, status: 'unsupported', capability: request.capability };
  }
  return fail('invalid_model_output');
}

/**
 * One fresh contained child, one handshake, and at most one generation request.
 * No HTTP, model download, tool execution, provider fallback, or internal retry.
 */
export class LocalProcessModelTransport implements ModelTransport {
  private readonly spec: LocalModelLaunchSpec;
  private readonly submittedIds = new Set<string>();
  private busy = false;
  private quarantined = false;

  constructor(config: LocalModelProcessConfig, private readonly containment?: LocalModelContainmentAdapter) {
    this.spec = validateConfig(config);
  }

  async discover(signal: AbortSignal): Promise<ModelCapabilities> {
    return await this.run(undefined, signal) as ModelCapabilities;
  }

  async submit(request: ModelTaskSubmission, signal: AbortSignal): Promise<ModelCandidateResponse> {
    if (signal.aborted) throw new ModelTransportError('cancelled');
    if (!id(request.requestId) || !id(request.taskId) || !id(request.capability) || !integer(request.maxOutputTokens, 1, this.spec.limits.maxOutputTokens)) fail('invalid_request');
    if (this.submittedIds.has(request.requestId)) fail('duplicate_request');
    if (this.submittedIds.size >= this.spec.maxRememberedRequestIds) fail('resource_exhaustion');
    const safe = Object.freeze({ requestId: request.requestId, taskId: request.taskId, capability: request.capability,
      contract: copyJson(request.contract, 'invalid_request'), context: copyJson(request.context, 'invalid_request'), maxOutputTokens: request.maxOutputTokens });
    const frameBytes = Buffer.byteLength(JSON.stringify({ protocol: LOCAL_MODEL_PROTOCOL, kind: 'generate', identity: this.spec.identity, ...safe }) + '\n');
    if (frameBytes > this.spec.limits.maxInputBytes || frameBytes > this.spec.limits.maxMessageBytes) fail('resource_exhaustion');
    // Remember before any asynchronous work. Failure is never an invitation to replay.
    this.submittedIds.add(request.requestId);
    return await this.run(safe, signal) as ModelCandidateResponse;
  }

  private async run(request: ModelTaskSubmission | undefined, callerSignal: AbortSignal): Promise<ModelCapabilities | ModelCandidateResponse> {
    if (callerSignal.aborted) fail('cancelled');
    if (!this.containment) fail('isolation_unavailable');
    if (this.quarantined) fail('isolation_unavailable');
    if (this.busy) fail('resource_exhaustion');
    this.busy = true;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(new ModelTransportError('cancelled'));
    callerSignal.addEventListener('abort', forwardAbort, { once: true });
    if (callerSignal.aborted) forwardAbort();
    let timer = setTimeout(() => controller.abort(new ModelTransportError('timeout')), this.spec.limits.startupTimeoutMs);
    let prepared: PreparedLocalModelProcess | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    let detach: (() => void) | undefined;
    let result: ModelCapabilities | ModelCandidateResponse | undefined;
    let failure: ModelTransportError | undefined;
    try {
      const preparing = this.containment.prepare(this.spec, controller.signal);
      // A late prepare may allocate containment resources, but MUST NOT launch code.
      void preparing.then(async lease => {
        if (controller.signal.aborted && prepared !== lease) {
          try { await timed(() => lease.terminateAll(), this.spec.limits.cleanupTimeoutMs); }
          finally { await timed(() => lease.dispose(), this.spec.limits.cleanupTimeoutMs); }
        }
      }).catch(() => { this.quarantined = true; });
      prepared = await abortable(preparing, controller.signal);
      assertContainment(prepared.evidence, this.spec);
      child = await abortable(prepared.launch(controller.signal), controller.signal);
      const live = child;
      result = await new Promise<ModelCapabilities | ModelCandidateResponse>((resolve, reject) => {
        let pending = Buffer.alloc(0);
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let ready = false;
        let settled = false;
        const finish = (value: ModelCapabilities | ModelCandidateResponse) => { if (!settled) { settled = true; resolve(value); } };
        const stop = (error: unknown) => {
          if (!settled) { settled = true; reject(error instanceof ModelTransportError ? error : new ModelTransportError('model_process_failure')); }
        };
        const onAbort = () => stop(abortError(controller.signal));
        const onError = () => stop(new ModelTransportError('model_process_failure'));
        const onClose = () => stop(new ModelTransportError('model_process_failure'));
        const onStderr = (chunk: Buffer | string) => {
          stderrBytes += Buffer.byteLength(chunk);
          if (stderrBytes > this.spec.limits.maxStderrBytes) stop(new ModelTransportError('resource_exhaustion'));
          // stderr is drained, bounded, and intentionally never retained or logged.
        };
        const onStdout = (chunk: Buffer | string) => {
          if (settled) return;
          try {
            const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
            stdoutBytes += bytes.byteLength;
            if (stdoutBytes > this.spec.limits.maxOutputBytes) fail('resource_exhaustion');
            pending = Buffer.concat([pending, bytes]);
            let completed: ModelCapabilities | ModelCandidateResponse | undefined;
            for (;;) {
              const newline = pending.indexOf(10);
              if (newline < 0) break;
              if (newline === 0 || newline > this.spec.limits.maxMessageBytes || completed) fail('invalid_model_output');
              const line = pending.subarray(0, newline);
              pending = pending.subarray(newline + 1);
              let decoded: string;
              try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(line); } catch { return stop(new ModelTransportError('invalid_model_output')); }
              let raw: unknown;
              try { raw = JSON.parse(decoded) as unknown; } catch { return stop(new ModelTransportError('invalid_model_output')); }
              if (!record(raw)) fail('invalid_model_output');
              if (!ready) {
                const capabilities = parseReady(raw, this.spec);
                ready = true;
                clearTimeout(timer);
                if (!request) { completed = capabilities; continue; }
                if (!capabilities.capabilities.includes(request.capability)) fail('unsupported_capability');
                if (request.maxOutputTokens > capabilities.maxOutputTokens) fail('resource_exhaustion');
                const frame = JSON.stringify({ protocol: LOCAL_MODEL_PROTOCOL, kind: 'generate', identity: this.spec.identity, ...request }) + '\n';
                if (Buffer.byteLength(frame) > capabilities.maxInputBytes || Buffer.byteLength(frame) > this.spec.limits.maxMessageBytes) fail('resource_exhaustion');
                if (controller.signal.aborted) throw abortError(controller.signal);
                timer = setTimeout(() => controller.abort(new ModelTransportError('timeout')), this.spec.limits.requestTimeoutMs);
                // Exactly one write. No re-send even if write callback or response is lost.
                live.stdin.end(frame, 'utf8', () => undefined);
              } else {
                if (!request) fail('invalid_model_output');
                completed = parseResponse(raw, request, this.spec);
              }
            }
            if (pending.length > this.spec.limits.maxMessageBytes) fail('resource_exhaustion');
            if (completed) {
              if (pending.length !== 0) fail('invalid_model_output');
              finish(completed);
            }
          } catch (error) { stop(error); }
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });
        live.on('error', onError);
        live.on('close', onClose);
        live.stdin.on('error', onError);
        live.stdout.on('error', onError);
        live.stderr.on('error', onError);
        live.stdout.on('data', onStdout);
        live.stderr.on('data', onStderr);
        detach = () => {
          controller.signal.removeEventListener('abort', onAbort);
          live.removeListener('error', onError); live.removeListener('close', onClose);
          live.stdin.removeListener('error', onError); live.stdout.removeListener('error', onError); live.stderr.removeListener('error', onError);
          live.stdout.removeListener('data', onStdout); live.stderr.removeListener('data', onStderr);
          // A late OS/pipe error must not become an unhandled main-process event.
          const ignore = () => undefined;
          live.on('error', ignore); live.stdin.on('error', ignore); live.stdout.on('error', ignore); live.stderr.on('error', ignore);
        };
        if (controller.signal.aborted) onAbort();
        else if (live.exitCode !== null || live.signalCode !== null || live.stdout.readableEnded) onClose();
      });
      if (controller.signal.aborted) throw abortError(controller.signal);
    } catch (error) {
      failure = error instanceof ModelTransportError ? error : new ModelTransportError('model_process_failure');
    } finally {
      clearTimeout(timer);
      // Cancellation cannot cancel cleanup. The containment lease kills descendants
      // and fences a launch still pending when the timeout was observed.
      if (prepared) {
        try {
          const evidence = await timed(() => prepared!.terminateAll(), this.spec.limits.cleanupTimeoutMs);
          if (evidence.terminated !== true || evidence.descendantsTerminated !== true || evidence.launchFenced !== true) fail('process_cleanup_failed');
        } catch { this.quarantined = true; failure = new ModelTransportError('process_cleanup_failed'); }
        try { await timed(() => prepared!.dispose(), this.spec.limits.cleanupTimeoutMs); }
        catch { this.quarantined = true; failure = new ModelTransportError('process_cleanup_failed'); }
      }
      detach?.();
      child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy();
      callerSignal.removeEventListener('abort', forwardAbort);
      this.busy = false;
    }
    if (callerSignal.aborted && failure?.code !== 'process_cleanup_failed') fail('cancelled');
    if (failure) throw failure;
    if (!result) fail('model_process_failure');
    return result;
  }
}
