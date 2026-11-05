import { sql,type Kysely } from 'kysely';
export async function memoryMigration(db:Kysely<any>){
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`.execute(db);
  await db.transaction().execute(async tx=>{
    await sql`SELECT pg_advisory_xact_lock(1846021107)`.execute(tx);
    if(await tx.selectFrom('schema_migrations').select('version').where('version','=','007_memory_learning_v1').executeTakeFirst())return;
    for(const statement of [
      `CREATE TABLE memory_evidence(id text PRIMARY KEY,owner_id text NOT NULL,source_key text NOT NULL,kind text NOT NULL CHECK(kind IN('manual','task','task_result','task_error','feedback')),description text NOT NULL,task_id text,event_id text,content_hash text NOT NULL,trust text NOT NULL CHECK(trust IN('manual','observed')),status text NOT NULL DEFAULT 'active',observed_at timestamptz NOT NULL,expires_at timestamptz,UNIQUE(owner_id,source_key))`,
      `CREATE TABLE memory_items(id text PRIMARY KEY,root_id text NOT NULL,owner_id text NOT NULL,version integer NOT NULL CHECK(version>0),layer text NOT NULL CHECK(layer IN('working','episodic','semantic','procedural','failure','preference')),title text NOT NULL,content text NOT NULL,status text NOT NULL CHECK(status IN('active','superseded','revoked')),confidence double precision NOT NULL CHECK(confidence>=0 AND confidence<=1),confidence_kind text NOT NULL CHECK(confidence_kind IN('user_asserted','task_observed')),task_id text,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(owner_id,root_id,version))`,
      `CREATE INDEX memory_owner_layer_expiry_idx ON memory_items(owner_id,status,layer,expires_at)`,
      `CREATE TABLE memory_provenance(memory_id text NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,evidence_id text NOT NULL REFERENCES memory_evidence(id),relation text NOT NULL DEFAULT 'asserted',PRIMARY KEY(memory_id,evidence_id))`,
      `CREATE TABLE memory_feedback(id text PRIMARY KEY,owner_id text NOT NULL,task_id text NOT NULL,kind text NOT NULL,comment text NOT NULL,rating integer,persisted_preference boolean NOT NULL,submission_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(owner_id,submission_key))`,
      `CREATE TABLE memory_audit(id text PRIMARY KEY,owner_id text NOT NULL,target_id text NOT NULL,operation text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE memory_skill_families(id text PRIMARY KEY,owner_id text NOT NULL,name text NOT NULL,active_skill_id text,revision integer NOT NULL DEFAULT 1)`,
      `CREATE TABLE memory_skill_versions(id text PRIMARY KEY,family_id text NOT NULL REFERENCES memory_skill_families(id),owner_id text NOT NULL,version integer NOT NULL,revision integer NOT NULL DEFAULT 1,name text NOT NULL,description text NOT NULL,manifest jsonb NOT NULL,manifest_hash text NOT NULL,status text NOT NULL CHECK(status IN('candidate','sandbox_tested','benchmarked','active','revoked')),evidence_ids jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(family_id,version))`,
      `CREATE INDEX memory_skills_owner_idx ON memory_skill_versions(owner_id,created_at)`,
      `CREATE TABLE memory_skill_evaluations(id text PRIMARY KEY,skill_id text NOT NULL REFERENCES memory_skill_versions(id),owner_id text NOT NULL,kind text NOT NULL,manifest_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    ])await sql.raw(statement).execute(tx);
    await tx.insertInto('schema_migrations').values({version:'007_memory_learning_v1'}).execute();
  });
}
