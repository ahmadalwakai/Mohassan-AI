-- Schema and ledger statements captured by running the legacy migrations on the c2a0ff7 schema.

-- Source retrieved 2026-11-27: https://github.com/ahmadalwakai/Mohassan-AI/blob/c3c6e12e42884cabe46768803f0ec5aaa6f4e3d6/apps/server/src/assistant/structured-memory-migration.ts

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

insert into "schema_migrations" ("version") values ('035_structured_memory');

-- Source retrieved 2026-11-27: https://github.com/ahmadalwakai/Mohassan-AI/blob/1f779065049a03a223df005ab072d4dc2f5bc9ca/packages/database/src/notifications-migration.ts

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
    kind text NOT NULL CHECK (kind IN ('task_completed', 'needs_you', 'task_failed')),
    started_at timestamptz NOT NULL,
    happened_at timestamptz NOT NULL,
    available_at timestamptz NOT NULL,
    delivery text NOT NULL CHECK (delivery IN ('pending', 'tab', 'push', 'suppressed')),
    CHECK (conversation_id IS NOT NULL OR (kind = 'task_completed' AND delivery = 'push'))
  );

CREATE INDEX chat_notifications_pending_idx ON chat_notifications(user_id, available_at) WHERE delivery = 'pending';

CREATE INDEX chat_notifications_test_expiry_idx ON chat_notifications(happened_at) WHERE conversation_id IS NULL;

insert into "schema_migrations" ("version") values ('035_notifications');

-- Source retrieved 2026-11-27: https://github.com/ahmadalwakai/Mohassan-AI/blob/b40244b12d6649429832b6f42f09f391f9485732/apps/server/src/reminders/migration.ts

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

insert into "schema_migrations" ("version") values ('036_reminders');

-- Source retrieved 2026-11-27: https://github.com/ahmadalwakai/Mohassan-AI/blob/9a4d03579b08fee3505bea96636ceecdab9e783f/apps/server/src/conversation-share-migration.ts

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

insert into "schema_migrations" ("version") values ('038_conversation_shares');

-- Source retrieved 2026-11-27: https://github.com/ahmadalwakai/Mohassan-AI/blob/ec708808a61140f39ee1694602e863d7797a6a09/apps/server/src/member-data-migration.ts

-- Audit triggers: https://github.com/ahmadalwakai/Mohassan-AI/blob/ec708808a61140f39ee1694602e863d7797a6a09/apps/server/src/member-audit.ts

-- Audit actions: https://github.com/ahmadalwakai/Mohassan-AI/blob/ec708808a61140f39ee1694602e863d7797a6a09/packages/contracts/src/member-data-rights.ts

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

insert into "schema_migrations" ("version") values ('037_member_data_rights');
