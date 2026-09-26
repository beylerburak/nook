# Cloud AI runner — the contract

The classification pass moves from the extension's service worker to
`apps/api`. The extension keeps bookmark capture, toasts and sync; nothing else.

This file is the seam. `apps/api` implements the left column, `apps/extension`
implements the right, and neither may drift from the shapes below without
changing both.

## Why nothing browser-only is needed

The single biggest risk in this move is that classification secretly depends on
something only the browser has. It does not. `toClassifyRequest` reads only
fields that `POST /api/sync` has always carried:

| field | source | on the server? |
| --- | --- | --- |
| `title` | capture | yes |
| `shortDescription` | capture | yes |
| `note` | the user | yes |
| `url` → hostname only | capture | yes |
| `creator.handle` / `creator.name` | X parser | yes |

The page's live DOM is never read for classification. So the server can build
the same request from `nook_records` alone, and nothing has to be re-sent at
save time. (The `propose-taxonomy` flow is the same: it samples the *library*,
not pages.)

## New routes

All four are session-guarded exactly like their siblings in `server.ts`, and
none of them is reachable without `auth.api.getSession`.

### `GET /api/ai/status`

One read for the whole Settings → AI status surface, so the panel does not have
to stitch three endpoints together and render a half-updated state.

```ts
interface AiStatusResponse {
  /** Whether this server can classify at all: TYPESAFE_API_KEY is present. */
  available: boolean;
  /** Toggles and thresholds, same shape as GET /api/ai/settings. */
  settings: AiUserSettings;
  /** Jobs waiting to be classified. */
  pending: number;
  /** The accepted taxonomy currently in force. */
  taxonomy: AcceptedTaxonomy;
  run: AiRunSummary;
}

interface AiRunSummary {
  processed: number;
  assigned: number;
  tagged: number;
  skipped: number;
  /** ISO of the last pass that got past the cooldowns, or null. */
  lastRunAt: string | null;
  lastError: string | null;
  /** True while the no-AI-key cooldown is still in effect. */
  isUnavailable: boolean;
  /** True while a rate-limit / network backoff is still in effect. */
  isBackingOff: boolean;
  /** Last 200 decisions, newest last, for the confidence histogram. */
  log: AiLogEntry[];
}

interface AiLogEntry {
  id: string;
  /** The `Choice` confidence for the collection decision; 0 when the body was unreadable. */
  confidence: number;
  assigned: boolean;
  at: string;
}
```

### `POST /api/ai/run`

Enqueues the account's eligible bookmarks and wakes the worker. It does **not**
run a pass inline: 25 classify calls take tens of seconds, which is not
something to hold an HTTP request open for. The panel re-reads
`GET /api/ai/status` and renders the queue draining.

```ts
// request body: ignored (an empty object is fine)
// -> 200
interface RunResponse {
  /** How many bookmarks this call added to the queue. */
  queued: number;
  /** The status as of right after the enqueue. */
  status: AiStatusResponse;
}
```

### `POST /api/ai/taxonomy/propose`

Replaces the extension's `requestProposals()`. The server samples *its own*
library, so the client sends no sample at all.

```ts
// request body: { language?: TaxonomyLanguage }  (omitted means "auto")
// -> 200, or 503 when NOOK_AI_PROPOSER / its key is unset
interface ProposeTaxonomyResponse {
  /** How many bookmarks the proposal was drawn from. */
  sampleSize: number;
  collections: Array<{ name: string; why: string }>;
  tags: Array<{
    name: string;
    why?: string;
    /**
     * Names of the collections in THIS response whose vocabulary already covers
     * the tag. The client uses it to untick the tag by default and to re-tick it
     * when the matching collection is unticked — the review list stays live
     * without the client owning the stem comparison.
     */
    coveredBy: string[];
  }>;
  /** Collection names the account already has, so the client can show them. */
  existingCollections: string[];
}
```

### `PUT /api/ai/taxonomy`

Turns the names the user kept into real `BookmarkList` records plus the accepted
taxonomy, inside one transaction. The extension used to do this in IndexedDB and
let sync carry the lists; now the server owns both writes, so a half-finished
acceptance is not possible.

```ts
// -> 200
interface AcceptTaxonomyResponse {
  createdCollections: number;
  addedTags: number;
  /** Names dropped because a collection already had them. */
  dropped: number;
  /** The taxonomy now in force. */
  taxonomy: AcceptedTaxonomy;
}
```

The request carries **names only** — the sample, the existing lists and the
library's tags are read from `nook_records` at acceptance time, which is
strictly more correct than the client re-sending a snapshot it may have read
before a concurrent change. There is exactly one exception, and it is not
optional:

```ts
interface AcceptTaxonomyRequest {
  collections: string[];
  /** A tag's definition has to travel with its name. */
  tags: Array<{ name: string; definition?: string }>;
}
```

A member-less tag is offered to the model as a bare name, and its definition is
the only evidence it has. The server cannot reconstruct it — the proposer wrote
it and the review list is the last place it exists — so the client sends it
back. `docs/ai.md` measures what dropping it costs: definitions put **12 of 12**
vocabulary entries to use against **10 of 12** for bare names, at 24% more
input tokens. `definition` is optional so a proposer that returned no `why`
still yields a usable tag.

```ts
interface AcceptedTaxonomy {
  /** ISO of the last acceptance, or null when there has never been one. */
  acceptedAt: string | null;
  collections: Array<{ id: string; name: string; samples: string[] }>;
  /** Accepted tag names nothing carries yet, each with its definition. */
  tags: Array<{ name: string; definition?: string }>;
}
```

## New tables

All four are `IF NOT EXISTS` in `schema.sql`, which re-runs on every container
start, so they must stay idempotent.

```sql
-- The accepted taxonomy. Was the extension's per-origin IndexedDB meta key
-- "ai.taxonomy", which is why a taxonomy accepted on the web could never reach
-- the extension's runner.
CREATE TABLE IF NOT EXISTS nook_ai_taxonomy (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Run history: counters, processed ids, cooldown windows, the decision log.
-- Was "ai.cursor" + "ai.log" in the same per-origin meta store.
CREATE TABLE IF NOT EXISTS nook_ai_state (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- A lease, so two api replicas cannot run a pass for one account at once.
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The queue. One row per bookmark awaiting a decision.
CREATE TABLE IF NOT EXISTS nook_ai_jobs (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bookmark_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bookmark_id)
);
CREATE INDEX IF NOT EXISTS nook_ai_jobs_user_idx ON nook_ai_jobs (user_id);

-- The durable "we already bought a decision for this". NOT in the original plan,
-- and not optional: see below.
CREATE TABLE IF NOT EXISTS nook_ai_decided (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bookmark_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bookmark_id)
);
```

**`nook_ai_decided` is the one addition this contract originally missed, and it
exists because of money.** The extension kept this list in an IndexedDB `meta`
key capped at 2000 ids, and `docs/ai.md` documented the consequence: past the cap
the oldest ids are dropped, and because candidates are taken newest-first they
come back only once everything newer is resolved — so the re-billing that leaks
through is the smallest, oldest tail, not the freshest saves.

A bookmark the model answered "nothing fit" for has **no field on the record**
saying so, so that list was the only memory of the answer, and that is why the
cap could not be lifted. It leaks money permanently: on a library past 2000
undecided ids, every one of the oldest is re-bought forever, because nothing ever
changes to make it stop. Moving server-side makes the fix free — a row costs
about 60 bytes and there is no cap.

It is deliberately **not** a field on `nook_records`. Writing one would bump the
record's version, push a no-op change through `/api/sync` to every device, and
resurface the bookmark in the dashboard as freshly edited — the exact harm the
capped cursor existed to avoid.

The queue row **is** the claim: a pass deletes the rows it takes
(`DELETE ... RETURNING`). A crash between that and the write leaves the bookmark
still eligible, still absent from the processed-id cursor, and therefore
re-enqueued by the next top-up — so no `done` state is needed and no work is
lost. The reason is the same as `nook_embeddings`: rows may lag the
authoritative data, and the reconciliation pass is the backstop.

## The write path, and the sync conflict it has to survive

This is the part docs/ai.md called "işin en hassas kısmı". A decision is written
by the server, on a record a client may be editing at the same instant.

`applyClassificationPatch` does, in one transaction:

1. `SELECT pg_advisory_xact_lock(hashtext($1))` — **the same lock
   `syncRecords` takes**, so a write can never interleave with a sync's
   read-check-write for the same account.
2. `SELECT data, deleted_at FROM nook_records ... FOR UPDATE`.
3. Bail if the row is gone or tombstoned.
4. **Re-check eligibility on the fresh row**: `ai == null && listId == null`. A
   human who filed the bookmark while the request was in flight wins; the model
   is never asked about it twice and never overwrites them.
5. Recompute the patch against the *fresh* row, not the candidate read at the
   start of the pass. Tags are a union, so a tag the user added in the meantime
   must survive.
6. Write only when the patch changes something. Every write stamps
   `data->>'updatedAt'` and takes `nextval('nook_sync_version_seq')`, which is
   what makes the change reach every device through the ordinary sync pull and
   what makes `mergeBookmarks`'s newer-wins resolve in the server's favour.

Because the patch only ever contains `listId`, `listName`, `tags` and `ai`, and
step 5 recomputes the union, the merge rules in `cloud-merge.ts` are already the
right ones: tags union, `listId`/`listName`/`ai` taken as a unit from the same
side. Nothing in the merge layer changes.

## What the extension loses

Deleted outright:

- `lib/ai-runner.ts` — the queue, the cursor, the cooldowns, the batch loop.
- `lib/ai-classify.ts` — ported to `apps/api/src/ai-classify.ts`, where it is
  pure and where the data it reads already lives.
- `lib/ai-taxonomy.ts` — ported to `apps/api/src/ai-taxonomy.ts`; the review
  list's stem comparison becomes the `coveredBy` field on each tag proposal.
- The `nook-ai-classify-periodic` / `nook-ai-classify-soon` alarms, the
  `CLASSIFY_NOW` message, and every call site in the service worker.
- `SummaryCard`'s read of `ai.summary-run`, which was a seam nothing ever wrote.
  The summarisation toggle stays a toggle; wiring it is a separate job and is
  explicitly out of scope here.

Kept: `lib/ai-settings.ts` (already account-wide), the settings panel (rewritten
against the routes above, and now identical on both hosts), and
`AiAttribution` on `Bookmark` — it is a synced field, and the server writes it.
