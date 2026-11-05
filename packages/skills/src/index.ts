import type { Kysely } from 'kysely';
import { createSkillRegistry } from './registry.ts';

export { skillsMigration } from './migration.ts';
export { builtinSkills, type BuiltinSkill } from './builtin/index.ts';
export { SkillError, sha256, skillContentHash } from './registry.ts';

export function createSkillControl(db: Kysely<any>) {
  const registry = createSkillRegistry(db);
  return { list: registry.list, detail: registry.detail };
}
export type SkillControl = ReturnType<typeof createSkillControl>;
