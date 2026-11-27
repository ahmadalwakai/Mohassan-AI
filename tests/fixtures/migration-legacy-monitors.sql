-- Additions captured from createApplication at 6e68bda booting the c2a0ff7 schema.

-- Source retrieved 2026-11-27: https://github.com/ahmadalwakai/Mohassan-AI/tree/6e68bdac9e23e34636d80f8612f8c9295752c580

-- Only new DDL, ledger rows and the migration seed row are included.

CREATE TABLE IF NOT EXISTS chat_conversations (
    id text PRIMARY KEY,
    owner_id text NOT NULL,
    title text NOT NULL,
    status text NOT NULL DEFAULT 'idle',
    active_run_id text,
    session_id text,
    question jsonb,
    approval jsonb,
    progress text,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS review_summary jsonb;

insert into "schema_migrations" ("version") values ('035_chat_conversation_review');

CREATE TABLE notification_preferences (
    user_id text PRIMARY KEY,
    quiet_start text,
    quiet_end text,
    time_zone text,
    hide_title boolean NOT NULL DEFAULT false,
    CHECK (num_nonnulls(quiet_start, quiet_end, time_zone) IN (0, 3))
  );

CREATE TABLE push_subscriptions (
    id text PRIMARY KEY,
    user_id text NOT NULL,
    endpoint text NOT NULL UNIQUE,
    p256dh text NOT NULL,
    auth text NOT NULL,
    label text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_success_at timestamptz,
    failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0)
  );

CREATE INDEX push_subscriptions_user_idx ON push_subscriptions(user_id, created_at);

CREATE TABLE notification_tabs (
    user_id text NOT NULL,
    tab_id text NOT NULL,
    visible boolean NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, tab_id)
  );

CREATE TABLE chat_notifications (
    task_id text PRIMARY KEY,
    user_id text NOT NULL,
    conversation_id text,
    kind text NOT NULL CHECK (kind IN ('task_completed', 'needs_you', 'task_failed', 'reminder_due')),
    started_at timestamptz NOT NULL,
    happened_at timestamptz NOT NULL,
    available_at timestamptz NOT NULL,
    delivery text NOT NULL CHECK (delivery IN ('pending', 'tab', 'push', 'suppressed')),
    CHECK (conversation_id IS NOT NULL OR (kind = 'task_completed' AND delivery = 'push'))
  );

CREATE INDEX chat_notifications_pending_idx ON chat_notifications(user_id, available_at) WHERE delivery = 'pending';

CREATE INDEX chat_notifications_test_expiry_idx ON chat_notifications(happened_at) WHERE conversation_id IS NULL;

insert into "schema_migrations" ("version") values ('037_notifications');

CREATE TABLE memory_structured_versions (
      item_id text PRIMARY KEY REFERENCES memory_items(id) ON DELETE CASCADE,
      owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      conversation_id text NOT NULL,
      subject text NOT NULL,
      property text NOT NULL,
      value text NOT NULL,
      valid_since text,
      valid_until text
    );

CREATE INDEX memory_structured_target_idx ON memory_structured_versions(owner_id,subject,property);

CREATE INDEX memory_structured_conversation_idx ON memory_structured_versions(owner_id,conversation_id);

CREATE TABLE memory_structured_operations (
      owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      run_id text NOT NULL,
      conversation_id text NOT NULL,
      intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
      outcome text NOT NULL CHECK(outcome IN ('saved','unchanged','forgotten','missing','ambiguous')),
      item_id text REFERENCES memory_items(id) ON DELETE SET NULL,
      PRIMARY KEY(owner_id,run_id)
    );

insert into "schema_migrations" ("version") values ('036_structured_memory');

CREATE UNIQUE INDEX chat_conversations_id_owner_idx ON chat_conversations(id, owner_id);

CREATE TABLE reminders (
    id uuid PRIMARY KEY,
    user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    conversation_id text NOT NULL,
    text text NOT NULL,
    due_at timestamptz NOT NULL,
    time_zone text NOT NULL,
    recurrence jsonb,
    status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'cancelled', 'failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    delivery_key uuid NOT NULL UNIQUE,
    FOREIGN KEY (conversation_id, user_id) REFERENCES chat_conversations(id, owner_id) ON DELETE CASCADE
  );

CREATE INDEX reminders_user_scheduled_idx ON reminders(user_id, due_at, id) WHERE status = 'scheduled';

CREATE INDEX reminders_due_idx ON reminders(due_at, id) WHERE status = 'scheduled';

CREATE INDEX reminders_conversation_idx ON reminders(conversation_id, user_id);

CREATE TABLE reminder_deliveries (
    delivery_key uuid PRIMARY KEY,
    reminder_id uuid NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    conversation_id text NOT NULL,
    text text NOT NULL,
    due_at timestamptz NOT NULL,
    time_zone text NOT NULL,
    delivered_at timestamptz NOT NULL,
    late boolean NOT NULL
  );

CREATE INDEX reminder_deliveries_reminder_idx ON reminder_deliveries(reminder_id);

CREATE INDEX reminder_deliveries_user_idx ON reminder_deliveries(user_id, delivered_at DESC, delivery_key DESC);

CREATE TABLE reminder_preferences (
    user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    time_zone text NOT NULL
  );

insert into "schema_migrations" ("version") values ('038_reminders');

ALTER TABLE chat_messages ADD COLUMN run_id text REFERENCES chat_runs(id) ON DELETE SET NULL;

CREATE TABLE conversation_shares (
    id text PRIMARY KEY, sharer_id text NOT NULL, conversation_id text NOT NULL,
    token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'), snapshot jsonb NOT NULL,
    shared_at timestamptz NOT NULL, expires_at timestamptz, revoked_at timestamptz
  );

CREATE INDEX conversation_shares_sharer_idx ON conversation_shares(sharer_id, shared_at DESC, id DESC)
    WHERE revoked_at IS NULL;

CREATE TABLE conversation_share_settings (
    id integer PRIMARY KEY CHECK (id = 1), member_sharing_enabled boolean NOT NULL
  );

insert into "conversation_share_settings" ("id", "member_sharing_enabled") values (1, true);

insert into "schema_migrations" ("version") values ('039_conversation_shares');

CREATE TABLE member_deletion_requests (
      user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
      requested_at timestamptz NOT NULL,
      purge_after timestamptz NOT NULL CHECK (purge_after > requested_at),
      started_at timestamptz
    );

CREATE INDEX member_deletion_due_idx ON member_deletion_requests (purge_after, user_id);

CREATE TABLE member_data_exports (
      user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
      requested_at timestamptz NOT NULL
    );

CREATE TABLE workspace_member_audit (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      actor_id text,
      target_id text NOT NULL,
      action text NOT NULL CHECK (action IN ('invite_created', 'invite_used', 'invite_revoked', 'member_suspended', 'member_unsuspended', 'deletion_requested', 'deletion_cancelled', 'deletion_purged', 'export_downloaded')),
      occurred_at timestamptz NOT NULL DEFAULT now()
    );

CREATE FUNCTION reject_workspace_member_audit_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Member audit is append only'; END; $$;

CREATE TRIGGER workspace_member_audit_append_only
      BEFORE UPDATE OR DELETE OR TRUNCATE ON workspace_member_audit
      FOR EACH STATEMENT EXECUTE FUNCTION reject_workspace_member_audit_mutation();

CREATE FUNCTION guard_member_deletion_session_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        -- Serialize session creation with scheduling and starting the purge.
        PERFORM 1 FROM "user" WHERE id = NEW."userId" FOR KEY SHARE;
        IF EXISTS (SELECT 1 FROM member_deletion_requests AS d
          JOIN workspace_members AS m ON m.user_id = d.user_id AND m.role = 'member'
          WHERE d.user_id = NEW."userId" AND (started_at IS NOT NULL OR purge_after <= clock_timestamp())
          AND NOT EXISTS (SELECT 1 FROM workspace_owner WHERE owner_id = NEW."userId")) THEN
          RAISE EXCEPTION 'Member account deletion is due' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END; $$;

CREATE TRIGGER guard_member_deletion_session_insert BEFORE INSERT ON session
      FOR EACH ROW EXECUTE FUNCTION guard_member_deletion_session_insert();

CREATE FUNCTION audit_workspace_invite() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        INSERT INTO workspace_member_audit (actor_id, target_id, action)
          VALUES (NEW.created_by, NEW.id, 'invite_created');
      ELSE
        IF OLD.consumed_by IS NULL AND NEW.consumed_by IS NOT NULL THEN
          INSERT INTO workspace_member_audit (actor_id, target_id, action)
            VALUES (NEW.consumed_by, NEW.id, 'invite_used');
        END IF;
        IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
          INSERT INTO workspace_member_audit (actor_id, target_id, action)
            VALUES (NULLIF(current_setting('mohassan.member_audit_actor', true), ''), NEW.id, 'invite_revoked');
        END IF;
      END IF;
      RETURN NEW;
    END;
  $$;

CREATE TRIGGER workspace_invites_audit AFTER INSERT OR UPDATE OF consumed_by, revoked_at
    ON workspace_invites FOR EACH ROW EXECUTE FUNCTION audit_workspace_invite();

CREATE FUNCTION audit_workspace_member_access() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO workspace_member_audit (actor_id, target_id, action)
        VALUES (NULLIF(current_setting('mohassan.member_audit_actor', true), ''), NEW.user_id,
          CASE WHEN NEW.disabled_at IS NULL THEN 'member_unsuspended' ELSE 'member_suspended' END);
      RETURN NEW;
    END;
  $$;

CREATE TRIGGER workspace_members_access_audit AFTER UPDATE OF disabled_at ON workspace_members
    FOR EACH ROW WHEN (NEW.role = 'member' AND (OLD.disabled_at IS NULL) <> (NEW.disabled_at IS NULL))
    EXECUTE FUNCTION audit_workspace_member_access();

insert into "schema_migrations" ("version") values ('040_member_data_rights');

CREATE UNIQUE INDEX chat_long_runs_active_owner ON chat_runs(owner_id)
      WHERE worker_id = 'response-policy-long-run-v1' AND status IN ('running', 'waiting_approval', 'waiting_input');

CREATE INDEX chat_long_runs_due ON chat_runs(((state->'longRun'->>'dueAt')::bigint))
      WHERE worker_id = 'response-policy-long-run-v1' AND status IN ('running', 'waiting_approval', 'waiting_input');

ALTER TABLE chat_notifications DROP CONSTRAINT chat_notifications_kind_check,
      ADD CONSTRAINT chat_notifications_kind_check
      CHECK (kind IN ('task_completed', 'needs_you', 'task_failed', 'reminder_due', 'task_progress'));

insert into "schema_migrations" ("version") values ('041_long_run_checkpoints');

CREATE TABLE ios_push_devices (
      registration_id uuid PRIMARY KEY,
      user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      registration_generation uuid NOT NULL,
      token text NOT NULL,
      environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
      app_version text NOT NULL,
      registered_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (environment, token)
    );

CREATE INDEX ios_push_devices_user_idx ON ios_push_devices(user_id);

ALTER TABLE notification_preferences
      ADD COLUMN completion_sound boolean NOT NULL DEFAULT true,
      ADD COLUMN show_result_preview boolean NOT NULL DEFAULT false;

ALTER TABLE chat_notifications
      ADD COLUMN background_outcome text CHECK (background_outcome IN ('completed', 'approval', 'sign-in', 'payment', 'failed')),
      ADD COLUMN background_language text CHECK (background_language IN ('ar', 'en')),
      ADD COLUMN run_id text REFERENCES chat_runs(id) ON DELETE CASCADE,
      ADD COLUMN result_preview text,
      ADD COLUMN tab_claim_id uuid,
      ADD COLUMN tab_claim_until timestamptz,
      ADD COLUMN web_push_after timestamptz,
      ADD COLUMN web_push_device_id text,
      ADD COLUMN web_push_attempts integer NOT NULL DEFAULT 0 CHECK (web_push_attempts >= 0);

CREATE TABLE background_apns_deliveries (
      event_id text NOT NULL REFERENCES chat_notifications(task_id) ON DELETE CASCADE,
      registration_id uuid NOT NULL REFERENCES ios_push_devices(registration_id) ON DELETE CASCADE,
      next_at timestamptz NOT NULL,
      delivered_at timestamptz,
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      PRIMARY KEY (event_id, registration_id)
    );

CREATE INDEX background_apns_deliveries_due_idx ON background_apns_deliveries(next_at)
      WHERE delivered_at IS NULL;

CREATE INDEX background_apns_deliveries_device_idx ON background_apns_deliveries(registration_id);

insert into "schema_migrations" ("version") values ('042_background_results');

CREATE TABLE smart_monitors (
      id uuid PRIMARY KEY,
      user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      conversation_id text NOT NULL,
      spec jsonb NOT NULL,
      spec_key text NOT NULL,
      status text NOT NULL CHECK (status IN ('proposed', 'active', 'paused', 'stopped', 'completed', 'expired')),
      offer text CHECK (offer IN ('explicit', 'implicit', 'agent-initiated')),
      note text,
      evaluation jsonb,
      source_cache jsonb,
      last_checked_at timestamptz,
      next_check_at timestamptz,
      interval_ms integer NOT NULL CHECK (interval_ms > 0),
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL,
      approved_at timestamptz,
      lease_token uuid,
      lease_until timestamptz,
      checks integer NOT NULL DEFAULT 0 CHECK (checks >= 0),
      notifications integer NOT NULL DEFAULT 0 CHECK (notifications >= 0),
      failure_kind text CHECK (failure_kind IN ('missing', 'unreachable')),
      consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
      pending_notice jsonb,
      notice_due_at timestamptz,
      FOREIGN KEY (conversation_id, user_id) REFERENCES chat_conversations(id, owner_id) ON DELETE CASCADE,
      CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
      CHECK ((pending_notice IS NULL) = (notice_due_at IS NULL))
    );

CREATE INDEX smart_monitors_account_idx ON smart_monitors(user_id, created_at DESC, id);

CREATE INDEX smart_monitors_conversation_idx ON smart_monitors(conversation_id, user_id);

CREATE INDEX smart_monitors_due_idx ON smart_monitors(next_check_at, id) WHERE status = 'active';

CREATE INDEX smart_monitors_expiry_idx ON smart_monitors(expires_at, id) WHERE status IN ('proposed', 'active', 'paused');

CREATE INDEX smart_monitors_notice_idx ON smart_monitors(notice_due_at, id) WHERE pending_notice IS NOT NULL;

CREATE TABLE smart_monitor_budgets (
      user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
      budget_day date NOT NULL,
      checks integer NOT NULL DEFAULT 0 CHECK (checks >= 0),
      previews integer NOT NULL DEFAULT 0 CHECK (previews >= 0),
      notifications integer NOT NULL DEFAULT 0 CHECK (notifications >= 0)
    );

CREATE TABLE smart_monitor_hosts (
      host_key text PRIMARY KEY,
      eligible_at timestamptz NOT NULL
    );

CREATE INDEX smart_monitor_hosts_expiry_idx ON smart_monitor_hosts(eligible_at);

ALTER TABLE chat_notifications ADD COLUMN monitor_id uuid REFERENCES smart_monitors(id) ON DELETE CASCADE;

CREATE INDEX chat_notifications_monitor_idx ON chat_notifications(monitor_id) WHERE monitor_id IS NOT NULL;

insert into "schema_migrations" ("version") values ('043_smart_monitors');

ALTER TABLE smart_monitors ADD COLUMN v2_state jsonb, ADD COLUMN v2_digest_due_at timestamptz;

CREATE INDEX smart_monitors_v2_digest_idx ON smart_monitors(v2_digest_due_at, id)
      WHERE v2_digest_due_at IS NOT NULL;

insert into "schema_migrations" ("version") values ('044_smart_monitors_v2');

CREATE TABLE IF NOT EXISTS smart_monitor_v2_preferences (
    user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    proactive_offers boolean NOT NULL
  );

CREATE TABLE IF NOT EXISTS smart_monitor_v2_offers (
    user_id text NOT NULL,
    conversation_id text NOT NULL,
    topic_key text NOT NULL,
    PRIMARY KEY (user_id, conversation_id, topic_key),
    FOREIGN KEY (conversation_id, user_id) REFERENCES chat_conversations(id, owner_id) ON DELETE CASCADE
  );

CREATE TABLE IF NOT EXISTS smart_monitor_v2_actions (
    id uuid PRIMARY KEY,
    user_id text NOT NULL,
    conversation_id text NOT NULL,
    operation jsonb NOT NULL,
    expires_at timestamptz NOT NULL,
    resolved boolean NOT NULL DEFAULT false,
    FOREIGN KEY (conversation_id, user_id) REFERENCES chat_conversations(id, owner_id) ON DELETE CASCADE
  );

CREATE INDEX IF NOT EXISTS smart_monitor_v2_actions_conversation_idx
    ON smart_monitor_v2_actions(user_id, conversation_id);

insert into "schema_migrations" ("version") values ('045_smart_monitor_conversation_controls');

ALTER TABLE smart_monitor_v2_preferences ADD COLUMN decision_recording boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX smart_monitors_id_user_idx ON smart_monitors(id, user_id);

CREATE TABLE smart_monitor_decisions (
    user_id text NOT NULL,
    monitor_id uuid NOT NULL,
    event_key text NOT NULL,
    decision text NOT NULL CHECK (decision IN ('proposal', 'approved', 'declined', 'stopped_early', 'alert_helpful', 'alert_unhelpful')),
    features jsonb,
    happened_at timestamptz NOT NULL,
    PRIMARY KEY (monitor_id, event_key),
    FOREIGN KEY (monitor_id, user_id) REFERENCES smart_monitors(id, user_id) ON DELETE CASCADE,
    CHECK ((decision = 'proposal') = (event_key = 'proposal')),
    CHECK ((decision = 'proposal') = (features IS NOT NULL))
  );

CREATE INDEX smart_monitor_decisions_user_idx ON smart_monitor_decisions(user_id, happened_at);

insert into "schema_migrations" ("version") values ('046_smart_monitor_decisions');

-- Standalone feedback migration applied to this schema.
-- Source retrieved 2026-11-27: https://github.com/ahmadalwakai/Mohassan-AI/blob/05beb0be90916522bfbaf545084996fff0e6472f/apps/server/src/monitors-phase1/feedback-migration.ts

CREATE TABLE monitor_alert_feedback (
      user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      alert_id text NOT NULL REFERENCES chat_notifications(task_id) ON DELETE CASCADE,
      rating text NOT NULL CHECK (rating IN ('helpful', 'not_helpful')),
      reason text CHECK (reason IN ('no_meaningful_change', 'late', 'wrong_value')),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, alert_id),
      CHECK (reason IS NULL OR rating = 'not_helpful')
    );

CREATE INDEX monitor_alert_feedback_alert_idx ON monitor_alert_feedback(alert_id);

insert into "schema_migrations" ("version") values ('044_monitor_alert_feedback');
