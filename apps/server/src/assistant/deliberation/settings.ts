import type { Kysely } from 'kysely';

interface DeliberationSettings {
  enabled?: boolean;
  memoryHit?: (ownerId: string, query: string) => Promise<boolean>;
}

const settingsByDatabase = new WeakMap<Kysely<any>, Readonly<DeliberationSettings>>();
const shadowOnly: Readonly<DeliberationSettings> = Object.freeze({});

export function configureDeliberation(db: Kysely<any>, settings: DeliberationSettings) {
  settingsByDatabase.set(db, Object.freeze({ ...settings }));
}

export function deliberationSettings(db: Kysely<any>): Readonly<DeliberationSettings> {
  return settingsByDatabase.get(db) ?? shadowOnly;
}
