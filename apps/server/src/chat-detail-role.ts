import { AsyncLocalStorage } from 'node:async_hooks';
import type { Kysely } from 'kysely';
import type { WorkspaceRole } from './members.js';

type RoleRead = {
  db: Kysely<any>;
  ownerId: string;
  value?: Promise<WorkspaceRole | null>;
};

const detailRole = new AsyncLocalStorage<RoleRead>();

export function withChatDetailRole<T>(db: Kysely<any>, ownerId: string, work: () => T) {
  return detailRole.run({ db, ownerId }, work);
}

/** Only this detail's read-only lookup on the same connection and account can be reused. */
export function memoizeChatDetailRole(db: Kysely<any>, ownerId: string, read: () => Promise<WorkspaceRole | null>) {
  const scope = detailRole.getStore();
  return scope?.db === db && scope.ownerId === ownerId ? (scope.value ??= read()) : read();
}
