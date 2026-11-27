-- Captured from a fresh createApplication startup at c2a0ff7 with skillEngineEnabled=true.
-- Source retrieved 2026-11-27: https://github.com/ahmadalwakai/Mohassan-AI/tree/c2a0ff765071657cf200b5ee7d12fabaad738c0b
-- The statements are the Kysely query log from the historical startup, in execution order.
-- The export keeps schema DDL and ledger inserts, omitting repeated IF NOT EXISTS DDL and recovery queries on empty tables.

CREATE TABLE IF NOT EXISTS auth_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS "user" (
    id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
    "emailVerified" boolean NOT NULL DEFAULT false, image text,
    "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
  );

CREATE TABLE IF NOT EXISTS session (
    id text PRIMARY KEY, "expiresAt" timestamptz NOT NULL, token text NOT NULL UNIQUE,
    "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
    "ipAddress" text, "userAgent" text, "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
  );

CREATE INDEX IF NOT EXISTS session_user_idx ON session ("userId");

CREATE TABLE IF NOT EXISTS account (
    id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
    "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "accessToken" text, "refreshToken" text, "idToken" text,
    "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
    scope text, password text, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("providerId", "accountId")
  );

CREATE TABLE IF NOT EXISTS verification (
    id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL,
    "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
  );

CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification(identifier);

CREATE TABLE IF NOT EXISTS "rateLimit" (
    id text PRIMARY KEY, key text NOT NULL UNIQUE, count integer NOT NULL, "lastRequest" bigint NOT NULL
  );

CREATE TABLE IF NOT EXISTS workspace_owner (
    id integer PRIMARY KEY CHECK (id = 1), owner_id text REFERENCES "user"(id),
    claimed_at timestamptz NOT NULL DEFAULT now()
  );

insert into "auth_schema_migrations" ("version") values ('001_auth');

CREATE TABLE IF NOT EXISTS workspace_members (
      user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('owner', 'member')),
      invite_id text, created_at timestamptz NOT NULL DEFAULT now(), disabled_at timestamptz
    );

CREATE TABLE IF NOT EXISTS workspace_invites (
      id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, email text NOT NULL, name text NOT NULL,
      created_by text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
      claimed_at timestamptz, consumed_by text REFERENCES "user"(id) ON DELETE SET NULL, revoked_at timestamptz
    );

CREATE INDEX IF NOT EXISTS workspace_invites_email_idx ON workspace_invites(email);

insert into "auth_schema_migrations" ("version") values ('002_members');

CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

CREATE TABLE IF NOT EXISTS tasks (
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
  );

CREATE INDEX IF NOT EXISTS tasks_owner_created_idx ON tasks(owner_id,created_at DESC);

CREATE INDEX IF NOT EXISTS tasks_queue_idx ON tasks(status,available_at,lease_expires_at);

CREATE TABLE IF NOT EXISTS task_events (
    id text PRIMARY KEY,
    task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    sequence integer NOT NULL,
    type text NOT NULL,
    message text NOT NULL,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(task_id,sequence)
  );

CREATE TABLE IF NOT EXISTS approvals (
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
  );

CREATE INDEX IF NOT EXISTS approvals_task_idx ON approvals(task_id,expires_at);

insert into "schema_migrations" ("version") values ('001_runtime');

ALTER TABLE approvals ADD COLUMN IF NOT EXISTS consumed_lease_token text;

insert into "schema_migrations" ("version") values ('002_approval_attempt');

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS approval_required boolean NOT NULL DEFAULT false;

CREATE TABLE task_plan_steps (
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
      );

CREATE TABLE task_plan_dependencies (
        task_id text NOT NULL,
        step_id text NOT NULL,
        depends_on_step_id text NOT NULL,
        PRIMARY KEY(task_id,step_id,depends_on_step_id),
        FOREIGN KEY(task_id,step_id) REFERENCES task_plan_steps(task_id,step_id) ON DELETE CASCADE,
        FOREIGN KEY(task_id,depends_on_step_id) REFERENCES task_plan_steps(task_id,step_id) ON DELETE CASCADE,
        CHECK(step_id <> depends_on_step_id)
      );

CREATE INDEX task_plan_dependencies_reverse_idx ON task_plan_dependencies(task_id,depends_on_step_id);

CREATE TABLE model_runs (
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
      );

CREATE INDEX model_runs_task_started_idx ON model_runs(task_id,started_at);

insert into "schema_migrations" ("version") values ('003_cognitive_planning');

CREATE TABLE coding_projects (
        id text PRIMARY KEY,owner_id text NOT NULL,name text NOT NULL,repo_path text NOT NULL,base_commit text NOT NULL,
        allowed_paths jsonb NOT NULL,test_profile text NOT NULL CHECK(test_profile='node-test'),scope_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,scope_hash)
      );

CREATE INDEX coding_projects_owner_idx ON coding_projects(owner_id,created_at);

ALTER TABLE tasks ADD COLUMN project_id text REFERENCES coding_projects(id);

CREATE TABLE coding_project_locks (
        resource_key text PRIMARY KEY,project_id text NOT NULL REFERENCES coding_projects(id),task_id text NOT NULL REFERENCES tasks(id),
        token text NOT NULL,expires_at timestamptz NOT NULL
      );

CREATE TABLE coding_runs (
        id text PRIMARY KEY,task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,project_id text NOT NULL REFERENCES coding_projects(id),
        attempt integer NOT NULL,lease_token text NOT NULL UNIQUE,status text NOT NULL CHECK(status IN ('started','succeeded','failed','unknown')),
        result jsonb,result_committed boolean NOT NULL DEFAULT false,error_code text,started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
        UNIQUE(task_id,attempt)
      );

CREATE INDEX coding_runs_task_idx ON coding_runs(task_id,started_at);

insert into "schema_migrations" ("version") values ('004_coding_engine');

CREATE TABLE studio_sessions (
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
      );

CREATE INDEX studio_sessions_owner_updated_idx ON studio_sessions(owner_id,updated_at DESC,id);

insert into "schema_migrations" ("version") values ('005_visual_studio');

CREATE TABLE studio_builds (
        session_id text NOT NULL REFERENCES studio_sessions(id) ON DELETE CASCADE,
        source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
        artifact jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(session_id,source_hash)
      );

CREATE TABLE studio_build_locks (
        resource_key text PRIMARY KEY, token text NOT NULL, expires_at timestamptz NOT NULL
      );

insert into "schema_migrations" ("version") values ('006_react_studio');

ALTER TABLE tasks ADD COLUMN studio_input jsonb;

insert into "schema_migrations" ("version") values ('007_studio_ai_input');

ALTER TABLE tasks ADD COLUMN browser_input jsonb;

insert into "schema_migrations" ("version") values ('011_browser_task_input');

ALTER TABLE tasks ADD COLUMN skill_input jsonb, ADD COLUMN skill_binding jsonb, ADD COLUMN skill_node_input jsonb, ADD COLUMN workflow_token text;

CREATE INDEX tasks_skill_parent_idx ON tasks((skill_binding->>'parentTaskId')) WHERE skill_binding IS NOT NULL;

insert into "schema_migrations" ("version") values ('023_runtime_skills');

ALTER TABLE tasks ADD COLUMN verification_only boolean NOT NULL DEFAULT false, ADD COLUMN verification_source_lease text, ADD COLUMN recovery_result jsonb, ADD COLUMN skill_rollback_input jsonb, ADD COLUMN skill_rollback_review jsonb;

insert into "schema_migrations" ("version") values ('025_runtime_recovery');

ALTER TABLE tasks ADD COLUMN experience_parent_run_id text;

CREATE INDEX tasks_experience_parent_idx ON tasks(owner_id, experience_parent_run_id) WHERE experience_parent_run_id IS NOT NULL;

CREATE TABLE experiences (
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
      );

CREATE TABLE experience_feedback (
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
      );

insert into "schema_migrations" ("version") values ('026_experiences');

CREATE TABLE IF NOT EXISTS windows_pairings(id text PRIMARY KEY,owner_id text NOT NULL,session_binding text NOT NULL,code_hash text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS windows_devices(id text PRIMARY KEY,owner_id text NOT NULL,name text NOT NULL,key_hash text NOT NULL,revoked_at timestamptz,last_seen_at timestamptz,state jsonb,last_frame jsonb,stopped_nonce text,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE INDEX IF NOT EXISTS windows_devices_owner_idx ON windows_devices(owner_id,created_at);

CREATE TABLE IF NOT EXISTS windows_grants(id text PRIMARY KEY,owner_id text NOT NULL,device_id text NOT NULL REFERENCES windows_devices(id),session_binding text NOT NULL,scope text NOT NULL CHECK(scope IN ('view','control')),target_key text NOT NULL,approval_nonce text NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,next_sequence integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS windows_commands(id text PRIMARY KEY,grant_id text NOT NULL REFERENCES windows_grants(id),device_id text NOT NULL REFERENCES windows_devices(id),owner_id text NOT NULL,nonce text NOT NULL,sequence integer NOT NULL,frame_id text NOT NULL,payload jsonb NOT NULL,status text NOT NULL CHECK(status IN ('queued','dispatched','applied','rejected','unknown')),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,finished_at timestamptz,result_code text,UNIQUE(grant_id,sequence),UNIQUE(grant_id,nonce));

ALTER TABLE windows_commands ADD COLUMN IF NOT EXISTS input_hash text;

CREATE TABLE IF NOT EXISTS windows_poll_nonces(device_id text NOT NULL REFERENCES windows_devices(id),nonce text NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(device_id,nonce));

CREATE TABLE IF NOT EXISTS windows_audit(id text PRIMARY KEY,owner_id text NOT NULL,device_id text,type text NOT NULL,detail jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE INDEX IF NOT EXISTS windows_audit_owner_idx ON windows_audit(owner_id,created_at DESC);

CREATE TABLE IF NOT EXISTS google_ads_connections(owner_id text PRIMARY KEY,sealed_refresh_token text,status text NOT NULL CHECK(status IN ('disconnected','needs_account','connected','unauthorized')),customer_id text,login_customer_id text,account_name text,currency text,time_zone text,test_account boolean NOT NULL DEFAULT false,booking_rules jsonb NOT NULL DEFAULT '[]'::jsonb,connected_at timestamptz,last_checked_at timestamptz,rate_limited_until timestamptz,updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS google_ads_oauth_states(state_hash text PRIMARY KEY,owner_id text NOT NULL,sealed_verifier text NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS google_ads_drafts(id text PRIMARY KEY,owner_id text NOT NULL,customer_id text NOT NULL,idempotency_key text NOT NULL,state text NOT NULL,revision integer NOT NULL DEFAULT 1,brief jsonb NOT NULL,bidding text NOT NULL,operations jsonb NOT NULL,draft_hash text NOT NULL,geo_targets jsonb NOT NULL DEFAULT '[]'::jsonb,summary jsonb,strategy jsonb,validation jsonb,verification jsonb,campaign_resource_name text,error text,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(owner_id,idempotency_key));

CREATE INDEX IF NOT EXISTS google_ads_drafts_owner_idx ON google_ads_drafts(owner_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS google_ads_automatic_requests(owner_id text NOT NULL,idempotency_key text NOT NULL,draft_id text NOT NULL REFERENCES google_ads_drafts(id),status text NOT NULL CHECK(status IN ('running','completed','blocked','unknown')),created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(owner_id,idempotency_key));

CREATE TABLE IF NOT EXISTS google_ads_approvals(id text PRIMARY KEY,owner_id text NOT NULL,draft_id text NOT NULL REFERENCES google_ads_drafts(id) ON DELETE CASCADE,action text NOT NULL CHECK(action IN ('publish','launch')),draft_hash text NOT NULL,customer_id text NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE INDEX IF NOT EXISTS google_ads_approvals_draft_idx ON google_ads_approvals(draft_id,action,expires_at);

CREATE TABLE IF NOT EXISTS google_ads_audit(id text PRIMARY KEY,owner_id text NOT NULL,draft_id text,type text NOT NULL,detail jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE INDEX IF NOT EXISTS google_ads_audit_owner_idx ON google_ads_audit(owner_id,created_at DESC);

CREATE TABLE IF NOT EXISTS google_ads_experiences(id text PRIMARY KEY,owner_id text NOT NULL,customer_id text NOT NULL,kind text NOT NULL,statement text NOT NULL,evidence jsonb NOT NULL,dedup_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(owner_id,dedup_key));

CREATE TABLE IF NOT EXISTS google_ads_recovery_lessons(owner_id text NOT NULL,category text NOT NULL,code text NOT NULL,strategy text NOT NULL,verified_by text NOT NULL CHECK(verified_by IN ('local_validator','google_validate_only','google_readback')),successes integer NOT NULL DEFAULT 0,failures integer NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(owner_id,category,code,strategy,verified_by));

CREATE TABLE IF NOT EXISTS studio_live_sessions(id text PRIMARY KEY,owner_id text NOT NULL,session_id text NOT NULL,revision text NOT NULL,cap_hash text NOT NULL UNIQUE,name text NOT NULL,status text NOT NULL,nonce text NOT NULL,elements jsonb NOT NULL DEFAULT '[]',expires_at timestamptz NOT NULL,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());

CREATE INDEX IF NOT EXISTS studio_live_owner_idx ON studio_live_sessions(owner_id,created_at DESC);

CREATE TABLE IF NOT EXISTS studio_live_requests(live_id text NOT NULL REFERENCES studio_live_sessions(id) ON DELETE CASCADE,request_id text NOT NULL,request_hash text NOT NULL,status text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(live_id,request_id));

insert into "schema_migrations" ("version") values ('010_studio_live') on conflict ("version") do nothing;

CREATE TABLE studio_review_images(id text PRIMARY KEY,owner_id text NOT NULL,session_id text NOT NULL REFERENCES studio_sessions(id),task_id text NOT NULL REFERENCES tasks(id),source_hash text NOT NULL,document_hash text NOT NULL,content_hash text NOT NULL,data_base64 text NOT NULL CHECK(char_length(data_base64)<=5600000),width integer NOT NULL,height integer NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,expires_at timestamptz NOT NULL);

CREATE INDEX studio_review_images_owner_expiry_idx ON studio_review_images(owner_id,expires_at);

insert into "schema_migrations" ("version") values ('009_studio_visual_reviews');

CREATE TABLE studio_images(id text PRIMARY KEY,owner_id text NOT NULL,content_hash text NOT NULL,mime_type text NOT NULL CHECK(mime_type IN('image/png','image/jpeg')),width integer NOT NULL CHECK(width BETWEEN 32 AND 1600),height integer NOT NULL CHECK(height BETWEEN 32 AND 1600),data_base64 text NOT NULL CHECK(char_length(data_base64)<=1400000),created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,expires_at timestamptz NOT NULL);

CREATE INDEX studio_images_owner_expiry_idx ON studio_images(owner_id,expires_at);

CREATE TABLE studio_ai_proposals(id text PRIMARY KEY,owner_id text NOT NULL,task_id text NOT NULL UNIQUE REFERENCES tasks(id),session_id text NOT NULL REFERENCES studio_sessions(id),base_revision text NOT NULL,status text NOT NULL CHECK(status IN('started','ready','failed','applied')),payload jsonb,payload_hash text,applied_revision text,applied_at timestamptz,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE INDEX studio_ai_proposals_owner_idx ON studio_ai_proposals(owner_id,created_at);

insert into "schema_migrations" ("version") values ('008_studio_ai_proposals');

CREATE TABLE IF NOT EXISTS search_owners(owner_id text PRIMARY KEY, index_revision bigint NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS search_cache(owner_id text NOT NULL, cache_key text NOT NULL, policy text NOT NULL, index_revision bigint NOT NULL, result jsonb NOT NULL, fetched_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(owner_id,cache_key));

CREATE INDEX IF NOT EXISTS search_cache_expiry ON search_cache(expires_at);

CREATE TABLE IF NOT EXISTS search_provider_admission(provider text PRIMARY KEY, active_token text, acquired_at timestamptz, next_allowed_at timestamptz NOT NULL DEFAULT '1970-01-01');

CREATE TABLE IF NOT EXISTS search_provider_queries(provider text NOT NULL, query_hash text NOT NULL, next_allowed_at timestamptz NOT NULL, PRIMARY KEY(provider,query_hash));

CREATE TABLE IF NOT EXISTS search_index_documents(id text PRIMARY KEY, owner_id text NOT NULL, url text NOT NULL, url_hash text NOT NULL, source_hash text NOT NULL, content_hash text NOT NULL, title text NOT NULL, content text NOT NULL, term_count integer NOT NULL, fetched_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, UNIQUE(owner_id,url_hash), UNIQUE(owner_id,content_hash));

CREATE INDEX IF NOT EXISTS search_index_owner_expiry ON search_index_documents(owner_id,expires_at);

CREATE TABLE IF NOT EXISTS search_index_terms(document_id text NOT NULL REFERENCES search_index_documents(id) ON DELETE CASCADE, owner_id text NOT NULL, term text NOT NULL, frequency integer NOT NULL, PRIMARY KEY(document_id,term));

CREATE INDEX IF NOT EXISTS search_index_owner_term ON search_index_terms(owner_id,term);

CREATE TABLE IF NOT EXISTS browser_sessions(id text PRIMARY KEY,owner_id text NOT NULL,title text NOT NULL,allowed_origins jsonb NOT NULL,status text NOT NULL DEFAULT 'open',observation jsonb,sequence integer NOT NULL DEFAULT 0,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());

CREATE INDEX IF NOT EXISTS browser_sessions_owner_idx ON browser_sessions(owner_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS browser_observations(id text PRIMARY KEY,session_id text NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,sequence integer NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(session_id,sequence));

CREATE TABLE IF NOT EXISTS browser_events(id text PRIMARY KEY,session_id text NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,kind text NOT NULL,message text NOT NULL,data jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS browser_approvals(id text PRIMARY KEY,session_id text NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,owner_id text NOT NULL,observation_id text NOT NULL,digest text NOT NULL,request jsonb NOT NULL,status text NOT NULL DEFAULT 'pending',expires_at timestamptz NOT NULL,receipt jsonb,created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS browser_locks(resource_key text PRIMARY KEY,token text NOT NULL,expires_at timestamptz NOT NULL);

CREATE TABLE IF NOT EXISTS research_runs(id text PRIMARY KEY,owner_id text NOT NULL,question text NOT NULL,status text NOT NULL,report jsonb,error text,lease_expires_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());

ALTER TABLE research_runs ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS research_runs_owner_idx ON research_runs(owner_id,created_at DESC);

CREATE TABLE browser_task_receipts (
      task_id text PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      owner_id text NOT NULL,
      lease_token text NOT NULL,
      session_id text REFERENCES browser_sessions(id),
      status text NOT NULL CHECK(status IN ('started','ready','failed')),
      input_hash text NOT NULL,
      observation jsonb,
      content_hash text,
      screenshot_hash text,
      result jsonb,
      result_hash text,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

CREATE INDEX browser_task_receipts_owner_idx ON browser_task_receipts(owner_id,created_at DESC);

insert into "schema_migrations" ("version") values ('012_browser_task_receipts');

CREATE TABLE IF NOT EXISTS ai_provider_health (
      id text PRIMARY KEY, config_fingerprint text NOT NULL, status text NOT NULL CHECK(status IN ('verified','error')),
      model text NOT NULL, verified_at timestamptz, checked_at timestamptz NOT NULL DEFAULT now(),
      error_code text, input_tokens integer, output_tokens integer
    );

CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE memory_evidence(id text PRIMARY KEY,owner_id text NOT NULL,source_key text NOT NULL,kind text NOT NULL CHECK(kind IN('manual','task','task_result','task_error','feedback')),description text NOT NULL,task_id text,event_id text,content_hash text NOT NULL,trust text NOT NULL CHECK(trust IN('manual','observed')),status text NOT NULL DEFAULT 'active',observed_at timestamptz NOT NULL,expires_at timestamptz,UNIQUE(owner_id,source_key));

CREATE TABLE memory_items(id text PRIMARY KEY,root_id text NOT NULL,owner_id text NOT NULL,version integer NOT NULL CHECK(version>0),layer text NOT NULL CHECK(layer IN('working','episodic','semantic','procedural','failure','preference')),title text NOT NULL,content text NOT NULL,status text NOT NULL CHECK(status IN('active','superseded','revoked')),confidence double precision NOT NULL CHECK(confidence>=0 AND confidence<=1),confidence_kind text NOT NULL CHECK(confidence_kind IN('user_asserted','task_observed')),task_id text,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(owner_id,root_id,version));

CREATE INDEX memory_owner_layer_expiry_idx ON memory_items(owner_id,status,layer,expires_at);

CREATE TABLE memory_provenance(memory_id text NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,evidence_id text NOT NULL REFERENCES memory_evidence(id),relation text NOT NULL DEFAULT 'asserted',PRIMARY KEY(memory_id,evidence_id));

CREATE TABLE memory_feedback(id text PRIMARY KEY,owner_id text NOT NULL,task_id text NOT NULL,kind text NOT NULL,comment text NOT NULL,rating integer,persisted_preference boolean NOT NULL,submission_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(owner_id,submission_key));

CREATE TABLE memory_audit(id text PRIMARY KEY,owner_id text NOT NULL,target_id text NOT NULL,operation text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE memory_skill_families(id text PRIMARY KEY,owner_id text NOT NULL,name text NOT NULL,active_skill_id text,revision integer NOT NULL DEFAULT 1);

CREATE TABLE memory_skill_versions(id text PRIMARY KEY,family_id text NOT NULL REFERENCES memory_skill_families(id),owner_id text NOT NULL,version integer NOT NULL,revision integer NOT NULL DEFAULT 1,name text NOT NULL,description text NOT NULL,manifest jsonb NOT NULL,manifest_hash text NOT NULL,status text NOT NULL CHECK(status IN('candidate','sandbox_tested','benchmarked','active','revoked')),evidence_ids jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(family_id,version));

CREATE INDEX memory_skills_owner_idx ON memory_skill_versions(owner_id,created_at);

CREATE TABLE memory_skill_evaluations(id text PRIMARY KEY,skill_id text NOT NULL REFERENCES memory_skill_versions(id),owner_id text NOT NULL,kind text NOT NULL,manifest_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

insert into "schema_migrations" ("version") values ('007_memory_learning_v1');

CREATE TABLE memory_exact_operations (
      owner_id text NOT NULL,
      operation_key text NOT NULL CHECK(operation_key ~ '^[a-f0-9]{64}$'),
      payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
      payload_bytes integer NOT NULL CHECK(payload_bytes > 0 AND payload_bytes <= 16000),
      item_id text NOT NULL,
      root_id text NOT NULL,
      item_version integer NOT NULL CHECK(item_version > 0),
      evidence_id text NOT NULL,
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      PRIMARY KEY(owner_id,operation_key),
      UNIQUE(owner_id,item_id)
    );

insert into "schema_migrations" ("version") values ('memory_exact_writes_v1');

CREATE TABLE IF NOT EXISTS learning_content_owners (owner_id text PRIMARY KEY);

CREATE TABLE IF NOT EXISTS learning_content_evaluations (
      id text PRIMARY KEY, owner_id text NOT NULL, subject_kind text NOT NULL CHECK(subject_kind IN ('lesson','knowledge')),
      subject_id text NOT NULL, subject_hash text NOT NULL, status text NOT NULL CHECK(status IN ('running','passed','failed','unknown')),
      report jsonb, created_at timestamptz NOT NULL, completed_at timestamptz
    );

CREATE UNIQUE INDEX IF NOT EXISTS learning_content_one_running_evaluation ON learning_content_evaluations(owner_id,subject_kind,subject_id) WHERE status='running';

CREATE TABLE IF NOT EXISTS learning_lessons (
      id text PRIMARY KEY, owner_id text NOT NULL, root_id text NOT NULL, version integer NOT NULL,
      status text NOT NULL CHECK(status IN ('candidate','verified','active','retired')), text text NOT NULL,
      scope jsonb NOT NULL, content_hash text NOT NULL, sources jsonb NOT NULL, evaluation_id text,
      expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
      UNIQUE(owner_id,root_id,version)
    );

CREATE INDEX IF NOT EXISTS learning_lessons_owner_status ON learning_lessons(owner_id,status);

CREATE TABLE IF NOT EXISTS learning_documents (
      id text PRIMARY KEY, owner_id text NOT NULL, source_key text NOT NULL, source_path text NOT NULL, title text NOT NULL,
      version integer NOT NULL, status text NOT NULL CHECK(status IN ('candidate','verified','active','retired')),
      source_hash text NOT NULL, content_hash text NOT NULL, text text NOT NULL, chunks jsonb NOT NULL,
      evaluation_id text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
      UNIQUE(owner_id,source_key,version)
    );

ALTER TABLE learning_documents ADD COLUMN IF NOT EXISTS extraction_policy text NOT NULL DEFAULT 'utf8-v1';

CREATE INDEX IF NOT EXISTS learning_documents_owner_status ON learning_documents(owner_id,status);

CREATE TABLE skill_families(id text PRIMARY KEY,owner_id text NOT NULL,slug text NOT NULL,active_version_id text,revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(owner_id,slug));

CREATE TABLE skill_versions(id text PRIMARY KEY,family_id text NOT NULL REFERENCES skill_families(id) ON DELETE CASCADE,owner_id text NOT NULL,version text NOT NULL,sequence integer NOT NULL CHECK(sequence>0),revision integer NOT NULL DEFAULT 1,name text NOT NULL,description text NOT NULL,category text NOT NULL,level text NOT NULL CHECK(level IN('instruction','tool','executable')),origin text NOT NULL CHECK(origin IN('builtin','custom','local_import','forge')),status text NOT NULL CHECK(status IN('quarantined','inspected','tested','benchmarked','active','deprecated','revoked','rejected','incompatible','stale')),status_reason text,contract jsonb NOT NULL,content_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(family_id,sequence),UNIQUE(family_id,version),UNIQUE(owner_id,content_hash));

CREATE INDEX skill_versions_owner_idx ON skill_versions(owner_id,status,category,level);

CREATE TABLE skill_files(version_id text NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,path text NOT NULL,kind text NOT NULL CHECK(kind IN('instructions','script','reference','data')),content text NOT NULL,content_hash text NOT NULL,size_bytes integer NOT NULL CHECK(size_bytes>=0),PRIMARY KEY(version_id,path));

CREATE TABLE skill_sources(version_id text PRIMARY KEY REFERENCES skill_versions(id) ON DELETE CASCADE,kind text NOT NULL CHECK(kind IN('builtin','local_folder','forge')),locator text NOT NULL,observed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,file_count integer NOT NULL,total_bytes integer NOT NULL);

CREATE TABLE skill_activations(id text PRIMARY KEY,family_id text NOT NULL REFERENCES skill_families(id) ON DELETE CASCADE,version_id text NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,owner_id text NOT NULL,action text NOT NULL CHECK(action IN('activate','revoke','rollback')),reason text,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE skill_audit(id text PRIMARY KEY,owner_id text NOT NULL,target_id text NOT NULL,event text NOT NULL,detail jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE INDEX skill_audit_target_idx ON skill_audit(owner_id,target_id,created_at DESC);

insert into "schema_migrations" ("version") values ('015_skill_registry');

CREATE TABLE skill_inspections(id text PRIMARY KEY,version_id text NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,owner_id text NOT NULL,content_hash text NOT NULL,inspector_version text NOT NULL,verdict text NOT NULL CHECK(verdict IN('pass','review','fail','incompatible')),findings jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE INDEX skill_inspections_version_idx ON skill_inspections(version_id,created_at DESC);

CREATE TABLE skill_grants(id text PRIMARY KEY,version_id text NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,owner_id text NOT NULL,content_hash text NOT NULL,tools jsonb NOT NULL,scopes jsonb NOT NULL,roots jsonb NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,revoke_reason text,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE INDEX skill_grants_version_idx ON skill_grants(owner_id,version_id,expires_at);

insert into "schema_migrations" ("version") values ('016_skill_security');

CREATE TABLE skill_runs(id text PRIMARY KEY,owner_id text NOT NULL,parent_task_id text NOT NULL UNIQUE REFERENCES tasks(id),input_hash text NOT NULL,plan jsonb NOT NULL,input_values jsonb NOT NULL,pinned_versions jsonb NOT NULL,status text NOT NULL CHECK(status IN('running','waiting_children','succeeded','failed','cancelled','unknown')),result jsonb,error_code text,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,finished_at timestamptz);

CREATE TABLE skill_run_nodes(run_id text NOT NULL REFERENCES skill_runs(id),node_id text NOT NULL,owner_id text NOT NULL,version_id text NOT NULL REFERENCES skill_versions(id),content_hash text NOT NULL,composition_node_id text NOT NULL,step_id text NOT NULL,kind text NOT NULL CHECK(kind IN('tool','model','script')),tool text,contract jsonb NOT NULL,step jsonb NOT NULL,dependencies jsonb NOT NULL,input_bindings jsonb NOT NULL,inputs jsonb,inputs_hash text,output_schema jsonb NOT NULL,outputs jsonb,output_hash text,child_task_id text UNIQUE REFERENCES tasks(id),idempotency_key text NOT NULL,status text NOT NULL CHECK(status IN('pending','queued','running','succeeded','failed','cancelled','unknown')),lease_token text,lease_expires_at timestamptz,attempt integer NOT NULL DEFAULT 0,error_code text,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,started_at timestamptz,finished_at timestamptz,PRIMARY KEY(run_id,node_id));

CREATE INDEX skill_run_nodes_ready_idx ON skill_run_nodes(run_id,status);

CREATE TABLE skill_evidence(id text PRIMARY KEY,owner_id text NOT NULL,run_id text NOT NULL,node_id text NOT NULL,task_id text NOT NULL REFERENCES tasks(id),version_id text NOT NULL,content_hash text NOT NULL,inputs_hash text NOT NULL,lease_token text NOT NULL,node_lease_token text NOT NULL,workflow_token text NOT NULL,status text NOT NULL CHECK(status IN('started','succeeded','failed','unknown')),output jsonb,output_hash text,details jsonb NOT NULL DEFAULT '[]',error_code text,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,finished_at timestamptz,FOREIGN KEY(run_id,node_id) REFERENCES skill_run_nodes(run_id,node_id),UNIQUE(run_id,node_id));

CREATE TABLE skill_preimages(id text PRIMARY KEY,receipt_id text NOT NULL REFERENCES skill_evidence(id),owner_id text NOT NULL,root text NOT NULL,path text NOT NULL,before_text text,before_hash text,after_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(receipt_id,root,path));

CREATE TABLE skill_resource_locks(resource_key text PRIMARY KEY,receipt_id text NOT NULL REFERENCES skill_evidence(id),run_id text NOT NULL,node_id text NOT NULL,owner_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

insert into "schema_migrations" ("version") values ('017_skill_execution');

ALTER TABLE skill_run_nodes ADD COLUMN execution_attempt integer NOT NULL DEFAULT 1 CHECK(execution_attempt BETWEEN 1 AND 3);

ALTER TABLE skill_run_nodes ADD COLUMN retry_not_before timestamptz;

ALTER TABLE skill_run_nodes ADD COLUMN recovery_reason text;

ALTER TABLE skill_evidence ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK(attempt BETWEEN 1 AND 3);

ALTER TABLE skill_evidence DROP CONSTRAINT skill_evidence_run_id_node_id_key;

ALTER TABLE skill_evidence ADD CONSTRAINT skill_evidence_run_node_attempt_key UNIQUE(run_id,node_id,attempt);

CREATE INDEX skill_run_nodes_retry_due_idx ON skill_run_nodes(retry_not_before,run_id) WHERE status='pending' AND retry_not_before IS NOT NULL;

CREATE TABLE skill_circuit_state(id text PRIMARY KEY,owner_id text NOT NULL,version_id text NOT NULL REFERENCES skill_versions(id),content_hash text NOT NULL,target text NOT NULL,status text NOT NULL CHECK(status IN('closed','open','half_open')),failures integer NOT NULL DEFAULT 0,generation integer NOT NULL DEFAULT 1,opened_until timestamptz,probe_token text,probe_until timestamptz,updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE INDEX skill_circuit_owner_idx ON skill_circuit_state(owner_id,version_id);

CREATE TABLE skill_circuit_outcomes(ticket_id text PRIMARY KEY,state_id text NOT NULL REFERENCES skill_circuit_state(id),generation integer NOT NULL,outcome text NOT NULL CHECK(outcome IN('success','transient_failure','neutral','stale')),created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE skill_rollbacks(id text PRIMARY KEY,owner_id text NOT NULL,run_id text NOT NULL REFERENCES skill_runs(id),preimage_id text NOT NULL REFERENCES skill_preimages(id),source_receipt_id text NOT NULL REFERENCES skill_evidence(id),task_id text NOT NULL UNIQUE REFERENCES tasks(id),lease_token text NOT NULL,input_hash text NOT NULL,before_hash text,after_hash text NOT NULL,status text NOT NULL CHECK(status IN('started','succeeded','failed','unknown')),effect_started boolean NOT NULL DEFAULT false,result jsonb,result_hash text,error_code text,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,finished_at timestamptz);

CREATE UNIQUE INDEX skill_rollbacks_preimage_once_idx ON skill_rollbacks(preimage_id) WHERE status IN('started','unknown','succeeded');

ALTER TABLE skill_resource_locks ALTER COLUMN receipt_id DROP NOT NULL;

ALTER TABLE skill_resource_locks ADD COLUMN rollback_id text REFERENCES skill_rollbacks(id);

ALTER TABLE skill_resource_locks ADD CONSTRAINT skill_resource_lock_owner CHECK((receipt_id IS NOT NULL AND rollback_id IS NULL) OR (receipt_id IS NULL AND rollback_id IS NOT NULL));

insert into "schema_migrations" ("version") values ('024_skill_recovery');

CREATE TABLE skill_gaps(id text PRIMARY KEY,owner_id text NOT NULL,chat_run_id text NOT NULL,outcome text NOT NULL CHECK(outcome IN('partial','blocked','failed')),category text CHECK(category IN('missing_skill','missing_tool','missing_permission','model_limitation','invalid_plan','stale_data','environment_failure','sandbox_restriction')),reason text NOT NULL,signal jsonb,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(owner_id,chat_run_id));

CREATE INDEX skill_gaps_owner_idx ON skill_gaps(owner_id,created_at DESC,id);

insert into "schema_migrations" ("version") values ('018_skill_gaps');

CREATE TABLE skill_edges(owner_id text NOT NULL,edge_key text NOT NULL,record_kind text NOT NULL CHECK(record_kind IN('edge','snapshot')),payload jsonb NOT NULL,PRIMARY KEY(owner_id,edge_key));

insert into "schema_migrations" ("version") values ('019_skill_graph');

CREATE TABLE skill_benchmarks(id text PRIMARY KEY,suite_id text NOT NULL,scope text NOT NULL,suite_hash text NOT NULL,config_hash text NOT NULL,verifier_version text NOT NULL,definition jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(suite_hash,config_hash,verifier_version));

CREATE TABLE skill_benchmark_runs(id text PRIMARY KEY,owner_id text NOT NULL,baseline_id text NOT NULL REFERENCES skill_versions(id),candidate_id text NOT NULL REFERENCES skill_versions(id),baseline_pin jsonb NOT NULL,candidate_pin jsonb NOT NULL,benchmark_id text NOT NULL REFERENCES skill_benchmarks(id),suite_hash text NOT NULL,suite_snapshot jsonb NOT NULL,pins_hash text NOT NULL,status text NOT NULL CHECK(status IN('running','completed','failed','unknown')),results jsonb NOT NULL DEFAULT '[]',results_hash text NOT NULL,idempotency_key text NOT NULL,request_hash text NOT NULL,run_token text NOT NULL,lease_expires_at timestamptz NOT NULL,started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,finished_at timestamptz,error_code text,UNIQUE(owner_id,idempotency_key));

CREATE INDEX skill_benchmark_runs_owner_idx ON skill_benchmark_runs(owner_id,started_at DESC,id);

CREATE INDEX skill_benchmark_runs_candidate_idx ON skill_benchmark_runs(owner_id,candidate_id,started_at DESC);

CREATE TABLE skill_quality_snapshots(id text PRIMARY KEY,owner_id text NOT NULL,evaluation_id text NOT NULL REFERENCES skill_benchmark_runs(id),identity_hash text NOT NULL,payload jsonb NOT NULL,payload_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(owner_id,evaluation_id));

insert into "schema_migrations" ("version") values ('020_skill_eval');

CREATE TABLE skill_forge_generations(id text PRIMARY KEY,owner_id text NOT NULL,baseline_id text NOT NULL REFERENCES skill_versions(id),baseline_pin jsonb NOT NULL,mode text NOT NULL CHECK(mode IN('mutate','fork')),target_slug text NOT NULL,target_version text NOT NULL,target_family_id text REFERENCES skill_families(id),candidate_id text UNIQUE REFERENCES skill_versions(id),candidate_content_hash text,status text NOT NULL CHECK(status IN('running','succeeded','failed','unknown')),request_hash text NOT NULL,prompt_hash text NOT NULL,pins_hash text NOT NULL,lineage_hash text,response_hash text,model text,usage jsonb,http_status integer,retry_after_ms bigint,error_code text,failure_analysis jsonb,idempotency_key text NOT NULL,run_token text NOT NULL,call_token text NOT NULL,lease_expires_at timestamptz NOT NULL,started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,finished_at timestamptz,UNIQUE(owner_id,idempotency_key));

CREATE INDEX skill_forge_owner_idx ON skill_forge_generations(owner_id,started_at DESC,id);

insert into "schema_migrations" ("version") values ('021_skill_forge');

ALTER TABLE skill_sources DROP CONSTRAINT skill_sources_kind_check;

ALTER TABLE skill_sources ADD CONSTRAINT skill_sources_kind_check CHECK(kind IN('builtin','local_folder','forge','github'));

CREATE TABLE skill_remote_syncs(id text PRIMARY KEY,owner_id text NOT NULL,repo text NOT NULL,ref text NOT NULL,path text NOT NULL,commit_sha text,cause text NOT NULL CHECK(cause IN('schedule','manual')),status text NOT NULL CHECK(status IN('running','succeeded','failed')),trees jsonb NOT NULL DEFAULT '{}',report jsonb NOT NULL DEFAULT '{}',error_code text,started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,finished_at timestamptz);

CREATE INDEX skill_remote_syncs_owner_idx ON skill_remote_syncs(owner_id,started_at DESC,id);

CREATE UNIQUE INDEX skill_remote_syncs_running_idx ON skill_remote_syncs(owner_id) WHERE status='running';

insert into "schema_migrations" ("version") values ('032_skill_remote');

CREATE TABLE skill_version_tombstones(family_id text NOT NULL REFERENCES skill_families(id) ON DELETE CASCADE,owner_id text NOT NULL,version text NOT NULL,content_hash text NOT NULL,sequence integer NOT NULL,status text NOT NULL,policy text NOT NULL,pruned_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(family_id,version));

insert into "schema_migrations" ("version") values ('033_skill_retention');

CREATE TABLE skill_catalogue(version_id text PRIMARY KEY REFERENCES skill_versions(id) ON DELETE CASCADE,owner_id text NOT NULL,facts jsonb NOT NULL,facts_version text NOT NULL,language text NOT NULL,workflow text NOT NULL,package text NOT NULL,compatibility text NOT NULL CHECK(compatibility IN('compatible','partial','requires_resources','requires_tools','requires_execution')),licence text NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE INDEX skill_catalogue_owner_idx ON skill_catalogue(owner_id,workflow);

CREATE TABLE skill_catalogue_relations(owner_id text NOT NULL,from_slug text NOT NULL,to_slug text NOT NULL,relation text NOT NULL CHECK(relation IN('variant_of','similar')),signal text NOT NULL CHECK(signal IN('declared','review')),score real,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(owner_id,from_slug,to_slug,relation));

CREATE TABLE skill_catalogue_evidence(id text PRIMARY KEY,owner_id text NOT NULL,version_id text NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,content_hash text NOT NULL,kind text NOT NULL CHECK(kind IN('behavioural')),suite text NOT NULL,suite_hash text NOT NULL,passed integer NOT NULL,total integer NOT NULL CHECK(total>0 AND passed>=0 AND passed<=total),detail jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE INDEX skill_catalogue_evidence_version_idx ON skill_catalogue_evidence(version_id,created_at DESC);

CREATE TABLE skill_catalogue_imports(id text PRIMARY KEY,owner_id text NOT NULL,package text NOT NULL,root text NOT NULL,revision text NOT NULL,status text NOT NULL CHECK(status IN('running','succeeded','failed')),progress jsonb NOT NULL DEFAULT '{}',report jsonb NOT NULL DEFAULT '{}',error_code text,claim text,heartbeat_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,finished_at timestamptz);

CREATE UNIQUE INDEX skill_catalogue_imports_running_idx ON skill_catalogue_imports(owner_id,package) WHERE status='running';

CREATE INDEX skill_catalogue_imports_owner_idx ON skill_catalogue_imports(owner_id,started_at DESC,id);

insert into "schema_migrations" ("version") values ('034_skill_catalogue');

CREATE TABLE IF NOT EXISTS sites (
      id text PRIMARY KEY, owner_id text NOT NULL, conversation_id text, slug text NOT NULL,
      brief jsonb NOT NULL, files jsonb NOT NULL, files_hash text NOT NULL, checks jsonb NOT NULL, history jsonb NOT NULL DEFAULT '[]',
      revision integer NOT NULL DEFAULT 1, generator_version text NOT NULL,
      status text NOT NULL CHECK (status IN ('draft', 'ready', 'published', 'failed')),
      published_url text, published_at timestamptz, publish jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());

CREATE INDEX IF NOT EXISTS sites_owner_idx ON sites(owner_id, updated_at);

CREATE TABLE IF NOT EXISTS site_images (
      id text PRIMARY KEY, site_id text NOT NULL REFERENCES sites(id) ON DELETE CASCADE, owner_id text NOT NULL,
      mime_type text NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg')), width integer NOT NULL, height integer NOT NULL,
      data_base64 text NOT NULL CHECK (char_length(data_base64) <= 1400000), small_base64 text, alt text NOT NULL, role text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now());

CREATE INDEX IF NOT EXISTS site_images_site_idx ON site_images(site_id);

insert into "schema_migrations" ("version") values ('030_sites');

CREATE TABLE IF NOT EXISTS ai_provider_settings (
      id text PRIMARY KEY CHECK (id IN ('freellmapi')),
      enabled boolean NOT NULL, models jsonb NOT NULL, automatic_fallback boolean NOT NULL, free_only boolean NOT NULL,
      updated_by text, updated_at timestamptz NOT NULL DEFAULT now()
    );

CREATE TABLE IF NOT EXISTS chrome_extension_bindings (
    owner_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    binding jsonb, connected boolean NOT NULL DEFAULT false, preferred_transport text NOT NULL DEFAULT 'api', last_seen_at timestamptz
  );

CREATE TABLE IF NOT EXISTS chrome_extension_jobs (
    id text PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    idempotency_key text NOT NULL, client_id text NOT NULL, tab_id integer NOT NULL, customer_id text NOT NULL, currency text NOT NULL,
    status text NOT NULL, lease_id text, lease_expires_at timestamptz, campaign jsonb NOT NULL,
    message text NOT NULL, steps jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
    UNIQUE(owner_id,idempotency_key)
  );

ALTER TABLE chrome_extension_jobs ADD COLUMN IF NOT EXISTS source_run_id text;

CREATE INDEX IF NOT EXISTS chrome_extension_source_run ON chrome_extension_jobs(owner_id,source_run_id);

CREATE UNIQUE INDEX IF NOT EXISTS chrome_extension_one_active ON chrome_extension_jobs(owner_id) WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS pdf_documents (
      id text PRIMARY KEY, owner_id text NOT NULL, conversation_id text, name text NOT NULL,
      byte_count integer NOT NULL, content_hash text NOT NULL, pages integer NOT NULL, source text NOT NULL, theme text,
      path text NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

CREATE INDEX IF NOT EXISTS pdf_documents_owner ON pdf_documents(owner_id, conversation_id, created_at DESC);

CREATE TABLE chat_conversations(id text PRIMARY KEY,owner_id text NOT NULL,title text NOT NULL,status text NOT NULL DEFAULT 'idle',active_run_id text,session_id text,question jsonb,approval jsonb,progress text,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());

CREATE INDEX chat_conversations_owner_idx ON chat_conversations(owner_id,updated_at DESC);

CREATE TABLE chat_messages(id text PRIMARY KEY,conversation_id text NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,role text NOT NULL CHECK(role IN ('user','assistant')),text text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());

CREATE INDEX chat_messages_conversation_idx ON chat_messages(conversation_id,created_at,id);

CREATE TABLE chat_runs(id text PRIMARY KEY,conversation_id text NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,owner_id text NOT NULL,status text NOT NULL,goal text NOT NULL,steps integer NOT NULL DEFAULT 0,lease_token text NOT NULL,lease_expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE chat_events(id text PRIMARY KEY,conversation_id text NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,run_id text REFERENCES chat_runs(id),kind text NOT NULL,message text NOT NULL,data jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());

CREATE INDEX chat_events_conversation_idx ON chat_events(conversation_id,created_at DESC);

CREATE TABLE chat_model_receipts(id text PRIMARY KEY,run_id text NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,step integer NOT NULL,model text NOT NULL,status text NOT NULL,input_tokens integer,output_tokens integer,usage_known boolean NOT NULL DEFAULT false,action_valid boolean NOT NULL DEFAULT false,output_hash text,error_code text,started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,UNIQUE(run_id,step));

CREATE TABLE chat_observations(id text PRIMARY KEY,conversation_id text NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,session_id text NOT NULL,data jsonb NOT NULL,content_hash text NOT NULL,screenshot_hash text,created_at timestamptz NOT NULL DEFAULT now());

insert into "schema_migrations" ("version") values ('013_command_chat');

ALTER TABLE chat_conversations ADD COLUMN secure jsonb;

ALTER TABLE chat_conversations ADD COLUMN browser_state jsonb;

ALTER TABLE chat_runs ADD COLUMN state jsonb;

CREATE INDEX chat_runs_conversation_idx ON chat_runs(conversation_id,created_at DESC);

insert into "schema_migrations" ("version") values ('014_assistant');

ALTER TABLE chat_runs ADD COLUMN worker_id text, ADD COLUMN attempt integer NOT NULL DEFAULT 1;

CREATE TABLE chat_effect_receipts(id text PRIMARY KEY,run_id text NOT NULL REFERENCES chat_runs(id),lease_token text NOT NULL,method text NOT NULL,target_hash text NOT NULL,body_hash text NOT NULL,status text NOT NULL CHECK(status IN ('started','responded','unknown')),response_status integer,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz);

CREATE INDEX chat_runs_lease_idx ON chat_runs(status,lease_expires_at);

ALTER TABLE chat_model_receipts DROP CONSTRAINT chat_model_receipts_run_id_step_key, ADD COLUMN lease_token text, ADD COLUMN purpose text NOT NULL DEFAULT 'decision', ADD COLUMN http_status integer, ADD COLUMN retry_after_ms double precision, ADD COLUMN retry_reason text;

insert into "schema_migrations" ("version") values ('022_chat_execution_safety');

ALTER TABLE chat_conversations ADD COLUMN browser_account text, ADD COLUMN browser_checkpoint jsonb;

ALTER TABLE chat_runs ADD COLUMN intent text NOT NULL DEFAULT 'task';

insert into "schema_migrations" ("version") values ('027_chat_browser_recovery');

ALTER TABLE chat_effect_receipts ADD COLUMN owner_reviewed_at timestamptz;

insert into "schema_migrations" ("version") values ('028_chat_recovery_review');

CREATE TABLE chat_images(id text PRIMARY KEY,owner_id text NOT NULL,conversation_id text REFERENCES chat_conversations(id) ON DELETE SET NULL,content_hash text NOT NULL,mime_type text NOT NULL,width integer NOT NULL,height integer NOT NULL,bytes integer NOT NULL,data_base64 text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz);

CREATE INDEX chat_images_owner_idx ON chat_images(owner_id,created_at DESC);

ALTER TABLE chat_messages ADD COLUMN images jsonb;

insert into "schema_migrations" ("version") values ('029_chat_images');

CREATE TABLE chat_request_keys(owner_id text NOT NULL,request_key text NOT NULL,scope text NOT NULL,body_hash text NOT NULL,status text NOT NULL CHECK(status IN ('running','done')),response jsonb,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,request_key));

CREATE INDEX chat_request_keys_created_idx ON chat_request_keys(created_at);

insert into "schema_migrations" ("version") values ('033_chat_request_keys');

CREATE TABLE chat_campaign_events(id text PRIMARY KEY,conversation_id text NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,run_id text NOT NULL,task_id text NOT NULL,seq integer NOT NULL,type text NOT NULL,step_id text,status text NOT NULL,data jsonb NOT NULL,dedup_key text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(task_id,seq),UNIQUE(task_id,dedup_key));

CREATE INDEX chat_campaign_events_conversation_idx ON chat_campaign_events(conversation_id,created_at DESC,seq DESC);

insert into "schema_migrations" ("version") values ('029_chat_campaign_events');

CREATE TABLE IF NOT EXISTS browser_file_grants (
      id text PRIMARY KEY, owner_id text NOT NULL, conversation_id text NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
      direction text NOT NULL, target jsonb NOT NULL, status text NOT NULL,
      filename text, media_type text, bytes_base64 text, content_hash text, byte_count integer,
      inspection text, response_status integer, error_code text,
      expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

CREATE INDEX IF NOT EXISTS browser_file_owner ON browser_file_grants(owner_id,conversation_id,created_at DESC);
