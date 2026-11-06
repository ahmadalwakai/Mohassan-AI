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

const EXECUTION = [
  `CREATE TABLE skill_runs(id text PRIMARY KEY,owner_id text NOT NULL,parent_task_id text NOT NULL UNIQUE REFERENCES tasks(id),input_hash text NOT NULL,plan jsonb NOT NULL,input_values jsonb NOT NULL,pinned_versions jsonb NOT NULL,status text NOT NULL CHECK(status IN('running','waiting_children','succeeded','failed','cancelled','unknown')),result jsonb,error_code text,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,finished_at timestamptz)`,
  `CREATE TABLE skill_run_nodes(run_id text NOT NULL REFERENCES skill_runs(id),node_id text NOT NULL,owner_id text NOT NULL,version_id text NOT NULL REFERENCES skill_versions(id),content_hash text NOT NULL,composition_node_id text NOT NULL,step_id text NOT NULL,kind text NOT NULL CHECK(kind IN('tool','model','script')),tool text,contract jsonb NOT NULL,step jsonb NOT NULL,dependencies jsonb NOT NULL,input_bindings jsonb NOT NULL,inputs jsonb,inputs_hash text,output_schema jsonb NOT NULL,outputs jsonb,output_hash text,child_task_id text UNIQUE REFERENCES tasks(id),idempotency_key text NOT NULL,status text NOT NULL CHECK(status IN('pending','queued','running','succeeded','failed','cancelled','unknown')),lease_token text,lease_expires_at timestamptz,attempt integer NOT NULL DEFAULT 0,error_code text,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,started_at timestamptz,finished_at timestamptz,PRIMARY KEY(run_id,node_id))`,
  `CREATE INDEX skill_run_nodes_ready_idx ON skill_run_nodes(run_id,status)`,
  `CREATE TABLE skill_evidence(id text PRIMARY KEY,owner_id text NOT NULL,run_id text NOT NULL,node_id text NOT NULL,task_id text NOT NULL REFERENCES tasks(id),version_id text NOT NULL,content_hash text NOT NULL,inputs_hash text NOT NULL,lease_token text NOT NULL,node_lease_token text NOT NULL,workflow_token text NOT NULL,status text NOT NULL CHECK(status IN('started','succeeded','failed','unknown')),output jsonb,output_hash text,details jsonb NOT NULL DEFAULT '[]',error_code text,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,finished_at timestamptz,FOREIGN KEY(run_id,node_id) REFERENCES skill_run_nodes(run_id,node_id),UNIQUE(run_id,node_id))`,
  `CREATE TABLE skill_preimages(id text PRIMARY KEY,receipt_id text NOT NULL REFERENCES skill_evidence(id),owner_id text NOT NULL,root text NOT NULL,path text NOT NULL,before_text text,before_hash text,after_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(receipt_id,root,path))`,
  `CREATE TABLE skill_resource_locks(resource_key text PRIMARY KEY,receipt_id text NOT NULL REFERENCES skill_evidence(id),run_id text NOT NULL,node_id text NOT NULL,owner_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
] as const;

const RECOVERY = [
  `ALTER TABLE skill_run_nodes ADD COLUMN execution_attempt integer NOT NULL DEFAULT 1 CHECK(execution_attempt BETWEEN 1 AND 3)`,
  `ALTER TABLE skill_run_nodes ADD COLUMN retry_not_before timestamptz`,
  `ALTER TABLE skill_run_nodes ADD COLUMN recovery_reason text`,
  `ALTER TABLE skill_evidence ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK(attempt BETWEEN 1 AND 3)`,
  `ALTER TABLE skill_evidence DROP CONSTRAINT skill_evidence_run_id_node_id_key`,
  `ALTER TABLE skill_evidence ADD CONSTRAINT skill_evidence_run_node_attempt_key UNIQUE(run_id,node_id,attempt)`,
  `CREATE INDEX skill_run_nodes_retry_due_idx ON skill_run_nodes(retry_not_before,run_id) WHERE status='pending' AND retry_not_before IS NOT NULL`,
  `CREATE TABLE skill_circuit_state(id text PRIMARY KEY,owner_id text NOT NULL,version_id text NOT NULL REFERENCES skill_versions(id),content_hash text NOT NULL,target text NOT NULL,status text NOT NULL CHECK(status IN('closed','open','half_open')),failures integer NOT NULL DEFAULT 0,generation integer NOT NULL DEFAULT 1,opened_until timestamptz,probe_token text,probe_until timestamptz,updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX skill_circuit_owner_idx ON skill_circuit_state(owner_id,version_id)`,
  `CREATE TABLE skill_circuit_outcomes(ticket_id text PRIMARY KEY,state_id text NOT NULL REFERENCES skill_circuit_state(id),generation integer NOT NULL,outcome text NOT NULL CHECK(outcome IN('success','transient_failure','neutral','stale')),created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE skill_rollbacks(id text PRIMARY KEY,owner_id text NOT NULL,run_id text NOT NULL REFERENCES skill_runs(id),preimage_id text NOT NULL REFERENCES skill_preimages(id),source_receipt_id text NOT NULL REFERENCES skill_evidence(id),task_id text NOT NULL UNIQUE REFERENCES tasks(id),lease_token text NOT NULL,input_hash text NOT NULL,before_hash text,after_hash text NOT NULL,status text NOT NULL CHECK(status IN('started','succeeded','failed','unknown')),effect_started boolean NOT NULL DEFAULT false,result jsonb,result_hash text,error_code text,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,finished_at timestamptz)`,
  `CREATE UNIQUE INDEX skill_rollbacks_preimage_once_idx ON skill_rollbacks(preimage_id) WHERE status IN('started','unknown','succeeded')`,
  `ALTER TABLE skill_resource_locks ALTER COLUMN receipt_id DROP NOT NULL`,
  `ALTER TABLE skill_resource_locks ADD COLUMN rollback_id text REFERENCES skill_rollbacks(id)`,
  `ALTER TABLE skill_resource_locks ADD CONSTRAINT skill_resource_lock_owner CHECK((receipt_id IS NOT NULL AND rollback_id IS NULL) OR (receipt_id IS NULL AND rollback_id IS NOT NULL))`,
] as const;

const GAPS = [
  `CREATE TABLE skill_gaps(id text PRIMARY KEY,owner_id text NOT NULL,chat_run_id text NOT NULL,outcome text NOT NULL CHECK(outcome IN('partial','blocked','failed')),category text CHECK(category IN('missing_skill','missing_tool','missing_permission','model_limitation','invalid_plan','stale_data','environment_failure','sandbox_restriction')),reason text NOT NULL,signal jsonb,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(owner_id,chat_run_id))`,
  `CREATE INDEX skill_gaps_owner_idx ON skill_gaps(owner_id,created_at DESC,id)`,
] as const;

const GRAPH = [
  `CREATE TABLE skill_edges(owner_id text NOT NULL,edge_key text NOT NULL,record_kind text NOT NULL CHECK(record_kind IN('edge','snapshot')),payload jsonb NOT NULL,PRIMARY KEY(owner_id,edge_key))`,
] as const;

const EVALUATION = [
  `CREATE TABLE skill_benchmarks(id text PRIMARY KEY,suite_id text NOT NULL,scope text NOT NULL,suite_hash text NOT NULL,config_hash text NOT NULL,verifier_version text NOT NULL,definition jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(suite_hash,config_hash,verifier_version))`,
  `CREATE TABLE skill_benchmark_runs(id text PRIMARY KEY,owner_id text NOT NULL,baseline_id text NOT NULL REFERENCES skill_versions(id),candidate_id text NOT NULL REFERENCES skill_versions(id),baseline_pin jsonb NOT NULL,candidate_pin jsonb NOT NULL,benchmark_id text NOT NULL REFERENCES skill_benchmarks(id),suite_hash text NOT NULL,suite_snapshot jsonb NOT NULL,pins_hash text NOT NULL,status text NOT NULL CHECK(status IN('running','completed','failed','unknown')),results jsonb NOT NULL DEFAULT '[]',results_hash text NOT NULL,idempotency_key text NOT NULL,request_hash text NOT NULL,run_token text NOT NULL,lease_expires_at timestamptz NOT NULL,started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,finished_at timestamptz,error_code text,UNIQUE(owner_id,idempotency_key))`,
  `CREATE INDEX skill_benchmark_runs_owner_idx ON skill_benchmark_runs(owner_id,started_at DESC,id)`,
  `CREATE INDEX skill_benchmark_runs_candidate_idx ON skill_benchmark_runs(owner_id,candidate_id,started_at DESC)`,
  `CREATE TABLE skill_quality_snapshots(id text PRIMARY KEY,owner_id text NOT NULL,evaluation_id text NOT NULL REFERENCES skill_benchmark_runs(id),identity_hash text NOT NULL,payload jsonb NOT NULL,payload_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(owner_id,evaluation_id))`,
] as const;

const FORGE = [
  `CREATE TABLE skill_forge_generations(id text PRIMARY KEY,owner_id text NOT NULL,baseline_id text NOT NULL REFERENCES skill_versions(id),baseline_pin jsonb NOT NULL,mode text NOT NULL CHECK(mode IN('mutate','fork')),target_slug text NOT NULL,target_version text NOT NULL,target_family_id text REFERENCES skill_families(id),candidate_id text UNIQUE REFERENCES skill_versions(id),candidate_content_hash text,status text NOT NULL CHECK(status IN('running','succeeded','failed','unknown')),request_hash text NOT NULL,prompt_hash text NOT NULL,pins_hash text NOT NULL,lineage_hash text,response_hash text,model text,usage jsonb,http_status integer,retry_after_ms bigint,error_code text,failure_analysis jsonb,idempotency_key text NOT NULL,run_token text NOT NULL,call_token text NOT NULL,lease_expires_at timestamptz NOT NULL,started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,finished_at timestamptz,UNIQUE(owner_id,idempotency_key))`,
  `CREATE INDEX skill_forge_owner_idx ON skill_forge_generations(owner_id,started_at DESC,id)`,
] as const;

/** Fixed, versioned SQL. Existing rows are retained. Reversal requires a reviewed
 * database restore/migration plan; dropping skill tables would destroy history. */
export async function skillsMigration(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`.execute(db);
  await db.transaction().execute(async (tx) => {
    await sql`SELECT pg_advisory_xact_lock(1846021108)`.execute(tx);
    for (const [version, statements] of [['015_skill_registry', REGISTRY], ['016_skill_security', SECURITY], ['017_skill_execution', EXECUTION], ['024_skill_recovery', RECOVERY], ['018_skill_gaps', GAPS], ['019_skill_graph', GRAPH], ['020_skill_eval', EVALUATION], ['021_skill_forge', FORGE]] as const) {
      if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', version).executeTakeFirst()) continue;
      for (const statement of statements) await sql.raw(statement).execute(tx);
      await tx.insertInto('schema_migrations').values({ version }).execute();
    }
  });
}
