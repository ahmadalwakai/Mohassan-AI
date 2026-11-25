import { AsyncLocalStorage } from 'node:async_hooks';
import type { Kysely } from 'kysely';
import { activationCapabilities } from './activation-registry.js';

const capabilitiesByFlag = new Map(activationCapabilities.flatMap(capability =>
  capability.flag === null ? [] : [[capability.flag, capability] as const]));
const consumers = new Set<string>();
const managedDatabases = new WeakSet<Kysely<any>>();
const scope = new AsyncLocalStorage<{ db: Kysely<any>; ownerId: string | undefined; enabled: ReadonlySet<string> }>();

export function attachActivationRuntime(db: Kysely<any>): void {
  managedDatabases.add(db);
}

export function activationScopeDatabase(): Kysely<any> | undefined {
  return scope.getStore()?.db;
}

export function activationScopeOwnerId(): string | undefined {
  return scope.getStore()?.ownerId;
}

export function isActivationRuntimeReady(flag: string | null): boolean {
  const capability = flag === null ? undefined : capabilitiesByFlag.get(flag);
  return capability !== undefined && consumers.has(capability.id);
}

/** The producer calls this after every enforcement site for its flag uses the returned reader. */
export function registerActivationConsumer<Enabled extends string | boolean, Shadow extends string | boolean | null>(
  flag: string, enabledValue: Enabled, shadowValue: Shadow,
) {
  const capability = capabilitiesByFlag.get(flag);
  if (!capability || capability.enabledValue !== enabledValue || capability.shadowValue !== shadowValue) {
    throw new Error('Unknown activation flag or mode');
  }
  consumers.add(capability.id);
  return <Fallback>(fallback: Fallback): Enabled | Shadow | Fallback => {
    const enabled = scope.getStore()?.enabled;
    if (enabled === undefined) return fallback;
    return enabled.has(capability.id) ? enabledValue : shadowValue;
  };
}

async function withActivationScope<T>(db: Kysely<any>, ownerId: string | undefined, invoke: () => Promise<T>): Promise<T> {
  if (!managedDatabases.has(db)) return scope.exit(invoke);

  // Read at entry so all server processes see the committed decision, and so a run
  // keeps the same mode through its async continuations. A new call reads again.
  const current = consumers.size ? await db.selectFrom('activation_changes')
    .distinctOn('capability_id').select(['capability_id', 'enabled'])
    .where('capability_id', 'in', [...consumers])
    .orderBy('capability_id').orderBy('id', 'desc').execute()
    .catch(() => []) : [];
  const enabled = new Set(current.filter(row => row.enabled === true).map(row => row.capability_id as string));
  return scope.run({ db, ownerId, enabled }, invoke);
}

// Each method takes the account authenticated by the route as its first argument.
const scopedMethods = ['create', 'detail', 'send', 'respond', 'approve', 'secureSubmit', 'cancel',
  'restoreBrowser', 'reviewBrowser', 'screen', 'browserActivity', 'pointer', 'keyboard'] as const;

/** Wrap normal chat entry points, including the image reply path and calls that start a worker. */
export function bindActivationRuntime<T extends object>(db: Kysely<any>, control: T): T {
  const wrapped = { ...control };
  for (const name of scopedMethods) {
    const method: unknown = Reflect.get(control, name);
    if (typeof method === 'function') {
      Object.assign(wrapped, { [name]: (...args: unknown[]) => {
        const ownerId = typeof args[0] === 'string' && args[0] ? args[0] : undefined;
        return withActivationScope(db, ownerId, () => Reflect.apply(method, control, args));
      } });
    }
  }
  return wrapped;
}
