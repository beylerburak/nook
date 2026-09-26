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

-- Embeddings are DERIVED data: the bookmark is authoritative in nook_records.data
-- and a vector can be recomputed from it at any time. So this is a separate table
-- rather than a field on the sync carrier, which would replicate 6.5 MB of
-- recomputable data to every device on every change (docs/retrieval.md, "Storage").
--
-- `model`, `dim` and `content_hash` sit beside every vector on purpose. They are
-- what makes a model or dimension change a background re-embed instead of a
-- migration: queries filter on `model`, so rows written by the previous model are
-- simply invisible, and their absence is the work list (see reconcileIndex in
-- apps/api/src/embeddings.ts).
--
-- There is deliberately no foreign key to nook_records. This table is allowed to
-- lag the authoritative data - that is what the reconciliation pass is for - and
-- a cascade would delete vectors the moment a record was tombstoned, before the
-- row that explains why it is gone.
CREATE TABLE IF NOT EXISTS nook_embeddings (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  model text NOT NULL,
  bookmark_id text NOT NULL,
  dim integer NOT NULL,
  content_hash text NOT NULL,
  -- Already case- and accent-folded, so ILIKE is accent-insensitive. Turkish
  -- agglutination defeats a plain tsvector on this library, and this is written
  -- in JS where the folding already exists (see foldCase in the extension).
  search_text text NOT NULL,
  vector real[] NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, model, bookmark_id)
);

-- Serves every read: one user's rows for one model, which is also exactly the
-- set a search reads (docs/retrieval.md, "one model per index").
CREATE INDEX IF NOT EXISTS nook_embeddings_user_model_idx
  ON nook_embeddings (user_id, model);
