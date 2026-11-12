import { createHash } from 'node:crypto';
import type { Failure, FailureCode, Json } from './contracts.js';

export class IntegrationError extends Error {
  constructor(readonly code: FailureCode, readonly effect: Failure['effect'] = 'none',
    readonly evidenceRefs: readonly string[] = []) { super(code); this.name = 'IntegrationError'; }
}
export function fail(code: FailureCode): never { throw new IntegrationError(code); }
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
export function boundedJson(value: unknown, maxBytes: number): Json {
  let nodes = 0;
  let bytes = 0;
  const seen = new Set<object>();
  const account = (count: number) => { bytes += count; if (bytes > maxBytes) fail('resource_exhaustion'); };
  function visit(input: unknown, depth: number): Json {
    if (++nodes > 100_000 || depth > 32) fail('resource_exhaustion');
    if (input === null || typeof input === 'boolean') { account(5); return input; }
    if (typeof input === 'number' && Number.isFinite(input)) { account(8); return input; }
    if (typeof input === 'string') { account(Buffer.byteLength(input) + 2); return input; }
    if (!Array.isArray(input) && !isRecord(input)) fail('invalid_model_output');
    if (seen.has(input)) fail('invalid_model_output');
    seen.add(input);
    let result: Json;
    account(2);
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype || input.length > 100_000) fail('invalid_model_output');
      const array: Json[] = [];
      for (let index = 0; index < input.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || !('value' in descriptor)) fail('invalid_model_output');
        account(1); array.push(visit(descriptor.value, depth + 1));
      }
      result = array;
    }
    else {
      const record: Record<string, Json> = Object.create(null) as Record<string, Json>;
      for (const key of Object.keys(input).sort()) {
        if (['__proto__', 'constructor', 'prototype'].includes(key) || Buffer.byteLength(key) > 1024) fail('invalid_model_output');
        account(Buffer.byteLength(key) + 4);
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !('value' in descriptor)) fail('invalid_model_output');
        record[key] = visit(descriptor.value, depth + 1);
      }
      result = record;
    }
    seen.delete(input);
    return result;
  }
  const clean = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(clean)) > maxBytes) fail('resource_exhaustion');
  return clean;
}
export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(boundedJson(value, 16 * 1024 * 1024))).digest('hex');
}
export function same(a: unknown, b: unknown): boolean { return hash(a) === hash(b); }
export function textId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512; }
export function positive(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}
export function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
/** Races uncooperative read adapters. Effect adapters must additionally enforce cancellation/limits themselves. */
export async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(signal.reason instanceof IntegrationError ? signal.reason : new IntegrationError('cancellation'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), aborted]); }
  finally { if (listener) signal.removeEventListener('abort', listener); }
}
export async function within<T>(ms: number, parent: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason ?? new IntegrationError('cancellation'));
  const timer = setTimeout(() => controller.abort(new IntegrationError('timeout')), Math.max(1, ms));
  parent.addEventListener('abort', abort, { once: true });
  if (parent.aborted) abort();
  try { return await abortable(() => operation(controller.signal), controller.signal); }
  finally { clearTimeout(timer); parent.removeEventListener('abort', abort); }
}
