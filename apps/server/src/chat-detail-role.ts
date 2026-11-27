import { AsyncLocalStorage } from 'node:async_hooks';
import type { Kysely } from 'kysely';
import type { WorkspaceRole } from './members.js';

type RoleRead = {
  db: Kysely<any>;
  ownerId: string;
  value?: Promise<WorkspaceRole | null>;
};

type LookupRole = (db: Kysely<any>, ownerId: string) => Promise<WorkspaceRole | null>;
const detailRole = new AsyncLocalStorage<RoleRead>();

export function withChatDetailRole<T>(db: Kysely<any>, ownerId: string, work: () => T) {
  return detailRole.run({ db, ownerId }, work);
}

/** Only this detail's read-only lookup on the same connection and account can be reused. */
export function memoizeChatDetailRole(read: LookupRole): LookupRole {
  return (db, ownerId) => {
    const scope = detailRole.getStore();
    if (scope?.db === db && scope.ownerId === ownerId) return scope.value ??= read(db, ownerId);
    return read(db, ownerId);
  };
}
