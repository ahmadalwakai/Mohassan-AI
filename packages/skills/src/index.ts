import type { Kysely } from 'kysely';
import { createSkillGrants } from './grants.ts';
import { createSkillImporter } from './importer.ts';
import { createSkillLifecycle } from './lifecycle.ts';
import { createSkillRegistry } from './registry.ts';

export { skillsMigration } from './migration.ts';
export { builtinSkills, type BuiltinSkill } from './builtin/index.ts';
export { SkillError } from './errors.ts';
export { sha256, skillContentHash } from './hash.ts';
export { INSPECTOR_VERSION, inspectSkill } from './inspector.ts';
export { parseSkillManifest } from './frontmatter.ts';

export interface SkillControlOptions {
  allowedRoots?: readonly string[];
  /** Isolation gates G1–G8. Executable skills stay off until something proves them open. */
  executableReady?: () => Promise<boolean>;
  now?: () => Date;
}

export function createSkillControl(db: Kysely<any>, options: SkillControlOptions = {}) {
  const allowedRoots = options.allowedRoots ?? [];
  const registry = createSkillRegistry(db);
  const importLocal = createSkillImporter(db, { allowedRoots, audit: registry.audit, view: registry.view });
  const lifecycle = createSkillLifecycle(db, { audit: registry.audit, executableReady: options.executableReady ?? (async () => false) });
  const grants = createSkillGrants(db, { allowedRoots, audit: registry.audit, now: options.now });
  async function acted(ownerId: string, id: string, act: Promise<void>) { await act; return registry.detail(ownerId, id); }
  return {
    list: registry.list, detail: registry.detail, importLocal,
    inspect: (ownerId: string, id: string, input: unknown) => acted(ownerId, id, lifecycle.inspect(ownerId, id, input)),
    activate: (ownerId: string, id: string, input: unknown) => acted(ownerId, id, lifecycle.activate(ownerId, id, input)),
    revoke: (ownerId: string, id: string, input: unknown) => acted(ownerId, id, lifecycle.revoke(ownerId, id, input)),
    rollback: (ownerId: string, id: string, input: unknown) => acted(ownerId, id, lifecycle.rollback(ownerId, id, input)),
    createGrant: grants.create, revokeGrant: grants.revoke, effectiveAccess: grants.effective,
  };
}
export type SkillControl = ReturnType<typeof createSkillControl>;
