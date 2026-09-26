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

-- AI feature toggles and thresholds (docs/ai.md, "Settings surface"). Account-wide
-- on purpose: the classification pass is a server call either way, so the
-- setting that gates it belongs to the account, not to one browser's local
-- storage — a toggle flipped in the web app must be the same toggle the
-- extension's runner reads, and vice versa.
--
-- One row per user, no version column and no conflict handling: this is a
-- small preferences blob, not a record with concurrent writers to merge, so
-- last-write-wins is the whole story. `saveAiUserSettingsPatch` (apps/api/src/
-- ai-settings.ts) upserts with a jsonb `||` merge in a single statement rather
-- than a read-modify-write, which is what makes that true even under a race
-- between two tabs saving at once.
CREATE TABLE IF NOT EXISTS nook_ai_settings (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The accepted taxonomy (docs/ai.md, "Taxonomy growth"): the collection options
-- the classifier is offered, each with the member titles that back it, plus the
-- tag vocabulary that nothing carries yet. Was the extension's per-origin
-- IndexedDB meta key "ai.taxonomy", which is exactly why a taxonomy accepted on
-- the web could never reach the runner that needed it. Written only by
-- PUT /api/ai/taxonomy, read by the worker on every pass.
--
-- No version column, same reason as nook_ai_settings: one row, one writer per
-- acceptance, and the merge discipline lives in code (toAcceptedTaxonomy keeps
-- earlier batches rather than replacing them) rather than in a conflict rule.
CREATE TABLE IF NOT EXISTS nook_ai_taxonomy (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Run history for the classification pass: counters, the last run, the cooldown
-- windows and the decision log. Was "ai.cursor" + "ai.log" in the same
-- per-origin meta store, which is why the web host could show neither.
--
-- `lease_until` and `summary_lease_until` are the only columns here that are not
-- inside `data`, and deliberately so: they are locks, and a lock read-modify-
-- written through jsonb is a lock two replicas can both take. They guard against
-- two api processes running a pass for one account - the one thing the extension's
-- single service worker got for free. The claim in nook_ai_jobs is what actually
-- prevents double-billing; the lease only stops two passes from loading and
-- rebuilding the same library (see acquireRunLease in apps/api/src/ai-store.ts).
--
-- TWO leases, not one, and the reason is starvation rather than correctness. A
-- classification pass holds its lease for as long as its batch takes, and at a
-- 60-second tick a shared lease would have the two passes locking each other out
-- in turn for the whole life of the account. They write different fields, and the
-- advisory lock `applyServerWrite` takes already serialises the writes that could
-- genuinely conflict, so there is nothing here for one shared lease to protect.
CREATE TABLE IF NOT EXISTS nook_ai_state (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- A lease, so two api replicas cannot run a classification pass for one account
  -- at once.
  lease_until timestamptz,
  -- The same lease for the summarisation pass, held separately. See above.
  summary_lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Added rather than folded into the CREATE above, because schema.sql re-runs on
-- every container start and a deployment upgrading from the previous image
-- already has this table. ADD COLUMN IF NOT EXISTS is what makes that re-run safe:
-- without the IF NOT EXISTS the whole file aborts on the second start.
ALTER TABLE nook_ai_state ADD COLUMN IF NOT EXISTS summary_lease_until timestamptz;

-- The queue. One row per bookmark awaiting a decision, enqueued by the sync hook
-- and topped up by the worker, and DELETED by the pass that takes it.
--
-- The row IS the claim, which is why there is no `done` state, no per-job lease
-- and no attempt counter: a crash between the claim and the write leaves the
-- bookmark still eligible, still absent from nook_ai_decided, and therefore
-- re-enqueued by the next top-up. The same argument embeddings.ts makes about
-- letting its in-process queue drop work.
CREATE TABLE IF NOT EXISTS nook_ai_jobs (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bookmark_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bookmark_id)
);

-- Serves every read of this table: the account's queue depth for the status
-- route, and the DELETE ... LIMIT that claims a batch, both of which are
-- "one account's rows, oldest first".
CREATE INDEX IF NOT EXISTS nook_ai_jobs_user_idx ON nook_ai_jobs (user_id);

-- Every id this account has already bought a decision for, including the
-- decisions that filed nothing.
--
-- This table is not in docs/ai-cloud-contract.md and is here to fix a bug the
-- contract inherited. A bookmark the model answered "nothing fit" for has no
-- field on the record saying so - applyClassification returns null and the pass
-- writes nothing at all - so the only memory of the answer was the extension's
-- processed-id list, and that list was capped at 2,000 ids. Past the cap the
-- oldest ids were dropped, and because candidates are taken newest-first those
-- came back only once everything newer was resolved: so on a library of a few
-- thousand undecided bookmarks, every one of the oldest was re-bought forever,
-- continuously, because nothing about them ever changed. It leaked money.
--
-- Server-side the cap is not needed, so the memory is unbounded and durable, at
-- roughly 60 bytes a row. It is deliberately NOT a field on nook_records:
-- writing one would stamp updatedAt and take nextval('nook_sync_version_seq'),
-- which is a version bump and a no-op change pushed through /api/sync to every
-- device, resurfacing the bookmark in the dashboard as freshly edited. That is
-- the exact harm the extension's capped-cursor dance existed to avoid, and it
-- would happen 2,000 times instead of once. Nothing here is synced, and nothing
-- here is a fact about the bookmark.
--
-- Rows whose bookmark is gone (or tombstoned) are dead weight and are pruned by
-- pruneDecided on the reconciler's cadence, not on every tick.
CREATE TABLE IF NOT EXISTS nook_ai_decided (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bookmark_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bookmark_id)
);

-- Serves the top-up, which is the only query that reads it, and that asks for
-- exactly this shape: one account's live bookmarks, newest first. The expression
-- is the same one selectCandidates sorts by (savedAt, then createdAt, then
-- updatedAt) and the same one the ORDER BY uses, so the index and the query
-- cannot disagree about which end of the library is "newest". The partial
-- predicate keeps tombstones out of it entirely, since a deleted bookmark is
-- never a candidate and never should cost a slot in the index.
CREATE INDEX IF NOT EXISTS nook_records_ai_candidates_idx
  ON nook_records (user_id, kind, (COALESCE(data->>'savedAt', data->>'createdAt', data->>'updatedAt')) DESC NULLS LAST)
  WHERE deleted_at IS NULL;

-- The review list (docs/ai.md, "Review list"): one row per bookmark whose
-- classification landed "low-confidence" but still had a known top choice.
-- `decideClassification` (apps/api/src/ai.ts) used to compute that choice and
-- throw it away outright - the bookmark stayed unfiled and the guess went
-- nowhere, even though production data showed roughly as many bookmarks fall
-- just short of the filing threshold as clear it. This table is where the
-- guess is kept instead, and GET /api/ai/review / POST /api/ai/review/resolve
-- (apps/api/src/ai-jobs.ts) are the only things that read or write it.
--
-- One row per bookmark: a bookmark is only ever offered its single most
-- recent guess, which is why this is a PRIMARY KEY rather than a log, and why
-- `upsertReviewGuesses` in ai-jobs.ts is an upsert rather than an insert. It is
-- deliberately NOT a field on nook_records, for the exact reason
-- nook_ai_decided is not one: writing there would stamp updatedAt and bump the
-- sync version for a guess the model is not confident in and a human has not
-- acted on yet, resurfacing the bookmark on every device as freshly edited.
--
-- Unlike nook_ai_decided, this table is not permanent bookkeeping the account
-- keeps forever - it is live working state that is only ever pruned lazily, by
-- the read that is about to show it to a human (readReviewList), rather than
-- on the reconciler's schedule: a stale row here costs nothing sitting
-- unread, and the moment someone opens the review list is the cheapest
-- possible moment to notice one has gone stale (bookmark filed some other
-- way, bookmark deleted, or its guessed collection itself deleted).
CREATE TABLE IF NOT EXISTS nook_ai_review (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bookmark_id text NOT NULL,
  list_id text NOT NULL,
  confidence real NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bookmark_id)
);

-- Serves both reads in ai-jobs.ts / ai-store.ts: one account's rows, ordered
-- (or filtered) by confidence. There is no separate index for the lazy-prune
-- DELETE in readReviewList - it deletes by (user_id, bookmark_id), which the
-- primary key already serves.
CREATE INDEX IF NOT EXISTS nook_ai_review_user_confidence_idx
  ON nook_ai_review (user_id, confidence DESC);

-- Every bookmark summarisation has been *attempted* on and did not produce a
-- summary: the model declined, or the call could not be made. One row per
-- bookmark, and a written summary DELETEs its row.
--
-- This is deliberately NOT a permanent "already tried" marker like
-- nook_ai_decided, because the two features need opposite things from memory. A
-- classification decision is bought at most once ever, so "we already paid for
-- this" has to be permanent or the account is re-billed forever. A summary is
-- allowed to be cleared by the user, so a marker that outlived the summary would
-- mean it could never be written again - the user clears it and it does not come
-- back. Deleting the row on a write is what keeps `null` and `""` meaning "no
-- summary, so summarise it again", which is what the field's own comment in
-- apps/extension/lib/types.ts says they mean.
CREATE TABLE IF NOT EXISTS nook_ai_summaries (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bookmark_id text NOT NULL,
  -- sha256 over the prompt's own text: title, description and note. NEVER over
  -- `summary`, and that exclusion is the mechanism rather than a detail. If the
  -- hash covered the record, every write would look like a change in the source
  -- and the memory below would never suppress anything; covering only the text
  -- makes it answer exactly one question, which is "have we already asked about
  -- this?". So editing a note makes the record a candidate again - right, because
  -- the summary on it is now of something else - while writing a summary onto it
  -- never does. (docs/ai-summarize-contract.md, "The deletion problem".)
  content_hash text NOT NULL,
  -- When the attempt that produced this row happened. This is the only clock the
  -- retry window is measured from, which is why the row is inserted on the
  -- OUTCOME rather than when the work was noticed: a row written at top-up time
  -- would measure the window from when we looked rather than from when we asked.
  at timestamptz NOT NULL DEFAULT now(),
  -- Which of the two windows applies, and the row cannot be read without it:
  -- `declined` is the model's opinion of this exact text and gets the long window
  -- (default 7 days), `failed` is a transport error and gets the short one
  -- (default 30 minutes). Without this column the two are the same row and one of
  -- the two windows has to be wrong - a park after a network blip lasting a week.
  outcome text NOT NULL DEFAULT 'declined' CHECK (outcome IN ('declined', 'failed')),
  PRIMARY KEY (user_id, bookmark_id)
);

-- The one shape both read queries ask for: "this account's attempts that are
-- still inside their retry window". Leading with `user_id` scopes the whole table
-- to one account and `at` bounds it by the window, so the exclusion in the
-- candidate query is an index-only range scan rather than a scan of every attempt
-- this account has ever made.
CREATE INDEX IF NOT EXISTS nook_ai_summaries_user_at_idx
  ON nook_ai_summaries (user_id, at);

-- The summarisation top-up's work list, which is a read rather than an insert
-- (there is no queue: a candidate is a candidate at any moment). Same ORDER BY as
-- nook_records_ai_candidates_idx and the same newest-first reasoning - a user who
-- saves forty long articles and presses "Run now" should get those, not a
-- two-year-old backlog - but a NARROWER predicate, and that is the point: it
-- excludes the records that already carry a summary, so the index shrinks as the
-- feature runs instead of holding the whole library forever.
--
-- The predicate deliberately stops short of the 400-character length gate, even
-- though the query filters on it. A predicate that could change would have to be
-- dropped and rebuilt to take effect, and `CREATE INDEX IF NOT EXISTS` never
-- rebuilds an index that already exists - so a later change to the gate would
-- silently leave the old predicate behind and the records it excluded would be
-- unreachable. As a filter it is merely work the planner rejects, and the next
-- deployment takes effect immediately.
--
-- Verified against Postgres 17 with EXPLAIN (ANALYZE, BUFFERS) rather than
-- assumed: on both a measured 1,061-record library (0.20ms) and a 60,000-record
-- one (0.14ms) the plan is a single ordered Index Scan on this index that stops
-- after 25 rows, with no Sort node. The classification index does not serve this
-- query, because its predicate admits every live bookmark and this one needs the
-- summarised ones gone.
CREATE INDEX IF NOT EXISTS nook_records_ai_summary_candidates_idx
  ON nook_records (user_id, (COALESCE(data->>'savedAt', data->>'createdAt', data->>'updatedAt')) DESC NULLS LAST)
  WHERE deleted_at IS NULL
    AND kind = 'bookmark'
    AND coalesce(btrim(data->>'summary'), '') = '';
