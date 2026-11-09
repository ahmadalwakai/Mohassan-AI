import { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

export interface DatabaseOptions {
  connectionString?: string;
  /** Omit for an isolated, in-memory test database. A path persists local data. */
  dataDir?: string;
}

export interface DatabaseHandle {
  // Better Auth adds its own tables; runtime exports typed records separately.
  db: Kysely<any>;
  mode: "postgres" | "embedded";
  close(): Promise<void>;
}

/** Prevent two Node processes from opening the same embedded Postgres files. */
async function acquireDirectoryLock(dataDir: string): Promise<() => Promise<void>> {
  await mkdir(dataDir, { recursive: true });
  if (process.platform === "win32") {
    // A Windows named-pipe bind is exclusive and the OS releases it on a crash.
    // Unlike a PID file, recovery cannot race by deleting a new owner's lock.
    const pipe = `\\\\.\\pipe\\mohassan-db-${createHash("sha256").update(dataDir.toLowerCase()).digest("hex")}`;
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolveLock, reject) => {
      server.once("error", reject);
      server.listen(pipe, () => { server.removeListener("error", reject); resolveLock(); });
    }).catch(() => { throw new Error("The embedded database is already open. Run one server, or use PostgreSQL for multiple processes."); });
    server.unref();
    return () => new Promise<void>((resolveLock, reject) => server.close((error) => error ? reject(error) : resolveLock()));
  }
  const path = join(dataDir, ".mohassan-owner.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await open(path, "wx", 0o600);
      await file.writeFile(JSON.stringify({ pid: process.pid, token }));
      await file.close();
      return async () => {
        try {
          const lock = JSON.parse(await readFile(path, "utf8"));
          if (lock.token === token) await unlink(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid: number };
      try {
        owner = JSON.parse(await readFile(path, "utf8"));
      } catch {
        throw new Error("Embedded database lock is unreadable; inspect the owning process before recovering it.");
      }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
        throw new Error("Embedded database lock has an invalid owner; manual inspection is required.");
      }
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          await unlink(path);
          continue;
        }
        throw error;
      }
      throw new Error("The embedded database is already open. Run one server, or use PostgreSQL for multiple processes.");
    }
  }
  throw new Error("Could not acquire embedded database ownership.");
}

export async function createDatabase(options: DatabaseOptions = {}): Promise<DatabaseHandle> {
  if (options.connectionString) {
    const target=new URL(options.connectionString);
    if(target.searchParams.get('sslmode')==='require')target.searchParams.set('sslmode','verify-full');
    const pool = new pg.Pool({
      connectionString: target.toString(),
      enableChannelBinding: target.searchParams.get('channel_binding')==='require',
      max: 8,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    const reportedErrors = new WeakSet<Error>();
    const reportConnectionError = (error: Error) => {
      if (reportedErrors.has(error)) return;
      reportedErrors.add(error);
      // Driver errors can include connection details; never log the error or client.
      console.error('[database] PostgreSQL connection lost. Failed operations are not retried; subsequent requests can reconnect.');
    };
    // pg removes failed idle clients itself, but an unhandled pool error crashes Node.
    pool.on('error', reportConnectionError);
    // Kysely checks clients out directly. Socket errors also need a listener while
    // checked out, including between queries; pg still rejects all pending queries.
    pool.on('connect', (client) => client.on('error', reportConnectionError));
    const db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
    return { db, mode: "postgres", close: () => db.destroy() };
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production. Embedded storage is for development only.");
  }
  const dataDir = options.dataDir ? resolve(options.dataDir) : undefined;
  const release = dataDir ? await acquireDirectoryLock(dataDir) : async () => {};
  try {
    const client = new PGlite(dataDir);
    await client.waitReady;
    const db = new Kysely<any>({ dialect: new PGliteDialect({ pglite: client }) });
    let closed = false;
    return {
      db,
      mode: "embedded",
      async close() {
        if (closed) return;
        closed = true;
        try { await db.destroy(); } finally { await release(); }
      },
    };
  } catch (error) {
    await release();
    throw error;
  }
}

const runtimeStatements = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id text PRIMARY KEY,
    owner_id text NOT NULL,
    title text NOT NULL,
    goal text NOT NULL,
    capability_id text NOT NULL,
    capability_version text NOT NULL DEFAULT '1.0.0',
    autonomy text NOT NULL CHECK (autonomy IN ('assisted','scoped','shadow')),
    status text NOT NULL CHECK (status IN ('queued','running','waiting_approval','verifying','completed','failed','cancelled','paused')),
    input_hash text NOT NULL,
    idempotency_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
    lease_token text,
    lease_expires_at timestamptz,
    cancellation_requested boolean NOT NULL DEFAULT false,
    event_sequence integer NOT NULL DEFAULT 0,
    result jsonb,
    error text,
    UNIQUE(owner_id,idempotency_key),
    UNIQUE(id,owner_id)
  )`,
  `CREATE INDEX IF NOT EXISTS tasks_owner_created_idx ON tasks(owner_id,created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS tasks_queue_idx ON tasks(status,available_at,lease_expires_at)`,
  `CREATE TABLE IF NOT EXISTS task_events (
    id text PRIMARY KEY,
    task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    sequence integer NOT NULL,
    type text NOT NULL,
    message text NOT NULL,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(task_id,sequence)
  )`,
  `CREATE TABLE IF NOT EXISTS approvals (
    id text PRIMARY KEY,
    task_id text NOT NULL,
    owner_id text NOT NULL,
    capability_id text NOT NULL,
    capability_version text NOT NULL,
    input_hash text NOT NULL,
    scope text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    consumed_lease_token text,
    revoked_at timestamptz,
    FOREIGN KEY(task_id,owner_id) REFERENCES tasks(id,owner_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS approvals_task_idx ON approvals(task_id,expires_at)`,
];

/** Fixed SQL, one version per transaction; no user-controlled SQL enters here. */
export async function migrate(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`.execute(db);
  await db.transaction().execute(async (tx) => {
    // Advisory locks serialize application migrations across PostgreSQL workers.
    await sql`SELECT pg_advisory_xact_lock(1846021104)`.execute(tx);
    const applied = await tx.selectFrom("schema_migrations")
      .select("version").where("version", "=", "001_runtime").executeTakeFirst();
    if (!applied) {
      for (const statement of runtimeStatements) await sql.raw(statement).execute(tx);
      await tx.insertInto("schema_migrations").values({ version: "001_runtime" }).execute();
    }
    const attemptApproval = await tx.selectFrom("schema_migrations")
      .select("version").where("version", "=", "002_approval_attempt").executeTakeFirst();
    if (!attemptApproval) {
      await sql`ALTER TABLE approvals ADD COLUMN IF NOT EXISTS consumed_lease_token text`.execute(tx);
      await tx.insertInto("schema_migrations").values({ version: "002_approval_attempt" }).execute();
    }
    const planning = await tx.selectFrom("schema_migrations")
      .select("version").where("version", "=", "003_cognitive_planning").executeTakeFirst();
    if (!planning) {
      await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS approval_required boolean NOT NULL DEFAULT false`.execute(tx);
      await sql`UPDATE tasks SET approval_required = true WHERE autonomy = 'assisted'`.execute(tx);
      await sql`CREATE TABLE task_plan_steps (
        task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        step_id text NOT NULL,
        position integer NOT NULL CHECK(position >= 0),
        title text NOT NULL,
        description text NOT NULL,
        capability_id text,
        required_scopes jsonb NOT NULL,
        requires_approval boolean NOT NULL,
        acceptance_criteria jsonb NOT NULL,
        availability text,
        status text NOT NULL DEFAULT 'planned' CHECK(status = 'planned'),
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(task_id,step_id),
        UNIQUE(task_id,position)
      )`.execute(tx);
      await sql`CREATE TABLE task_plan_dependencies (
        task_id text NOT NULL,
        step_id text NOT NULL,
        depends_on_step_id text NOT NULL,
        PRIMARY KEY(task_id,step_id,depends_on_step_id),
        FOREIGN KEY(task_id,step_id) REFERENCES task_plan_steps(task_id,step_id) ON DELETE CASCADE,
        FOREIGN KEY(task_id,depends_on_step_id) REFERENCES task_plan_steps(task_id,step_id) ON DELETE CASCADE,
        CHECK(step_id <> depends_on_step_id)
      )`.execute(tx);
      await sql`CREATE INDEX task_plan_dependencies_reverse_idx ON task_plan_dependencies(task_id,depends_on_step_id)`.execute(tx);
      await sql`CREATE TABLE model_runs (
        id text PRIMARY KEY,
        task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        attempt integer NOT NULL CHECK(attempt > 0),
        lease_token text NOT NULL UNIQUE,
        provider text NOT NULL DEFAULT 'groq',
        model text,
        status text NOT NULL CHECK(status IN ('started','succeeded','failed','unknown')),
        input_tokens integer CHECK(input_tokens >= 0),
        output_tokens integer CHECK(output_tokens >= 0),
        usage_known boolean NOT NULL DEFAULT false,
        result_committed boolean NOT NULL DEFAULT false,
        output_hash text,
        error_code text,
        started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at timestamptz,
        UNIQUE(task_id,attempt),
        CHECK(NOT usage_known OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL))
      )`.execute(tx);
      await sql`CREATE INDEX model_runs_task_started_idx ON model_runs(task_id,started_at)`.execute(tx);
      await tx.insertInto("schema_migrations").values({ version: "003_cognitive_planning" }).execute();
    }
    const coding=await tx.selectFrom('schema_migrations').select('version').where('version','=','004_coding_engine').executeTakeFirst();
    if(!coding){
      await sql`CREATE TABLE coding_projects (
        id text PRIMARY KEY,owner_id text NOT NULL,name text NOT NULL,repo_path text NOT NULL,base_commit text NOT NULL,
        allowed_paths jsonb NOT NULL,test_profile text NOT NULL CHECK(test_profile='node-test'),scope_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,scope_hash)
      )`.execute(tx);
      await sql`CREATE INDEX coding_projects_owner_idx ON coding_projects(owner_id,created_at)`.execute(tx);
      await sql`ALTER TABLE tasks ADD COLUMN project_id text REFERENCES coding_projects(id)`.execute(tx);
      await sql`CREATE TABLE coding_project_locks (
        resource_key text PRIMARY KEY,project_id text NOT NULL REFERENCES coding_projects(id),task_id text NOT NULL REFERENCES tasks(id),
        token text NOT NULL,expires_at timestamptz NOT NULL
      )`.execute(tx);
      await sql`CREATE TABLE coding_runs (
        id text PRIMARY KEY,task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,project_id text NOT NULL REFERENCES coding_projects(id),
        attempt integer NOT NULL,lease_token text NOT NULL UNIQUE,status text NOT NULL CHECK(status IN ('started','succeeded','failed','unknown')),
        result jsonb,result_committed boolean NOT NULL DEFAULT false,error_code text,started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
        UNIQUE(task_id,attempt)
      )`.execute(tx);
      await sql`CREATE INDEX coding_runs_task_idx ON coding_runs(task_id,started_at)`.execute(tx);
      await tx.insertInto('schema_migrations').values({version:'004_coding_engine'}).execute();
    }
    const studio = await tx.selectFrom('schema_migrations').select('version').where('version', '=', '005_visual_studio').executeTakeFirst();
    if (!studio) {
      await sql`CREATE TABLE studio_sessions (
        id text PRIMARY KEY,
        owner_id text NOT NULL,
        name text NOT NULL CHECK(char_length(name) BETWEEN 2 AND 100),
        source_path text,
        revision text NOT NULL CHECK(revision ~ '^[a-f0-9]{64}$'),
        base_snapshot jsonb NOT NULL,
        current_snapshot jsonb NOT NULL,
        undo_history jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(undo_history) = 'array' AND jsonb_array_length(undo_history) <= 20),
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(id,owner_id)
      )`.execute(tx);
      await sql`CREATE INDEX studio_sessions_owner_updated_idx ON studio_sessions(owner_id,updated_at DESC,id)`.execute(tx);
      await tx.insertInto('schema_migrations').values({ version: '005_visual_studio' }).execute();
    }
    const reactStudio = await tx.selectFrom('schema_migrations').select('version').where('version', '=', '006_react_studio').executeTakeFirst();
    if (!reactStudio) {
      await sql`CREATE TABLE studio_builds (
        session_id text NOT NULL REFERENCES studio_sessions(id) ON DELETE CASCADE,
        source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
        artifact jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(session_id,source_hash)
      )`.execute(tx);
      await sql`CREATE TABLE studio_build_locks (
        resource_key text PRIMARY KEY, token text NOT NULL, expires_at timestamptz NOT NULL
      )`.execute(tx);
      await tx.insertInto('schema_migrations').values({version:'006_react_studio'}).execute();
    }
    const studioTask=await tx.selectFrom('schema_migrations').select('version').where('version','=','007_studio_ai_input').executeTakeFirst();
    if(!studioTask){await sql`ALTER TABLE tasks ADD COLUMN studio_input jsonb`.execute(tx);await tx.insertInto('schema_migrations').values({version:'007_studio_ai_input'}).execute();}
    const browserTask=await tx.selectFrom('schema_migrations').select('version').where('version','=','011_browser_task_input').executeTakeFirst();
    if(!browserTask){await sql`ALTER TABLE tasks ADD COLUMN browser_input jsonb`.execute(tx);await tx.insertInto('schema_migrations').values({version:'011_browser_task_input'}).execute();}
    const skillTask=await tx.selectFrom('schema_migrations').select('version').where('version','=','023_runtime_skills').executeTakeFirst();
    if(!skillTask){
      await sql`ALTER TABLE tasks ADD COLUMN skill_input jsonb, ADD COLUMN skill_binding jsonb, ADD COLUMN skill_node_input jsonb, ADD COLUMN workflow_token text`.execute(tx);
      await sql`CREATE INDEX tasks_skill_parent_idx ON tasks((skill_binding->>'parentTaskId')) WHERE skill_binding IS NOT NULL`.execute(tx);
      await tx.insertInto('schema_migrations').values({version:'023_runtime_skills'}).execute();
    }
    const skillRecovery=await tx.selectFrom('schema_migrations').select('version').where('version','=','025_runtime_recovery').executeTakeFirst();
    if(!skillRecovery){
      await sql`ALTER TABLE tasks ADD COLUMN verification_only boolean NOT NULL DEFAULT false, ADD COLUMN verification_source_lease text, ADD COLUMN recovery_result jsonb, ADD COLUMN skill_rollback_input jsonb, ADD COLUMN skill_rollback_review jsonb`.execute(tx);
      await tx.insertInto('schema_migrations').values({version:'025_runtime_recovery'}).execute();
    }
    const experiences = await tx.selectFrom('schema_migrations').select('version').where('version', '=', '026_experiences').executeTakeFirst();
    if (!experiences) {
      await sql`ALTER TABLE tasks ADD COLUMN experience_parent_run_id text`.execute(tx);
      await sql`CREATE INDEX tasks_experience_parent_idx ON tasks(owner_id, experience_parent_run_id) WHERE experience_parent_run_id IS NOT NULL`.execute(tx);
      await sql`CREATE TABLE experiences (
        owner_id text NOT NULL,
        source_kind text NOT NULL CHECK (source_kind IN ('chat_run', 'runtime_task')),
        source_id text NOT NULL,
        parent_run_id text CHECK (parent_run_id IS NULL OR source_kind = 'runtime_task'),
        attempt integer NOT NULL CHECK (attempt >= 0),
        goal text NOT NULL,
        category text NOT NULL CHECK (category IN ('conversation', 'research', 'browser', 'coding', 'computer')),
        terminal_status text NOT NULL CHECK (terminal_status IN ('completed', 'partial', 'blocked', 'failed', 'cancelled', 'interrupted')),
        plan jsonb NOT NULL,
        trail jsonb NOT NULL,
        models jsonb NOT NULL,
        artifact_hashes jsonb NOT NULL,
        outcome text NOT NULL CHECK (outcome IN ('verified_success', 'verified_failure', 'unverified')),
        evidence_kind text NOT NULL CHECK (evidence_kind IN ('test_result', 'page_observation', 'api_readback', 'owner_confirmed', 'none')),
        evidence jsonb,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK ((outcome = 'unverified') = (evidence_kind = 'none')),
        CHECK ((evidence_kind = 'none') = (evidence IS NULL)),
        PRIMARY KEY (owner_id, source_kind, source_id)
      )`.execute(tx);
      await sql`CREATE TABLE experience_feedback (
        id text PRIMARY KEY,
        owner_id text NOT NULL,
        source_kind text NOT NULL,
        source_id text NOT NULL,
        attempt integer NOT NULL CHECK (attempt >= 0),
        submission_hash text NOT NULL,
        rating integer CHECK (rating BETWEEN 1 AND 5),
        confirmed text CHECK (confirmed IN ('success', 'failure')),
        memory_feedback_id text,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (rating IS NOT NULL OR confirmed IS NOT NULL),
        UNIQUE (owner_id, submission_hash),
        FOREIGN KEY (owner_id, source_kind, source_id) REFERENCES experiences ON DELETE CASCADE
      )`.execute(tx);
      await tx.insertInto('schema_migrations').values({ version: '026_experiences' }).execute();
    }
  });
}

export { sql } from "kysely";
export type { RuntimeDatabase, TaskRecord, TaskEventRecord, ApprovalRecord, TaskPlanStepRecord, TaskPlanDependencyRecord, ModelRunRecord } from "./records.ts";
