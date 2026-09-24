CREATE SEQUENCE IF NOT EXISTS nook_sync_version_seq;

CREATE TABLE IF NOT EXISTS nook_records (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('bookmark', 'list')),
  id text NOT NULL,
  data jsonb NOT NULL,
  deleted_at timestamptz,
  version bigint NOT NULL DEFAULT nextval('nook_sync_version_seq'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, id)
);

CREATE INDEX IF NOT EXISTS nook_records_user_version_idx
  ON nook_records (user_id, version);

-- Opaque sync epoch. Clients send back the epoch they last saw; a mismatch means
-- the server data was replaced (e.g. restored from backup) and the client must
-- resync from scratch instead of trusting its stored cursor. Runs on every
-- container start, so the INSERT must stay idempotent.
CREATE TABLE IF NOT EXISTS nook_sync_meta (
  key text PRIMARY KEY,
  value text NOT NULL
);

INSERT INTO nook_sync_meta (key, value)
VALUES ('epoch', gen_random_uuid()::text)
ON CONFLICT (key) DO NOTHING;
