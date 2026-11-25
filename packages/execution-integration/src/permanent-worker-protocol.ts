import {
  ModelTransportError, copyJson, id, identity, integer, keys, record, sameIdentity,
  type ModelIdentity, type TransportErrorCode, type TransportJson,
} from './transport.js';

export const MODEL_WORKER_PROTOCOL = 'mohassan.execution.worker.v1';
export const MAX_WORKER_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_WORKER_OUTPUT_BYTES = 64 * 1024 * 1024;

const PEER_ERRORS = [
  'invalid_request', 'unsupported_capability', 'invalid_model_output', 'model_process_failure',
  'resource_exhaustion', 'timeout', 'cancelled',
] as const satisfies readonly TransportErrorCode[];
const STARTUP_ERRORS = [
  'invalid_config', 'containment_failure', 'model_load_failure', 'checkpoint_pin_mismatch',
  'invalid_checkpoint', 'gpu_locked', 'gpu_lock_unavailable', 'gpu_unavailable',
] as const;

export type ModelWorkerStartupError = (typeof STARTUP_ERRORS)[number];
export type ModelWorkerHead = 'classify' | 'pointer' | 'generate';
export type ModelWorkerOperation = 'classify' | 'score' | 'select' | 'generate';
export type ModelWorkerResult = { [key: string]: TransportJson };
export interface ModelWorkerToken {
  readonly token: number;
  readonly index: number;
}

export interface ModelWorkerParity {
  readonly top1Agreement: number | null;
  readonly maxAbsoluteLogitDifference: number | null;
  readonly greedyTokenAgreement: number | null;
  readonly adopted: boolean;
  readonly reason: string;
  readonly samples: number;
}

export interface PermanentModelWorkerReady {
  readonly identity: ModelIdentity;
  readonly heads: Readonly<Record<string, ModelWorkerHead>>;
  readonly limits: Readonly<{
    maxBatchSize: number;
    maxBatchWaitMs: number;
    maxPending: number;
    maxInputBytes: number;
    maxOutputBytes: number;
    maxOutputTokens: number;
    maxTimeoutMs: number;
  }>;
  readonly startupMs: number;
  readonly device: 'cpu' | 'cuda';
  readonly parity: Readonly<Record<string, ModelWorkerParity>>;
}

function metric(value: unknown, max: number): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max);
}

function parseParity(raw: Record<string, unknown>, heads: Readonly<Record<string, ModelWorkerHead>>) {
  const parity: Record<string, ModelWorkerParity> = Object.create(null);
  for (const [head, report] of Object.entries(raw)) {
    if (heads[head] === undefined || !record(report)) throw new ModelTransportError('invalid_model_output');
    keys(report, ['top1Agreement', 'maxAbsoluteLogitDifference', 'greedyTokenAgreement', 'adopted', 'reason', 'samples']);
    const { top1Agreement, maxAbsoluteLogitDifference, greedyTokenAgreement, adopted, reason, samples } = report;
    if (!metric(top1Agreement, 1) || !metric(maxAbsoluteLogitDifference, Number.MAX_VALUE)
      || !metric(greedyTokenAgreement, 1) || typeof adopted !== 'boolean' || !id(reason)
      || !integer(samples, 0, Number.MAX_SAFE_INTEGER)) {
      throw new ModelTransportError('invalid_model_output');
    }
    parity[head] = Object.freeze({ top1Agreement, maxAbsoluteLogitDifference, greedyTokenAgreement, adopted, reason, samples });
  }
  return Object.freeze(parity);
}

export function parseWorkerReadiness(
  frame: Record<string, unknown>, expected: ModelIdentity,
): { kind: 'ready'; ready: PermanentModelWorkerReady } | { kind: 'startup_error'; code: ModelWorkerStartupError } {
  if (frame.kind === 'startup_error') {
    keys(frame, ['protocol', 'kind', 'code']);
    const code = STARTUP_ERRORS.find(entry => entry === frame.code);
    if (!code) throw new ModelTransportError('invalid_model_output');
    return { kind: 'startup_error', code };
  }
  keys(frame, ['protocol', 'kind', 'identity', 'heads', 'limits', 'startupMs', 'device', 'parity']);
  if (frame.kind !== 'ready' || !record(frame.heads) || !record(frame.limits)
    || !record(frame.parity) || typeof frame.startupMs !== 'number'
    || !Number.isFinite(frame.startupMs) || frame.startupMs < 0
    || (frame.device !== 'cpu' && frame.device !== 'cuda')) {
    throw new ModelTransportError('invalid_model_output');
  }
  const pinned = identity(frame.identity);
  if (!sameIdentity(pinned, expected)) throw new ModelTransportError('model_identity_mismatch');

  const heads: Record<string, ModelWorkerHead> = Object.create(null);
  for (const [name, operation] of Object.entries(frame.heads)) {
    if (!id(name) || (operation !== 'classify' && operation !== 'pointer' && operation !== 'generate')) {
      throw new ModelTransportError('invalid_model_output');
    }
    heads[name] = operation;
  }
  if (Object.keys(heads).length === 0) throw new ModelTransportError('invalid_model_output');
  const { maxBatchSize, maxBatchWaitMs, maxPending, maxInputBytes, maxOutputBytes, maxOutputTokens, maxTimeoutMs } = frame.limits;
  keys(frame.limits, ['maxBatchSize', 'maxBatchWaitMs', 'maxPending', 'maxInputBytes', 'maxOutputBytes', 'maxOutputTokens', 'maxTimeoutMs']);
  if (!integer(maxBatchSize, 1, 64) || !integer(maxBatchWaitMs, 0, 1_000) || !integer(maxPending, maxBatchSize, 1_024)
    || !integer(maxInputBytes, 256, MAX_WORKER_FRAME_BYTES) || !integer(maxOutputBytes, 256, MAX_WORKER_OUTPUT_BYTES)
    || !integer(maxOutputTokens, 1, 8192) || !integer(maxTimeoutMs, 1, 600_000)) {
    throw new ModelTransportError('invalid_model_output');
  }
  return {
    kind: 'ready',
    ready: Object.freeze({
      identity: pinned,
      heads: Object.freeze(heads),
      limits: Object.freeze({ maxBatchSize, maxBatchWaitMs, maxPending, maxInputBytes, maxOutputBytes, maxOutputTokens, maxTimeoutMs }),
      startupMs: frame.startupMs,
      device: frame.device,
      parity: parseParity(frame.parity, heads),
    }),
  };
}

export type ModelWorkerResponse =
  | { kind: 'token'; requestId: string; token: number; index: number }
  | { kind: 'result'; requestId: string; result: ModelWorkerResult }
  | { kind: 'error'; requestId: string; code: (typeof PEER_ERRORS)[number] };

export function parseWorkerResponse(frame: Record<string, unknown>): ModelWorkerResponse {
  const { kind, requestId } = frame;
  if (!id(requestId)) throw new ModelTransportError('invalid_model_output');
  const envelope = ['protocol', 'kind', 'requestId'];
  switch (kind) {
    case 'token':
      keys(frame, [...envelope, 'token', 'index']);
      if (!integer(frame.token, 0, Number.MAX_SAFE_INTEGER)
        || !integer(frame.index, 0, Number.MAX_SAFE_INTEGER)) break;
      return { kind, requestId, token: frame.token, index: frame.index };
    case 'result':
      keys(frame, [...envelope, 'result']);
      if (!record(frame.result)) break;
      return { kind, requestId, result: frame.result as ModelWorkerResult };
    case 'error': {
      keys(frame, [...envelope, 'code']);
      const code = PEER_ERRORS.find(entry => entry === frame.code);
      if (code) return { kind, requestId, code };
    }
  }
  throw new ModelTransportError('invalid_model_output');
}

export function parseWorkerFrame(line: Uint8Array): Record<string, unknown> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const frame = copyJson(JSON.parse(decoder.decode(line)), 'invalid_model_output');
  if (!record(frame) || frame.protocol !== MODEL_WORKER_PROTOCOL) {
    throw new ModelTransportError('invalid_model_output');
  }
  return frame;
}
