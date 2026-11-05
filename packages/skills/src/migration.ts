import { sql, type Kysely } from 'kysely';

const REGISTRY = [
  `CREATE TABLE skill_families(id text PRIMARY KEY,owner_id text NOT NULL,slug text NOT NULL,active_version_id text,revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(owner_id,slug))`,
  `CREATE TABLE skill_versions(id text PRIMARY KEY,family_id text NOT NULL REFERENCES skill_families(id) ON DELETE CASCADE,owner_id text NOT NULL,version text NOT NULL,sequence integer NOT NULL CHECK(sequence>0),revision integer NOT NULL DEFAULT 1,name text NOT NULL,description text NOT NULL,category text NOT NULL,level text NOT NULL CHECK(level IN('instruction','tool','executable')),origin text NOT NULL CHECK(origin IN('builtin','custom','local_import','forge')),status text NOT NULL CHECK(status IN('quarantined','inspected','tested','benchmarked','active','deprecated','revoked','rejected','incompatible','stale')),status_reason text,contract jsonb NOT NULL,content_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(family_id,sequence),UNIQUE(family_id,version),UNIQUE(owner_id,content_hash))`,
  `CREATE INDEX skill_versions_owner_idx ON skill_versions(owner_id,status,category,level)`,
  `CREATE TABLE skill_files(version_id text NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,path text NOT NULL,kind text NOT NULL CHECK(kind IN('instructions','script','reference','data')),content text NOT NULL,content_hash text NOT NULL,size_bytes integer NOT NULL CHECK(size_bytes>=0),PRIMARY KEY(version_id,path))`,
  `CREATE TABLE skill_sources(version_id text PRIMARY KEY REFERENCES skill_versions(id) ON DELETE CASCADE,kind text NOT NULL CHECK(kind IN('builtin','local_folder','forge')),locator text NOT NULL,observed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,file_count integer NOT NULL,total_bytes integer NOT NULL)`,
  `CREATE TABLE skill_activations(id text PRIMARY KEY,family_id text NOT NULL REFERENCES skill_families(id) ON DELETE CASCADE,version_id text NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,owner_id text NOT NULL,action text NOT NULL CHECK(action IN('activate','revoke','rollback')),reason text,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE skill_audit(id text PRIMARY KEY,owner_id text NOT NULL,target_id text NOT NULL,event text NOT NULL,detail jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX skill_audit_target_idx ON skill_audit(owner_id,target_id,created_at DESC)`,
] as const;

const SECURITY = [
  `CREATE TABLE skill_inspections(id text PRIMARY KEY,version_id text NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,owner_id text NOT NULL,content_hash text NOT NULL,inspector_version text NOT NULL,verdict text NOT NULL CHECK(verdict IN('pass','review','fail','incompatible')),findings jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX skill_inspections_version_idx ON skill_inspections(version_id,created_at DESC)`,
  `CREATE TABLE skill_grants(id text PRIMARY KEY,version_id text NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,owner_id text NOT NULL,content_hash text NOT NULL,tools jsonb NOT NULL,scopes jsonb NOT NULL,roots jsonb NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,revoke_reason text,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX skill_grants_version_idx ON skill_grants(owner_id,version_id,expires_at)`,
] as const;

/** Fixed SQL, additive only: dropping the skill_* tables fully reverses it without touching existing data. */
export async function skillsMigration(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`.execute(db);
  await db.transaction().execute(async (tx) => {
    await sql`SELECT pg_advisory_xact_lock(1846021108)`.execute(tx);
    for (const [version, statements] of [['015_skill_registry', REGISTRY], ['016_skill_security', SECURITY]] as const) {
      if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', version).executeTakeFirst()) continue;
      for (const statement of statements) await sql.raw(statement).execute(tx);
      await tx.insertInto('schema_migrations').values({ version }).execute();
    }
  });
}
