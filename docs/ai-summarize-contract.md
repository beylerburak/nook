# Cloud summarisation pass — the contract

The classification runner moved to `apps/api` (see `docs/ai-cloud-contract.md`).
This is the same job for the second dead feature: `autoSummarize` is a real field
of the account's settings row, it renders as a switch in Settings → AI on both
hosts, and **nothing has ever acted on it**. `POST /api/summarize` has no caller
in either host; the panel's `ai.summary-run` cursor was a documented seam nothing
wrote; and the migration that just landed deleted the panel's local-library
counting rather than reword it. So the switch saves a preference and changes
nothing about the user's library.

Follows the same shape as the classification pass: a server-side queue, a
per-minute tick, a conflict-safe write, and an account-wide status read.

## What changes in the writing model, and why

`apps/api/src/summarize.ts` currently ends with a long comment arguing that the
server **must not** write a summary. Three of its four reasons were correct when
it was written and no longer are, and the fourth never applied. Say so plainly
rather than deleting the argument:

- *"A summary is user-visible prose, not derived data like a vector. The client
  owns it: it shows it, the user can delete or re-run it, and signing out has to
  take it with everything else on that device."* — Signing out is still the
  user's: a summary is a synced field, so signing out on a device does not take
  it off the server or off the other devices, and it never did for a note. The
  other two claims survive: the user can still delete it, and that is why the
  work-list rule below is built so a deletion sticks.
- *"Going through `POST /api/sync` is what puts the summary on every device. A
  server-side write would have to invent a second push path."* — There is no
  second push path. There is exactly the same one the classification write uses:
  bump the version, let the ordinary pull carry it. Invented nothing.
- *"A write here would move the record's version, and every other device would
  pull a change it never made."* — True, and identical to what a classification
  write already does, on purpose, for the same reason: the pass runs where the
  library is.
- *"...and it would also break the merge rule this field exists to get:
  newer-wins on `summary` itself, which only runs if the client is the author."*
  — This one was already wrong. `summary` is top-level and not in
  `BOOKMARK_SPECIAL_KEYS`, so `mergeBookmarks` gives it a generic newer-wins
  whichever side authored it. The server is simply the newest side.

The rule that made the old design coherent — the client owns the write, so the
device that asked holds the record the merge is computed over — no longer holds,
because the device that asks no longer runs the pass.

## The deletion problem, and the work-list rule that solves it

The one thing that genuinely does need care: **a summary must stay deletable.**

`apps/extension/lib/types.ts` documents the current semantics — *"`null` and
`""` both mean 'no summary', so a cleared one is summarised again rather than
merged as a permanent blank."* That is a deliberate design decision and this
migration must not quietly invert it. A user who deletes a summary has said "I
don't want this", and a pass that puts it back an hour later is a bug that looks
like a haunting.

So the work list may **not** be "every record with no summary", and it may not use
a permanent "already tried" marker the way `nook_ai_decided` does for
classification — that would make a summary undeletable, which is worse than
re-billing it.

The rule that satisfies both, and which is a direct application of the
`planEmbeddingWork` discipline already in `apps/api/src/embeddings.ts`:

> A live bookmark is a candidate when it has no summary, its `description` clears
> the existing length gate, and either **nothing has ever been attempted on this
> exact text** or **the last attempt was long enough ago to be worth repeating**.

"Exact text" is a content hash over `title`, `description` and `note` — the
three fields the prompt actually reads, and deliberately **not** `summary`. That
exclusion is the whole mechanism: deleting a summary does not change the source
hash, so it is not a candidate, so the delete sticks. Editing your note *does*
change the hash, so it is a candidate again, which is right — you changed what
you saved and the summary is now of something else.

### `nook_ai_summaries`

```sql
CREATE TABLE IF NOT EXISTS nook_ai_summaries (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bookmark_id text NOT NULL,
  -- sha256 over title + description + note. Never over `summary`.
  content_hash text NOT NULL,
  -- When the attempt that produced this row happened, which is what the retry
  -- window is measured from.
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bookmark_id)
);
```

One row per bookmark that was **attempted and did not produce a summary**.

- **A summary was written → delete the row.** The bookmark is done. This is what
  makes a deletion work: the memory is gone, so clearing the summary makes the
  record a candidate again, which is the documented behaviour.
- **The model declined (`empty-output`) → upsert the row.** The text has been
  read and the model had nothing to say about it. Asking again in a minute gets
  the same answer, so this gets the long window: `NOOK_AI_SUMMARY_DECLINE_MS`,
  default 7 days.
- **The call failed (`failed`, a transport or upstream error) → upsert the row.**
  Short window, `NOOK_AI_SUMMARY_RETRY_MS`, default 30 minutes, because a timeout
  is transient and this is not the model's opinion of the text.
- **A content change → the hash differs → candidate**, and the stale row is
  overwritten. No explicit invalidation pass is needed.
- Prune rows whose bookmark is gone or tombstoned, on the periodic reconcile, the
  same as `pruneDecided`.

`MIN_SUMMARISABLE_CHARS`, `isWorthSummarising`, `summarySkipReason` and
`planSummaries` are the existing, tested gates and are reused unchanged. Do not
re-derive the 400-character rule.

## The write path, generalised

`applyClassificationPatch` in `apps/api/src/ai-jobs.ts` currently owns the
conflict rules, and they are right. Rather than write a second copy for
summaries, extract the mechanism and let both be callers:

```ts
export interface ServerWrite {
  /** Decided against the freshly-read row. False means "leave it alone". */
  guard(record: ClassifiableBookmark): boolean;
  /** The patch, computed from the fresh row. null means "nothing to write". */
  build(record: ClassifiableBookmark): Partial<ClassifiableBookmark> | null;
}

export async function applyServerWrite(
  pool: Pool,
  userId: string,
  kind: RecordKind,
  id: string,
  nowIso: string,
  write: ServerWrite,
): Promise<{ wrote: boolean; patch: Record<string, unknown> | null; reason?: "gone" | "guarded" | "no-change" }>;
```

One transaction, in this order, unchanged from the version the classification
pass already ships and is verified against:

1. `BEGIN`, then `SELECT pg_advisory_xact_lock(hashtext($1))` — the same lock
   `syncRecords` takes. A summary write and a classification write for the same
   account therefore serialise against each other and against sync.
2. `SELECT data, deleted_at FROM nook_records ... FOR UPDATE`.
3. `gone` if there is no row or it is tombstoned.
4. `guard(fresh)` → `guarded` if false.
5. `build(fresh)` → `no-change` if null or if `patchChangesSomething` is false.
6. `UPDATE ... data = {...fresh, ...patch, updatedAt: nowIso}, version =
   nextval('nook_sync_version_seq'), updated_at = now()`.

Note the guard for summaries is evaluated against the **fresh** row too: a user
who deleted the summary, or who deleted the bookmark, between the top-up query
and the write wins. `summary` is not in `BOOKMARK_SPECIAL_KEYS`, so
`mergeBookmarks`'s generic newer-wins is the right rule for it and nothing in
`cloud-merge.ts` changes.

The classification caller keeps its current behaviour exactly — its guard is
`bookmarkNeedsClassification` and its build is `withTaxonomyAt(applyClassification(...))`,
recomputed from the fresh row. Port every comment about *why* the re-check and
the recompute exist; they are the reason this is safe and they are now load-bearing
for two features instead of one.

## Leases

`nook_ai_state.lease_until` currently guards classification. **Add a second
column**, `summary_lease_until`, and acquire it the same way.

One lease for both would couple them: a classification pass holds the lease for
as long as its batch takes, a summarisation pass would then be locked out behind
it, and at a 60-second tick the two would starve each other for the lease. They
touch different fields, and the advisory lock already serialises the writes that
could actually conflict, so there is nothing for a shared lease to protect.

```sql
ALTER TABLE nook_ai_state ADD COLUMN IF NOT EXISTS summary_lease_until timestamptz;
```

`acquireRunLease` / `releaseRunLease` take the column name as a parameter rather
than being duplicated. `nook_ai_state.data` gains a `summarize` sub-record beside
the classification counters, for the same reason: one row per account, and
`unavailableUntil` / `backoffUntil` mean the same thing for both passes (a
missing `NOOK_AI_PROPOSER` key, and an upstream that is throttling).

## Routes

### `POST /api/ai/run` — extended

One "do a pass now" action for both features, because the work is the same shape
and two buttons would be two nearly identical controls. Each half is gated on its
own toggle, so a user with only one of them on gets only that one.

```ts
// request body: ignored
// -> 200
interface RunResponse {
  /** Classification jobs this call added. */
  queued: number;
  /** Summarisation candidates this call added. */
  summariesQueued: number;
  status: AiStatusResponse;
}
```

### `GET /api/ai/status` — extended

```ts
interface AiStatusResponse {
  available: boolean;          // classification: TYPESAFE_API_KEY
  settings: AiUserSettings;
  pending: number;             // classification jobs
  taxonomy: AcceptedTaxonomy;
  run: AiRunSummary;           // classification, unchanged
  summarize: SummarizeStatus;  // new, additive
}

interface SummarizeStatus {
  /** Whether a summariser is configured: NOOK_AI_PROPOSER plus its key. */
  available: boolean;
  /** The model a call would use, defaults included. */
  model: string;
  /** Candidates waiting to be summarised. */
  pending: number;
  /** Live records carrying a non-empty summary. */
  summarised: number;
  written: number;
  skipped: number;
  lastRunAt: string | null;
  lastError: string | null;
  isUnavailable: boolean;
  isBackingOff: boolean;
}
```

`summarised` and `pending` are SQL counts over `nook_records`, so they are the
honest numbers. This replaces the panel's old local count, which could only
produce an *upper bound* — it counted every record with no summary, including the
ones the 400-character gate would never accept, and had to say so in the copy. The
server can apply the same gate in the query, so the bound is no longer needed.

### `POST /api/summarize` — removed

Its documented contract is *"The server does not write `summary` anywhere, and
that is the design"*, and after this change that is false. A route that computes
summaries and silently discards them is a trap for the next reader, and there is
no caller in either host to preserve. Delete the route, `parseSummarizeRequest`
and `MAX_IDS_ACCEPTED`'s route framing; `summarizeRecords` stays and is what the
worker calls.

`MAX_IDS_ACCEPTED` becomes the worker's per-pass cap rather than a route's, which
is the same number for the same reason — one pass is one window of work, not a
library.

## The tick

`tickAiWorker` gains a summarisation half, after the classification one:

- `topUpSummaryQueue(pool, userId, limit)` — the candidate query below.
- `runSummarizationPass(pool, userId, deps)`.
- On the 15-minute reconcile, `pruneSummaries` alongside `pruneDecided`.

The candidate query, one statement, gated on the toggle so `pending` can never
report a queue that cannot drain (the same reason the classification top-up
carries the guard):

```sql
INSERT INTO nook_ai_summaries (user_id, bookmark_id, content_hash, at)
SELECT $1, r.id, <hash>, now() FROM ...
```

Actually — do **not** insert the row at top-up time. Insert on *outcome*, so the
`at` that the retry window is measured from is when the attempt happened rather
than when the work was noticed. Top-up only *reads*:

```sql
SELECT r.id, r.data
FROM nook_records r
LEFT JOIN nook_ai_summaries s ON s.user_id = r.user_id AND s.bookmark_id = r.id
WHERE r.user_id = $1
  AND r.kind = 'bookmark'
  AND r.deleted_at IS NULL
  AND coalesce(btrim(r.data->>'summary'), '') = ''
  AND length(coalesce(r.data->>'description', '')) > 400
  AND (s.bookmark_id IS NULL
       OR s.content_hash <> <hash>
       OR s.at < now() - <window for that row's outcome>)
  AND EXISTS (SELECT 1 FROM nook_ai_settings st
              WHERE st.user_id = $1 AND coalesce((st.data->>'autoSummarize')::boolean, false))
  AND nook_ai_state.summary_lease_until IS NULL OR <that is the top-up's own guard>
ORDER BY ...
LIMIT $2
```

The `length(...) > 400` in SQL must agree with `MIN_SUMMARISABLE_CHARS` in
`summarize.ts`. Two ways to keep them from drifting: export the constant and
parameterise the query, or keep the length filter in JS and note that the SQL
filter is an index-friendly pre-filter. Prefer the second — `planSummaries` runs
over the batch anyway and is the authority, so the SQL filter is an optimisation
and a wrong one there costs a pass, not a wrong answer. Say that in a comment.

Add whatever expression index the `ORDER BY` needs, alongside
`nook_records_ai_candidates_idx`, and verify the planner uses it against a real
Postgres rather than assuming.

## Cost, and the privacy surface — both of which are new

This is the first feature in the product that sends **page text** to a
third-party model. Taxonomy sends titles and hostnames. Classification sends
titles, a 300-character preview, notes and hostnames. A summary sends up to
4,000 characters of `description` plus the title and the note. That is a
materially larger surface and the settings copy has to say so in the toggle's own
description, not in a doc.

At `gpt-4o-mini` ($0.15/1M in, $0.60/1M out) a call is roughly 1,000–1,300 input
tokens and about 100 output: **≈$0.00026 per bookmark**. Put that number in
`docs/ai.md` next to the classification figure of $0.000062, and be explicit that
it is ~4× a classification call, is bounded by the library rather than by the
tick, and that a full pass over 5,000 bookmarks with a third of them eligible is
about $0.43. The batch is the same 25-per-tick shape as classification
(`NOOK_AI_SUMMARY_BATCH`, default 25) at `SUMMARY_CONCURRENCY` 4.

**Do not invent a spend cap.** Embeddings and classification have none, and a cap
introduced for one feature and not the others is a worse surprise than the bill
it prevents. The batch size and the decline memory are the controls; the
documented per-bookmark cost is the rest.

## What the extension changes

`AiPanel.tsx` gets the status rows back, from the server instead of from
`NookDB`:

- The toggle stays, with **new copy** that says the page text is sent to the
  configured provider and that the toggle acts on its own, with the browser
  closed.
- "In your library" returns `summarised` and `pending`. Real numbers, not an
  upper bound, so the "some of them never will" hedge goes away.
- "Last summary pass" returns `lastRunAt` and `lastError`.
- "Classify now" becomes "Run now", because `POST /api/ai/run` now covers both
  passes. The toast reports both queue depths and must not claim either pass
  happened — same honesty rule the classification rewrite already established.
- The status card gains a row for summarisation, or the existing row grows a
  second line. Use the same `StatusDot` vocabulary; do not invent a fifth state.

`lib/types.ts`'s `summary` field comment says *"The server reads records and
returns summaries but never writes this field (apps/api/src/summarize.ts)"*. That
is now false and is the most misleading sentence in the extension. Rewrite it,
and keep the two sentences that are still true and load-bearing: the field is
top-level rather than inside `ai` (because `ai` is merged as a unit), and it takes
a generic newer-wins merge. Add the deletion semantics as they now actually are.

## Out of scope

- The taxonomy proposer and the summariser share `NOOK_AI_PROPOSER` and
  `NOOK_AI_MODEL`. Giving them separate configuration is a real question and a
  separate change; note it, do not do it.
- `NOOK_SUMMARY_MODEL` already exists as a per-feature override for the
  summariser. It keeps working; do not fold it into `NOOK_AI_MODEL`.
- Summarising a specific bookmark on demand (a "Summarise this" action in the
  dashboard). `POST /api/ai/run` covers the whole pass and nothing needs a
  per-bookmark entry point today.
