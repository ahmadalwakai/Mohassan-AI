-- Apply once to a dedicated Wasla Neon database before enabling the relay.
-- This table contains encrypted transient transport data, not saved memories.
CREATE TABLE IF NOT EXISTS wasla_relay_jobs (
  id uuid PRIMARY KEY,
  installation_id text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','leased','done')),
  request jsonb NOT NULL,
  response jsonb,
  lease_hash text,
  worker_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS wasla_relay_pending ON wasla_relay_jobs(installation_id,state,created_at);
CREATE INDEX IF NOT EXISTS wasla_relay_expiry ON wasla_relay_jobs(expires_at);
CREATE TABLE IF NOT EXISTS wasla_pair_windows (
  installation_id text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL
);
