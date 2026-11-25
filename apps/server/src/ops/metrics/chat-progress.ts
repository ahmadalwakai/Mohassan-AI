import type { Kysely } from 'kysely';

const enabledDatabases = new WeakSet<Kysely<any>>();

export function enableChatProgressMarkers(db: Kysely<any>) {
  enabledDatabases.add(db);
  return () => { enabledDatabases.delete(db); };
}

/** Attach the progress-write time to the visibility event already inserted in the same transaction. */
export function initialProgressMarker(db: Kysely<any>) {
  return enabledDatabases.has(db) ? { firstProgressAtMs: Date.now() } : undefined;
}
