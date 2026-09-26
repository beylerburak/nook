# AI classification

Nook classifies saved bookmarks into your existing collections and tags using
[TypeSafe AI](https://typesafe.ai)'s **Jev** model. Two independent features, both
toggled in Settings → AI.

| Feature | What it does |
| --- | --- |
| **File into collections** | Every new bookmark is placed into one of your existing collections, or left alone. |
| **Grow the taxonomy** | Suggests brand-new collection names and a tag vocabulary from your library, then files into those. |

Both are off by default. Classification is a background pass on Nook's server;
it never blocks saving a bookmark, and it keeps going with the browser closed.

## How the pieces fit

The pass used to run in the extension's MV3 service worker. It runs in `apps/api`
now, and no decision changed on the way over: the model, the calibration, the
thresholds and every measurement below are exactly what they were. What is new is
the machinery around them — a durable queue, a durable memory of what has already
been paid for, and a server-side writer that has to survive a concurrent sync.
`docs/ai-cloud-contract.md` is the seam.

```
apps/api  — the feature
  src/ai-jobs.ts      the pass: enqueue, claim, batch, write, the tick, and the
                      server half of the taxonomy routes
  src/ai-summary.ts   the summarisation pass: the work list, the attempt
                      memory, the batch, the writes — the same tick, on the
                      same lease table, through the same write path
  src/ai-classify.ts  PURE: build the request, apply a decision, build the patch
  src/ai-taxonomy.ts  PURE: sampling, proposals, the accepted-taxonomy record,
                      planning the BookmarkList rows
  src/cluster-math.ts PURE: k-means over cosine-normalized embeddings, merging,
                      the membership floor, matching an existing collection
  src/ai-clusters.ts  "Suggestions from clusters": reads the embeddings, the
                      one per-cluster naming call, the accept write path
  src/ai-store.ts     the account rows: run state + decision log for BOTH passes,
                      the accepted taxonomy, the leases, readAiStatus
  src/ai.ts           the Jev call and the proposer calls, the thresholds, the
                      pure decision helpers
  src/ai-settings.ts  the settings row: normalize, validate a PATCH, upsert
  src/server.ts       the routes, session-guarded
  src/sync.ts         enqueueClassification, beside enqueueIndexing

  the routes, all session-guarded:
        GET  /api/ai/settings           toggles + thresholds, one account row
        PUT  /api/ai/settings
        POST /api/ai/classify           one bookmark -> one decision
        POST /api/ai/propose-taxonomy   a library sample -> new taxonomy
        --- the four the pass moved in on ---
        GET  /api/ai/status             availability, settings, queue depth,
                                         accepted taxonomy, run history, and
                                         the summarisation half of all of it
        POST /api/ai/run                queue the account's eligible
                                         bookmarks and wake the worker;
                                         returns both queue depths
        POST /api/ai/taxonomy/propose   the server samples its own library
        PUT  /api/ai/taxonomy           accept reviewed names: create the
                                         lists, store the taxonomy
        --- the inverted flow — see "Suggestions from clusters" ---
        POST /api/ai/clusters/propose   cluster the unfiled library, name
                                         only what isn't already a match
        PUT  /api/ai/clusters/accept    file every member instantly, no
                                         per-bookmark classify call
        --- kept guesses the pass used to throw away — see "Review list" ---
        GET  /api/ai/review             low-confidence guesses still worth a
                                         human's yes/no
        POST /api/ai/review/resolve     accept (files it) or reject each one

  the tables, all one row per account unless noted:
        nook_ai_jobs      the classification queue
        nook_ai_state     run history for BOTH passes, and two lease columns
        nook_ai_taxonomy  the accepted taxonomy
        nook_ai_decided   every id a decision has been bought for
        nook_ai_review    kept low-confidence guesses, one row per bookmark
        nook_ai_summaries every id a summary has been *attempted* on and got
                          nothing — see "The job queue"
```

Summarisation is the second pass through this machinery, and it is shared rather
than parallel on purpose. `nook_ai_state` holds both run records — the
classification counters and a `summarize` sub-record beside them, because
`unavailableUntil` and `backoffUntil` mean the same two things for both passes.
The per-minute tick drives both, classification first and summarisation after it,
sequentially so the instantaneous rate against one proposer stays bounded.
`applyServerWrite` guards both writes, on the same advisory lock a sync takes.
And there are **two lease columns**, `lease_until` and `summary_lease_until`,
because one shared lease at a 60-second tick would have the two passes starving
each other for it — they write different fields, and the advisory lock already
serialises the writes that could actually conflict.

The extension's remaining jobs are bookmark capture, toasts, and sync with the
server. **Classification is not one of them** — there is no runner, no alarm, no
cursor and no `chrome.*` call anywhere in the feature, and the service worker no
longer knows it exists. What it has is `lib/ai-client.ts`: four authenticated
HTTP calls, in the same shape as its sibling `lib/ai-settings.ts`, and a panel
that is the same component on both hosts. Summarisation is the same now, which it
was not a release ago: it has its own pass file on the server and no code in the
extension at all.

The four new routes, in one line each:

| route | what it is for |
| --- | --- |
| `GET /api/ai/status` | one read for the whole status surface, so the panel cannot render a state stitched from three endpoints |
| `POST /api/ai/run` | "Run now": top both queues up and wake the worker, reporting each depth separately. It does **not** run a pass inline — 25 calls take tens of seconds, which is not something to hold an HTTP request open for |
| `POST /api/ai/taxonomy/propose` | propose collections and tags. The server samples its own library, so the client sends no sample at all |
| `PUT /api/ai/taxonomy` | accept the names that were kept: real `BookmarkList` records *and* the accepted taxonomy, in one transaction |

`ai-classify.ts` and `ai-taxonomy.ts` are still pure — free of `fetch`, of `pg`
and of a clock they do not inject — and now that they are the only two files in
the graph that decide what lands on a real user's record, that is the property
worth keeping rather than the reason it was originally drawn. Not one decision
changed on the way over: the fields `toClassifyRequest` reads are exactly the
ones `POST /api/sync` has always carried, so the server builds the same request
out of `nook_records` with nothing re-sent at save time.

A decision is written to `nook_records` and reaches every device through the
ordinary sync pull, and a summary is written through the same transaction and
travels the same way. See "The write path" below for why that is the delicate
part and "Merge semantics" for why it needed no new merge rule.

## The model

Jev is **not an LLM**. It does not generate text. You send a `state` plus typed
questions (`Choice`, `Score`, `Noul`) and get typed answers back with calibrated
probabilities and a `confidence` value.

That matters here: `Choice` options are keys **we** define, so the model can
only ever pick from a closed set we hand it. It can never invent a category
name. That is why the taxonomy feature needs a second, generative model, and
why filing into existing collections is a perfect fit for Jev.

**Cost:** `$42` per billion input tokens, output free. Measured on the real
service, a classification request is **1,466 input tokens** — about `$0.000062`.
5,000 bookmarks is roughly **$0.31**, once. Around 400 tokens of every request is
fixed overhead that no trimming removes. Realistic total is **under $1/year**.

> These figures are measured, not estimated. The first draft of this document
> claimed 800 tokens and `$0.17`; both were 4.3× optimistic because the request
> carried a per-tag sample digest that has since been removed. See
> [ai-calibration.md](./ai-calibration.md).

Rate limits: 250,000 tokens/second, 1,200 requests/minute. 64k context, of which
32k for `state` plus the longest single question. **In practice no rate-limit
headers are returned at all**, even on responses that exceeded the published
token ceiling by 2.6×, so nothing here may depend on reading one.

## How classification works

State is **filtered** — Jev loses accuracy on state full of material the
question does not need:

```json
{ "item": { "title", "summary", "note", "site", "author" } }
```

`summary` is the truncated `shortDescription`. The full `description` is never
sent. Bookmarks whose state carries **less than 40 characters** of text skip the
request entirely: media-only bookmarks reduce to a bare emoji or an author
handle, and 39 of a real 1,061-bookmark library fall under that line. The floor
is a per-bookmark cost guard, and where it is applied matters a great deal more
than it looks — see the 2026-09-27 entry in "Progress notes" for how the
extension's runner got this wrong.

Then, in **one** request:

- `collection` — a `Choice` over your collections, plus a `__none__` option.
  Each option's criteria carries the collection's *actual member titles*, not
  just its name. This is what lets one call suffice, and it is measured: dropping
  the digest costs 8.7 points of top-1.
- `tag::<name>` — one `Noul` per existing tag (top 20 by frequency), asking
  whether the item belongs under it. **These carry no digest** — see below.

The `Choice` settles *which* collection; the `Noul`s settle whether to say
anything at all. That split is deliberate, and it is not symmetric:

> **A `Choice` is a relative question and a `Noul` is an absolute one, so evidence
> inside the question helps the first and hurts the second.** Putting each tag's
> member titles into its `Noul` cost 58% of the request's tokens and dropped tag
> recall from 81.7% to 47.9% — `türkçe` recall fell from 97% to 27%. It turns
> "is this item about this?" into "is this item similar to these other items?",
> which is the wrong comparison. The digest was justified in an earlier draft of
> this document by the argument that works for the `Choice`; the argument was
> carried across without evidence and did not survive measurement.

### The decision is ours

Jev always answers. Whether to act on that answer is code, on the server, in
`decideClassification`:

```ts
collection:
  choice === "__none__"                     -> no assignment
  confidence >= settings.collectionMin      -> assign
  otherwise                                 -> no assignment, logged

tags:
  noul >= settings.tagMin  ->  sort desc  ->  keep settings.maxTags
```

`collectionMinConfidence` and `tagMinNoul` are tuned separately on purpose. A
threshold that works on one question type does not transfer to the other, and
the model's own documentation is explicit about it.

**Defaults are `0.75` and `0.80`, and both are measured.** See
[ai-calibration.md](./ai-calibration.md) before changing either; `0.85` shipped
first and was wrong.

Nothing is ever "chosen" for the user below the threshold. The safe failure is
doing nothing.

### `__none__` is the model's most confident answer

Items that fit nowhere come back `__none__` at **median confidence 0.99** —
*higher* than items that do fit somewhere (0.78). So `confidence` carries no
usable signal about whether declining was right, and no value of
`collectionMinConfidence` can catch a stray `__none__`. The safety of this
feature rests on the `__none__` option existing, not on the threshold.

### Eligibility — the rule that keeps this from overwriting you

```ts
bookmarks.filter((b) => b.ai == null && b.listId == null)
```

`listId == null` means a manual assignment is never overwritten. `ai == null`
means each bookmark is billed at most once, ever — the record itself is the
memory for a pass that acted, and `nook_ai_decided` is the memory for one that
deliberately filed nothing and so left no mark at all. See "The job queue".

The rule is evaluated twice, and the second time is the one that matters: the
pass selects candidates from a read taken at the start, and the write path
re-checks it on the row it re-reads inside the lock. See "The write path".

## The job queue

This is the substance of the move. The old runner had a queue too, but it was a
capped list of ids in a browser's IndexedDB and it had an alarm to drain it.

### Why a queue at all

A bookmark is queued when it syncs. `POST /api/sync` is where the server already
sees every bookmark, which is the same reason the client needed no code at all to
get an embedding index — see "How the index gets built" in
[retrieval.md](./retrieval.md). The argument is that one layer over: a save is
queued for classification the moment it lands, on any device, with nothing to
install and nothing to configure. The extension needed an alarm and a cursor for
exactly this, and still missed bookmarks saved while its worker was asleep.

The enqueue is one statement, and it carries the `autoClassify` guard *inside*
the INSERT rather than reading the setting first — a sync should not pay an extra
round trip for one boolean, and the decision has to be the newest one anyway: a
user who turns the toggle off should stop accumulating queue rows immediately,
not after the next tick.

It is also fire-and-forget, detached after the COMMIT, for the three reasons
`syncRecords` already gives its indexing hook: a change that is not yet queued is
still a saved change, the advisory lock has already been released by the COMMIT,
and a throw here would fall into the sync's catch and ROLLBACK something already
committed — telling the client it conflicted with its own previous attempt,
forever. The consequence is the good one: a lost insert costs a delay, not a
bookmark, because the top-up refills.

### The claim is the deletion

`claimJobs` is a single `DELETE ... RETURNING`. **The row *is* the claim** — no
`done` column, no per-job lease, no attempt counter, and no second statement to
mark anything.

That is not a simplification, it is the recovery mechanism. A process that dies
between the claim and the write has left the bookmark still eligible, still
absent from `nook_ai_decided`, and therefore re-enqueued by the next top-up, so
the work comes back by itself and nothing has to be told about the crash. The
absence of a "failed" state is deliberate: a row with `attempts` and a `state`
column is the design that *loses* work, because a bookmark marked failed and
never retried is one the model was never asked about and the queue will never ask
about again.

This is the same argument `reconcileIndex` makes about the embedding queue
dropping jobs, and it is the same reason `nook_embeddings` has no foreign key to
`nook_records`: a derived row may legitimately lag the authoritative data, and
the reconciliation pass is the backstop.

### `nook_ai_decided`, and the money it saves

The old runner kept "we already bought a decision for this" in `ai.cursor`, as a
list of ids capped at **2,000**. The cap existed for a real reason: a decision
that assigned nothing writes nothing to the record, so `ai == null` is not
memory of it, and the id list was the only record that the answer existed. The
leak was in the cap. Past 2,000 the oldest ids were dropped, and because
candidates are taken newest-first, those came back only once everything newer was
resolved — so on a library of a few thousand undecided bookmarks, every one of
the oldest was re-bought forever, continuously, because nothing about them ever
changed. That is not a rounding error on the cost figure; it is a permanent
re-bill of a fixed slice of the library, and the document used to leave it
implicit.

Server-side the memory is a table, `nook_ai_decided`, unbounded and durable at
roughly 60 bytes a row. The leak is closed because the thing that leaked was the
cap, not the idea.

It is deliberately **not** a field on `nook_records`. Writing one would stamp
`updatedAt` and take `nextval('nook_sync_version_seq')`, which is a version bump
and a no-op change pushed through `/api/sync` to every device, resurfacing the
bookmark in the dashboard as freshly edited. That is exactly the harm the capped
cursor existed to avoid, and it would have happened 2,000 times instead of once.
Nothing in the decided table is synced, and nothing in it is a fact about the
bookmark — it is a fact about our own spending.

An id is remembered whether or not the decision filed anything, and an id the
pool never got to (because the batch stopped first) is deliberately *not*
remembered: that bookmark still deserves its one classification.

The price of not capping it is a table that only ever grows, so `pruneDecided`
drops the rows whose bookmark is gone or tombstoned — a row nothing will ever
read again. It runs on the reconciler's 15-minute cadence, not on every tick,
because a minute is far too often to answer a question that is not urgent.

### `nook_ai_summaries`, and why it is not `nook_ai_decided`

Summarisation has no queue and a different kind of memory. There is nothing to
insert: a candidate is a candidate at every moment, so the pass reads the next 25
off `nook_records` newest-first and takes them, and what it keeps is
`nook_ai_summaries` — one row per bookmark that was **attempted and produced
nothing**, carrying a sha256 of the prompt's own text, when the attempt happened,
and which of two retry windows applies. **The rule itself, the hash and the
deletion semantics are in [retrieval.md](./retrieval.md)'s "Summaries" section**;
this is only the part that belongs next to `nook_ai_decided`.

It cannot be that table. `nook_ai_decided` is a **permanent** "we already bought
a decision for this" marker and permanence is exactly right there, because a
classification may only be bought once ever. A summary is a field the user is
allowed to clear, so a marker that outlived the summary would make it
undeletable in the only sense that matters: the user clears it and it never comes
back. Re-billing a cleared summary is a fraction of a cent; an un-clearable
summary is a bug that looks like a haunting. So a written summary **deletes** its
row, and only a decline or a failure leaves one.

Cost, since this is the document that carries the money: at `gpt-4o-mini` a
summary is **≈$0.00026 a bookmark** against classification's **$0.000062** — about
4×, bounded by the library rather than by the tick, and **≈$0.43** for a full pass
over 5,000 bookmarks of which about a third clear the gate. There is deliberately
no spend cap, for the reason embeddings and classification have none either. And
it is the first feature here that sends **page text** to a third party — up to
4,000 characters of the description, the title and the note, where taxonomy sends
titles and hostnames and classification sends titles, a 300-character preview,
notes, hostnames and an author handle. The toggle says so on its own face, which
is the only place it is worth saying.

### The rate, and why a faster tick is not a cost problem

**≈150 bookmarks a minute**, against the extension's 25 per 5-minute alarm —
and, until this section was last revised, this server's own earlier default of
25 a minute. `AI_TICK_INTERVAL_MS` defaults to **10 seconds** now rather than
60: a full batch is still `CLASSIFY_BATCH_SIZE` (25) per account per tick, and
25 bookmarks every 10 seconds is 150 a minute. **1,000 bookmarks clears in
roughly 7 minutes**, where the 60-second default took roughly 40.

The total cost is unchanged, because cost is per bookmark and not per tick. A
classification is a measured **1,466 input tokens** at `$42` per billion, and
5,000 bookmarks is **$0.31**, once, whether it clears in 40 minutes or in 7.
The once-a-minute tick was never a cost guard — it was an unexamined holdover
from the extension's own polling cadence, and the artificial ceiling it
imposed (docs's earlier text put it at "25 bookmarks per minute") had nothing
underneath it once `nook_ai_decided` made billing per-bookmark rather than
per-cap. The real ceiling is `CLASSIFY_CONCURRENCY` (4, unchanged) against the
upstream's 1,200-requests/minute limit, and that is nowhere near saturated by
how often a tick fires.

The reason a faster tick is safe rather than reckless is still
`nook_ai_decided`: with the old capped cursor, a faster tick would have
multiplied a permanent re-billing leak; with the unbounded table, a bookmark is
bought exactly once no matter how many ticks pass while it sits queued. See
"The tick and its ceiling" below for the other half of the safety argument —
the per-account lease, and the re-entrancy guard that keeps an overrunning tick
from piling up rather than merely running back-to-back.

### The tick and its ceiling

`AI_TICK_INTERVAL_MS` is 10 seconds, overridable with `NOOK_AI_TICK_MS` and
floored at a second so a typo cannot turn the worker into a spin loop. The first
run is delayed 30 seconds, because the container may still be applying
`schema.sql` and a tick that reads before `nook_ai_jobs` exists only logs a
failure — the same reason the embedding reconciler waits 30 seconds for its
first run.

A tick can legitimately take longer than 10 seconds — a busy deployment's
sequential pass over several accounts, each up to 25 classify calls, is not
bounded to fit inside the interval — so `tickAiWorker` guards its own
re-entrancy: a tick that is still running when the next one is due returns
immediately rather than starting a second one. This is a throughput guard, not
a correctness one. Nothing about an overlapping tick could have double-billed
even without the guard: the claim in `nook_ai_jobs` is one atomic
`DELETE ... RETURNING`, so two ticks can never claim the same row, and a second
tick that reaches an account already mid-pass fails `acquireRunLease` and
returns before claiming anything. The guard exists so a slow tick does not also
re-run the accounts query and a doomed lease attempt per account for as long as
it stays slow, and so `lastReconcileAt` is only ever updated by one tick at a
time — without it, two overlapping ticks could each decide they are the
15-minute reconcile tick and run the larger top-up and prune twice.

Each tick considers at most 50 accounts, ordered by how much work each has, and
works them **one at a time**. That is a bound on how long one tick may take, not
on the request rate: the instantaneous rate is `CLASSIFY_CONCURRENCY` (4,
unchanged) however many accounts are waiting, and that is the number the
upstream's 1,200 requests/minute limit is about. Concurrency across accounts
would buy a few minutes on a 50-account deployment and cost a rate limit.

Every 15 minutes the same tick reconciles instead of topping up: a larger top-up
(500) plus the prune. Large enough to be a backstop rather than a refill — a
library that has been offline for a week is filled in a few ticks instead of
hundreds. The reconciler's exclusions are SQL and are the same ones the ordinary
top-up runs on, deliberately: a reconciler that read the library and planned in
JS would be a second implementation of a rule that has to be identical to the
first, and the two would drift.

A pass is gated, in order: the lease, `autoClassify`, the cooldowns, and then —
before anything expensive happens — an empty queue. An empty queue returns
*before* the library is read, because the option builders need the whole library
and once a minute forever is a lot of ticks with nothing in them.

The cooldowns are two windows, not three, and both are conditions of the
*deployment and the upstream*: no `TYPESAFE_API_KEY` gets a quiet hour, and a
rate limit or an unreachable model gets an exponential backoff from 60 seconds to
30 minutes. The extension's third window — a 30-minute park after a 401 — is
gone, because it was a client and a 401 meant only a re-sign-in in that browser
could fix it. A pass here holds no session and cannot be signed out.

### The lease

Two api replicas must not run a pass for one account. `acquireRunLease` is one
conditional upsert on `nook_ai_state.lease_until`, released in a `finally` so a
failed pass does not park the feature for the length of the lease.
`NOOK_AI_LEASE_SECONDS` sets it, 120 by default: enormous next to a real pass (25
requests at concurrency 4, a few seconds of work) and small next to an outage.

What the lease protects is the expensive half — the duplicated library read, the
duplicated option build, and two passes fighting over `nook_ai_state`. It is not
what prevents a double charge; the claim in `nook_ai_jobs` is. A lease that
expires early costs a second pass finding an empty queue and a slightly stale
counter, not a second bill.

It also keeps the enqueue out of the pass's way. `enqueueClassification` is a
single statement outside the advisory lock, so saving a bookmark is never queued
behind a running pass; and where a pass and a sync genuinely do collide — the
write — they serialise through the same lock rather than through one of them
holding an HTTP request open, which is the arrangement that would have deadlocked
or timed out.

## The write path

### The problem

The server now writes a record a client may be editing at the same instant. The
old runner wrote through the client's own `NookDB.updateBookmark(id, patch)`,
so the two writers were the same writer and this could not happen. It is the one
new hazard the move created, and it is why `applyClassificationPatch` is the
most delicate function in the feature. `docs/ai-cloud-contract.md` has the
mechanics; the reasoning is here because the contract cannot carry it.

Since summarisation arrived, the transaction itself lives in **`applyServerWrite`**
and `applyClassificationPatch` is one of its two callers — the other writes
`summary` through the same lock, the same re-read and the same version bump
([retrieval.md](./retrieval.md)'s "The write path"). Everything below describes
that one function, so each of these comments now guards two features instead of
one, which is why none of them was shortened in the extraction.

### The lock

`applyClassificationPatch` takes `pg_advisory_xact_lock(hashtext(user_id))` —
**the same lock `syncRecords` takes**, on the same key.

That identity is the whole reason a decision cannot interleave with a sync's
read-check-write. A sync reads a record's version, compares it to the client's
base version, and upserts, all under that lock. So either the decision lands
first and the sync sees a bumped version and answers with a conflict the client
resolves by merging the newer side, or the sync lands first and the decision's
re-read sees the human's change. There is no in-between.

A *different* lock key would be worse than no lock at all: it would serialise
the two subsystems against nobody and then let both write.

### The re-check

Eligibility — `ai == null && listId == null` — is re-evaluated on the freshly
read row, not on the candidate the pass read at the start. A human who filed a
bookmark while the request was in flight wins, and the model is never asked
about it twice.

It is the same rule as the original eligibility guard above, now enforced at the
only moment it can be violated. Before the move the guard was enough, because
the write could not land between the read and the write. Now it is not enough on
its own, and that gap is the entire risk of a server-side writer.

### The recompute

The patch is rebuilt against the fresh row rather than applying one computed at
the start of the pass. Tags are a union, so a tag the user added in the
meantime has to survive; applying the earlier patch to the fresh row would
overwrite it with a `tags` array built from a record that no longer exists.

### Why nothing in the merge layer changed

The patch only ever carries `listId`, `listName`, `tags` and `ai`, and the
recompute makes `tags` a union — which is already exactly what `mergeBookmarks`
does, including taking `ai` from the same side it takes the assignment from. The
"Merge semantics" section below is therefore still correct as written, and is
the rule this relies on rather than a restatement of it.

Only `updatedAt` and `version` are genuinely new, and that is the point: they
are what make the change reach every device through the ordinary sync pull, and
what make `mergeBookmarks`'s newer-wins resolve in the server's favour. They
are also why a no-op write would be a real cost. `patchChangesSomething` gates
the write, because bumping the version of a record whose content did not change
would push a no-op change to every device and resurface the bookmark in the
dashboard as freshly edited, for nothing.

## Review list

Production data made the gap concrete: after accepting 8 collections, a real
account's classification pass filed 17 of 75 bookmarks and left roughly 33 more
with a plausible top collection under `collectionMinConfidence` — a guess
`decideClassification` already computes and, until this section, threw away
outright. `collection.id` is `null` on a `skipped: "low-confidence"` response
either way, so the near-miss and the model's own uncertainty looked identical
from the outside. Those ~33 are worth a one-click "file it or not" prompt
instead of silence, and this is the machinery that keeps them rather than
discarding them.

### The guess

`decideClassification` (ai.ts) already knows the top choice on a low-confidence
skip — it is the same `choice`/`name` that would have been assigned had
confidence cleared the real threshold. It is now kept on the response as
`guess: { id, name, confidence }`, gated on a second, much lower floor,
`REVIEW_MIN_CONFIDENCE` (0.35): a filing threshold decides what to act on
automatically, but 0.35 decides whether a number is worth showing a human at
all, since a response near zero is noise no one could use to decide between
"probably" and "probably not". **This changes nothing about what gets filed** —
`collection.assign` stays `false` and `collection.id` stays `null` on the exact
same response `guess` rides on. Never populated for a `skipped: "none-fit"`
response (the model confidently said no collection fits, at a median confidence
of 0.99 — see "`__none__` is the model's most confident answer" above) and
never for tags: this is collections only, because a tag is additive and
non-exclusive, and there is no equivalent "maybe" worth surfacing for one.

### The table

`nook_ai_review` (schema.sql) is one row per bookmark: `bookmark_id`, the
guessed `list_id`, its `confidence`, `created_at`. `runClassificationPass`
(ai-jobs.ts) collects every kept guess from a batch and upserts them in one
statement, the same batching `rememberDecided` already uses for
`nook_ai_decided` — not written per-bookmark inside the loop.

It is deliberately not permanent bookkeeping the way `nook_ai_decided` is. A
bookmark reaches this table only once under ordinary operation (a decided
bookmark is never reconsidered), but a taxonomy acceptance wipes
`nook_ai_decided` and makes previously-decided bookmarks eligible again — and
when that happens, a fresher guess against the new option set should replace
the stale one rather than lose to it, so the upsert is `ON CONFLICT ... DO
UPDATE`, not `DO NOTHING`. It is also, deliberately, not a field on
`nook_records`, for the same reason `nook_ai_decided` is not one: writing there
would bump the sync version for a guess nobody has acted on yet, resurfacing
the bookmark on every device as freshly edited.

Nothing sweeps this table on a schedule the way `pruneDecided` sweeps
`nook_ai_decided`. A stale row — its bookmark filed some other way, deleted, or
its guessed collection itself deleted — costs nothing sitting there unread, so
the read that is about to show the list to a human (`readReviewList`) prunes it
first: one `DELETE` against the same liveness predicate (`REVIEW_ROW_LIVE` in
ai-store.ts) that `readReviewCount` uses for the status route's `reviewCount`,
so the two numbers can never quietly disagree about what "still pending" means.

### The routes

Both session-guarded like every other `/api/ai/*` route.

```ts
// GET /api/ai/review -> { items: AiReviewItem[]; total: number }
//   Highest confidence first, limit 200. `total` is the count before the
//   limit, so a client can show "200 of 340" instead of silently truncating.
interface AiReviewItem {
  bookmarkId: string;
  listId: string;
  listName: string;
  confidence: number;
}

// POST /api/ai/review/resolve
//   <- { items: Array<{ bookmarkId: string; action: "accept" | "reject"; listId?: string }> }
//      (1 to 200 items; a malformed one 400s the whole request rather than
//      being silently dropped, because the caller is about to render "N filed,
//      M rejected" and a quietly ignored item would make that count a lie.)
//   -> { filed: number; rejected: number; skipped: number }
```

`accept` files the bookmark through **the exact same write path a
classification decision uses**, `applyServerWrite` — the same advisory lock,
the same `SELECT ... FOR UPDATE`, the same re-check against the row read
*inside* the lock rather than the one read at the start of the request. The
guard is deliberately narrower than `bookmarkNeedsClassification`: it checks
only `listId == null` on the fresh row, not `ai == null` too, because a
bookmark whose *tags* were already filed by this same low-confidence decision
already carries a non-null `ai` and must still be acceptable here — only the
collection assignment is what "still unfiled" means for this route. A bookmark
some other write filed in the meantime is reported `skipped`, not `filed`
— the same "a human wins" rule the classification pass's own re-check follows.
`listId` defaults to the stored guess and may be overridden in the request, for
a reviewer who agrees the item is worth filing but not into that collection.

The receipt written on accept is shaped like the one a classification decision
writes (`model`, `at`, `collectionConfidence`), plus `source: "review"` so it
can be told apart from a decision the pass filed on its own — `model` is the
generic `"jev"` rather than a specific version string, because
`nook_ai_review` never stored which exact model version answered, only the
confidence, and restating a version here would be a guess dressed as a fact.

`reject` only deletes the review row. `nook_ai_decided` — written when the pass
first decided on this bookmark — is left completely alone, which is the entire
point: rejecting a suggestion must not make the bookmark billable again.

The review row is deleted in **both** outcomes of an accept, whether or not the
file actually lands, and on every reject — a resolved item must never reappear
on the next `GET /api/ai/review`.

`reviewCount` — the same count `GET /api/ai/review`'s `total` reports — is
additive on `GET /api/ai/status`, so the client can badge the review list
cheaply without a second round trip. Unlike `readReviewList`, it never prunes:
the status route is polled every few seconds while a pass drains, and a
`DELETE` on every one of those polls would be pruning a table nothing has
necessarily changed since the last poll. The much rarer "open the review list"
read is where the lazy prune actually happens.

## Non-English content

**Measured: this is not a risk.** An earlier draft of this document treated it as
the central open question, on the strength of TypeSafe's own warning that
English is the primary training language. A run against 57 hand-labelled real
bookmarks came back negative:

- Turkish vs English collection confidence, Mann-Whitney **p = 0.67** on the
  subset that matters. Turkish median is equal or higher in every arm.
- Turkish items clear every threshold at a rate equal to or higher than English.
- Asked plainly as a language detector, the `türkçe` `Noul` is 54/55 correct,
  median 0.98 on Turkish against 0.02 on English.

Jev reads Turkish fine. **Do not add a language-specific threshold, and do not
re-derive the fear from the vendor docs alone.**

Two real effects did surface, and neither is what was expected:

1. The one measurably language-sensitive question was `open-source`, whose
   criteria offer only the English words while a Turkish item says `açık kaynak`.
   That is an English-vocabulary artefact in the question, not a comprehension
   failure. Writing tag criteria in the library's language is the obvious fix and
   is **untested**.
2. The largest unclassifiable group is not Turkish at all — it is media-only
   bookmarks. See the 40-character floor above.

Full numbers, per-question tables and the threshold sweeps are in
[ai-calibration.md](./ai-calibration.md).

## Accuracy is bounded by the taxonomy, not the threshold

Every hard case the model got wrong was an AI item placed in a neighbouring
collection, and its bias is always toward whichever collection has the largest,
most distinctive digest. A sprawling, overlapping taxonomy will do worse than
the measured numbers, which were taken against a four-collection taxonomy built
for the experiment. At `0.75` the feature files roughly half of what it could;
no threshold fixes that, and the panel's filed-vs-skipped counter is there so the
gap is visible rather than discovered.

## Taxonomy growth

Jev cannot invent names, so the generator does:

```
200 unfiled bookmarks, sampled with a deterministic stride
  -> POST /api/ai/taxonomy/propose   (a cheap text LLM — gpt-4o-mini or gemini-2.5-flash)
  -> preview in Settings: checkboxes + a one-line "why" per proposal
  -> you accept; real BookmarkList records are created
  -> nook_ai_taxonomy records each accepted name with its sample titles
  -> the next pass runs; the new collections are just more options
```

Trigger: the **Suggest taxonomy** button in the panel, plus the `autoTaxonomy`
toggle that gates it. The sample, the existing collections and the library's own
tags are all read from `nook_records` on the server, so the client sends no
library at all and cannot be wrong about which bookmarks were read.

The proposer returns **two** vocabularies, and both are offered for review:

- **Collections**, which become real `BookmarkList` records. They are exclusive:
  one bookmark, one collection.
- **Tags**, stored as a flat vocabulary in the accepted taxonomy's `tags` — see
  below.

Acceptance is one transaction on the server: the list rows and the taxonomy row
are written together, which the extension could not do. There, the collections
were created in IndexedDB and the taxonomy was a separate meta write, so a
failure between them left a collection the runner knew nothing about. Its comment
explained that the lists had to be written *before* the record because the two
were separate writes and only one could be undone. That ordering constraint is
gone, and what replaces it is that neither can be half-done.

### Tags that have no members yet

This is the part that is easy to get wrong. The pass builds its tag questions
from the tags bookmarks *already* carry, so **a proposed tag with no members
could never be offered by any code that existed** — the first version of this
feature generated them, parsed them, and dropped them on the floor.

The fix is one field. The accepted taxonomy's `tags` holds names nothing carries
yet, and `buildTagOptions` appends them after the library's real tags, capped at
20 questions. A new tag then earns its first member the ordinary way — the model
is asked `Does this saved item belong under the tag "yazılım geliştirme"?` and
answers at full price, under the same threshold as any other tag. Once one
bookmark takes it, it is a real tag and the stored entry is redundant.

Verified against the live service on a 200-bookmark sample of the real library:
a vocabulary with **zero** members put `yazılım geliştirme` on 20 of 60
bookmarks, `kodlama` on 8, `kullanıcı deneyimi` on 2, in a single pass.

A proposed tag is offered, not dropped, when a collection in the same batch
already speaks for it — the proposer names one theme and then proposes it twice
("Açık Kaynak Projeleri" and "açık kaynak"), and those are not redundant, since
a collection is exclusive and a tag is not. It is simply **unticked by default**,
with the reason shown, so the two do not arrive fighting each other. The overlap
test compares word *stems*, because Turkish puts its endings on the stem
("tasarımı" against "Tasarımları").

### Two things about the vocabulary that were wrong first

**The cap is 20, and it was briefly 12 for a bad reason.** 12 was chosen to
"leave room for the library's own tags" — but `buildTagOptions` already puts the
library's real tags first and slices, so they were never at risk, and 12 meant
that ticking 13 of the 20 tags the proposer offered silently discarded one with
nothing in the review list saying so. Nothing the user ticks should vanish at
acceptance.

**Tags carry a definition, and it is not a digest.** A member-less tag asked
about by bare name is the thinnest possible input, so the proposer now returns a
`why` for every tag and that line is kept. It is deliberately *not* the
member-title evidence that measurably halved tag recall: a definition is evidence
about the tag itself, which is what a Noul with no members has nothing else for.
Measured over 80 real bookmarks, definitions put **12 of 12** vocabulary entries
to use against **10 of 12** for bare names, at 24% more input tokens. A modest
win, honestly — not the large one it looked like on paper.

### What the proposer is actually like

Measured repeatedly against this library, and worth knowing before changing the
prompt:

- **It is not deterministic.** The same 200 bookmarks propose visibly different
  collections on different runs, and near-duplicates accumulate across runs
  because the merge is by exact name. The review list is the mitigation.
- **`gpt-4o-mini` is the default, not the newer `gpt-5-nano`,** because it was
  clean on every run. `gpt-5-nano` was fine on `auto` but produced a broken token
  (`agtanıtım`) and an untranslated `open source dizin` when the language was
  pinned to Turkish. An earlier draft of this document blamed nano for much more
  than that; it was mostly an over-constrained prompt, which degraded both
  models. `NOOK_AI_MODEL` overrides the choice, because the evidence can move.
- **The gpt-5 family needs `reasoning_effort: "minimal"`.** Unset, it spent 768
  tokens reasoning on a two-line answer and returned an *empty message*. It is
  also the only family that accepts the parameter — gpt-4o-mini answers **400**
  ("Unrecognized request argument supplied") — and the only one that rejects
  `max_tokens`, so both are branched on the model name.
- **Prompting it not to ASCII-fold is necessary.** Left alone, it slugified every
  Turkish tag into `acik-kaynak-belgeler` and `tasarim-araclari`. It also
  produces broken morphology under enough pressure ("entegrasyonlar api ler"), so
  the constraints were pulled back to the two that demonstrably work: keep the
  language's own letters, and separate words with spaces.

### Language

The setting writes collections and tags in the chosen language. **`Match my
library` is the default and measured best** — on both models, pinning it to
Turkish was no better and sometimes worse, because the model tries harder and
produces less natural morphology. The setting exists for a library that is
overwhelmingly one language *and* a different one from the sample's, not as a
general quality lever.

### The proposer is not deterministic

Two runs over the same 200 bookmarks proposed visibly different collections —
"Yapay Zeka Araçları" and "Açık Kaynak Projeleri" the first time, "Açık Kaynak
Güvenlik" and "Geliştirici Araçları" the next. Near-duplicates therefore
*accumulate* across runs, because the merge is by exact name.

That is a real wart, and the review list is the mitigation rather than a fix:
each batch is shown before anything is created, and unticking is one click. A
fuzzy dedupe was deliberately not added — silently dropping a proposal the user
would have wanted is worse than offering two similar collections, and only the
user can tell which is the one they meant.

## Suggestions from clusters

Taxonomy growth above has a real ceiling, and it is not the threshold: the
proposer only ever sees a 200-bookmark *sample*, and the classifier files the
whole library against whatever names came back from that sample, one bookmark
at a time. On a real 1,063-bookmark library of saved X posts this filed only
**~24%** — not because the model was wrong about any one bookmark, but because
the sample never covered the library the classifier was then asked to file.
A generative model is bad at exactly the thing that ceiling depends on: TR-MTEB
puts `text-embedding-3-small` weakest on *similarity* of the three models
measured (docs/retrieval.md), which is precisely why naming was never combined
with grouping until now — "Clustering the library without a naming step" was
listed as deliberately out of scope in that same document, for the one thing
the embedding model measures worst at. The fix is not a better prompt; it is
not asking the model to do that job at all.

Every bookmark already carries an embedding (`nook_embeddings`,
`text-embedding-3-small`, docs/retrieval.md), so the flow inverts:

```
unfiled bookmarks' embeddings
  -> cluster by cosine similarity (apps/api/src/cluster-math.ts, pure, deterministic)
  -> merge near-duplicate clusters, drop outliers and tiny clusters
  -> match a cluster against an existing collection's own centroid, if close
  -> ONE proposer call: name every cluster that isn't already a match
  -> preview in Organize: each proposal shown with its real member bookmarks
  -> you accept; the members are filed INSTANTLY — no per-bookmark classify call
```

The word doing the work is "instantly". Taxonomy growth creates *names*, and
still has to wait for the classification pass to go bookmark by bookmark
deciding who belongs where. Here, membership is already known the moment the
cluster was formed — accepting a proposal is a write, not a queue.

### The algorithm, and why each number is what it is

`clusterEmbeddings` in `cluster-math.ts` is pure: no `fetch`, no `pg`, no clock,
a seeded PRNG standing in for every random choice. Reproducibility matters more
than raw quality here — the same library clustered twice has to produce the
same groups, or "Suggest collections" run again would look like a bug rather
than a repeat of the same answer.

1. **Normalize, then spherical k-means.** Every vector is scaled to unit
   length, which makes ordinary Euclidean k-means and "maximize cosine
   similarity" the same optimization (`||a-b||² = 2 - 2·cos(a,b)` for unit
   vectors), so no custom distance metric is needed. `k = clamp(round(√(n/2)),
   4, 30)` — the standard rule-of-thumb estimate of "how many natural groups",
   clamped so a tiny library isn't asked to review one collection and a huge
   one isn't asked to review thirty in one naming call. Seeded k-means++,
   restarts scaled down as the library grows (5 under 1,000 points, down to 1
   past 4,000) so a 10,000-bookmark account still finishes in a few seconds —
   restarts defend against a bad random seed, and k-means++ already starts
   close enough to the answer that even one restart recovers well-separated
   structure (measured in `ai-clusters-math.unit.test.ts`).
2. **Merge near-duplicate clusters** (cosine of their centroids `> 0.9`). `k`
   is an estimate, and k-means routinely splits one real theme into two
   adjacent clusters; presenting both as separate suggestions would just be
   the same collection proposed twice.
3. **Drop low-similarity members** (cosine to their own cluster's centroid
   `< 0.35`) into "unclustered". These are the points k-means was forced to
   assign *somewhere* — every point gets an assignment — that do not actually
   belong, and they are the majority of what makes a raw k-means assignment
   look wrong on inspection. `0.35` sits below docs/retrieval.md's search floor
   (`0.40`, measured against nonsense queries topping out at `0.41`) because
   the two floors answer different questions — one gates whether a *match*
   means anything, this one gates whether a member belongs in a group at
   all — and is a starting point to tune against a real account's library
   rather than a value measured the way the two documents' other thresholds
   were; see the note in `cluster-math.ts`.
4. **Drop clusters smaller than `max(5, 2% of n)`** into "unclustered" — a
   group that small is not worth a proposal of its own, and a 10,000-bookmark
   account should not be shown two hundred near-singleton "collections".
5. **Match against existing collections.** Each live collection's centroid is
   the mean of its own filed, embedded members' vectors. A cluster whose
   centroid is within `0.85` cosine of an existing collection's is proposed as
   *that* collection rather than a new name — deliberately a higher bar than
   the merge threshold above, because the two questions are not equally safe
   to get wrong: proposing a redundant new collection costs one unticked
   checkbox, and folding a cluster into the wrong existing collection is not
   something the review list lets the user catch at a glance.

Verified on synthetic data (`ai-clusters-math.unit.test.ts`): four
well-separated blobs recover as four clusters at 100% purity; scattered,
mutually-dissimilar points end up entirely in "unclustered", never inside a
real group; near-duplicate clusters merge into one; a group under the size
floor is dropped; the same input always produces the same output. Measured
timing on a synthetic 1,000-point × 768-dimension set (`text-embedding-3-small`'s
own shape): **~0.3 seconds**. At the stated ceiling of 10,000 points it is
**~3.5 seconds** — inside "a few seconds" without needing pgvector or a
Postgres extension, the same brute-force-is-fine argument docs/retrieval.md
already makes for search at this library size.

### Naming: one call, and only for what still needs a name

A cluster already matched to an existing collection needs no name invented —
the honest name for "more of what's already in Reading" is "Reading" — so it
is never sent to the proposer at all. For every other cluster, the ~6
representative bookmarks nearest its centroid (title or a short text snippet,
capped at 200 characters, plus hostname or author when known) go into **one**
request that names every remaining cluster at once, reusing the exact
provider/model/key resolution and JSON-output hardening the taxonomy
proposer's own call already uses (`resolveProposer`/`generate` in `ai.ts`,
additive exports — no behaviour there changed). `gpt-4o-mini` stays the
default; `NOOK_AI_PROPOSER`/`NOOK_AI_MODEL` are not reconfigured by this
feature. `language` behaves exactly like the taxonomy route's own parameter:
`"auto"` (the default) follows the representative items' own language, and the
account's live collection names are passed so the model does not re-propose
one that already exists.

A cluster the model's response does not return a usable name for (missing, or
missing its `why`) folds back into "unclustered" rather than surfacing as a
proposal with no name — one bad line in the response must not cost every other
cluster its proposal, the same principle `parseTaxonomyProposal` already
applies per-entry.

**Cost**: at most one proposer call per "Suggest collections" round, however
many bookmarks the account has — the same "one call, however large the
library" shape the existing taxonomy proposal already has, and **zero extra
embedding cost**, since every embedding this feature reads was already paid for
by the search index (docs/retrieval.md). A round where every surviving cluster
matches an existing collection costs nothing at all: no proposer call is made.

### Routes

Both session-guarded, both mirroring `/api/ai/taxonomy/propose`'s own pattern
exactly — same 401 when signed out, same 503 when `NOOK_AI_PROPOSER` and its
key are not configured, checked before either route does anything else (the
client has to be able to tell "this server cannot do that" from "there is
nothing to cluster").

```ts
// POST /api/ai/clusters/propose <- { language?: TaxonomyLanguage }
// -> {
//      proposals: Array<{
//        id: string; name: string; why: string; size: number;
//        memberIds: string[];
//        sampleTitles: string[];     // at most 5, nearest-to-centroid first
//        existingListId: string | null;
//      }>;
//      unclustered: number;
//      considered: number;          // unfiled bookmarks with an embedding
//    }
// `considered` under 20 short-circuits to `{ proposals: [], unclustered:
// considered, considered }` before the proposer is even resolved — a library
// this small has nothing worth clustering, and saying so costs one read.
// Proposals are sorted by `size` descending. 401, 400 (malformed body /
// unknown language), 503 (no proposer configured), 502 (the proposer WAS
// configured but the one naming call itself failed — deliberately distinct
// from `proposeTaxonomy` in ai.ts, which silently degrades a failed call to an
// empty result: this route's contract is that a failure is visible, not
// folded into "nothing to cluster"), 200.

// PUT /api/ai/clusters/accept <- {
//   collections: Array<{ name: string; memberIds: string[]; existingListId?: string | null }>
//   // at most 50 collections, at most 5,000 member ids total
// }
// -> { createdCollections: number; filed: number; skipped: number }
// One transaction, under the same pg_advisory_xact_lock(hashtext(user_id))
// every write in this feature takes (see "The write path" above) — the same
// lock is what makes filing thousands of ids as a handful of bulk UPDATEs
// safe rather than a race with a concurrent sync, and it is why this does NOT
// call applyServerWrite per bookmark: that helper takes the very same lock on
// its own connection, so calling it from inside a transaction that already
// holds it would be a self-inflicted deadlock rather than a safety net.
// 401, 400 (malformed body, or over either cap), 200.
```

`PUT /api/ai/clusters/accept`, in order:

1. **Resolve each requested collection to a real list.** An explicit
   `existingListId` that is still live is honoured outright, even if the
   requested `name` disagrees with it. Otherwise, **a name that collides with
   a live collection files into that collection instead of creating a
   duplicate** — the same collision discipline `acceptTaxonomyForUser` already
   applies via `planLists`, reused directly here rather than re-implemented.
   Everything else is a new list, created the same way (same record shape, id
   generation, version bump).
2. **File every member id that is still live and unfiled**, re-checked on the
   row as read *inside this same lock* — not `applyServerWrite`'s per-row
   re-read (which would deadlock against the lock this transaction already
   holds), but the identical guard expressed as a bulk `UPDATE ... WHERE
   deleted_at IS NULL AND data->'listId' IS NULL`. A human who filed the
   bookmark, or a sync that deleted it, while the request was in flight wins;
   that id is counted in `skipped`, not overwritten. The written receipt is
   `{ model: "nook-clusters", source: "cluster", at }` — the same three fields
   `attribution()` in `ai-classify.ts` writes for an ordinary decision, plus
   `source` so a filed-by-cluster bookmark is distinguishable in the log from
   one the per-bookmark classifier decided on.
3. **Record the accepted names in `nook_ai_taxonomy`**, the same account row
   `acceptTaxonomyForUser` writes, so the classifier offers these collections
   to bookmarks that are saved *after* this round — with one improvement over
   the taxonomy flow's own record: its per-collection sample digest is a
   word-overlap *guess* over an unrelated 200-item sample, because the
   proposer never says which bookmarks belong to a name it invents. Here the
   digest is the actual titles of members that were actually filed, because
   real membership was never in question.
4. **Clear `nook_ai_decided` when a list was created** — the same fix
   `acceptTaxonomyForUser` already applies and for the identical reason: a
   "nothing fit" verdict bought against a taxonomy that did not yet have this
   collection is stale the moment the collection exists.

### What this does not change

The per-bookmark classifier (`ai-classify.ts`, `ai-jobs.ts`'s pass), the
Jev thresholds, `decideClassification`, and ordinary taxonomy growth are all
unchanged and keep working exactly as documented above. Clustering is a
second, independent way to reach the same end state — a filed bookmark — for
an account whose library is too large for the sampled flow to cover well; nothing about accepting a cluster proposal marks those collections as
special, and the classifier files new bookmarks into them exactly as it would
any other collection.

## Storage

`Bookmark` has an open `[field: string]: unknown` index signature, so a new
field flows through IndexedDB, JSONB sync, fingerprinting and import/export
with **no schema change**. Attribution is recorded so the UI can distinguish
AI's work from yours:

```ts
interface AiAttribution {
  model: string;                            // "jev-1.13.0"
  at: string;
  collectionConfidence?: number;
  tagConfidence?: Record<string, number>;   // tag name -> noul
  taxonomyAt?: string;
}
```

Progress lived in the extension's IndexedDB `meta` store, under four keys. All
four are account rows now, plus two that had no key to begin with — the
classification queue and the summarisation attempt memory, neither of which had a
runner to own a cursor:

| table | holds | what it was |
| --- | --- | --- |
| `nook_ai_jobs` | the classification queue: one row per bookmark awaiting a decision, deleted by the pass that claims it | new — a browser had an alarm and a cursor instead |
| `nook_ai_state` | counters, last run, the two cooldown windows and a 200-entry ring buffer of decisions for classification, the same counters under a `summarize` sub-record for summarisation; plus `lease_until` and `summary_lease_until`, the two columns deliberately *outside* the jsonb | `ai.cursor` + `ai.log`, two per-origin `meta` keys, which is why the web host could show neither |
| `nook_ai_taxonomy` | the accepted taxonomy: `collections` (name + sample titles each) and `tags` (names with no members yet, each with its definition) | `ai.taxonomy`, a per-origin `meta` key, which is why a taxonomy accepted on the web could never reach the runner |
| `nook_ai_decided` | every id a decision has been bought for, including the ones that filed nothing. Unbounded, durable, and never synced | the tail of `ai.cursor`'s capped id list — and the money the cap leaked. See "The job queue" |
| `nook_ai_review` | a kept low-confidence guess per bookmark: `list_id`, `confidence`. Pruned lazily, by the read that is about to show it to a human, not on a schedule | nothing — the guess used to be computed and thrown away. See "Review list" |
| `nook_ai_summaries` | every id a summary was **attempted** on and got nothing, with a sha256 of the prompt's own text and which retry window applies. A written summary deletes its row | nothing — the summarise pass had no runner, so it had no memory to migrate |
| `nook_ai_settings` | toggles and thresholds, one account row | `ai.settings`, moved before this one; `lib/ai-settings.ts` still keeps a short-lived local cache under that key name, but the row is the source of truth |

The 200-entry log is a ring buffer, not a growing log: it is carried on the wire
as `AiRunSummary.log` for a confidence histogram, and the panel currently draws
the run's own filed-vs-skipped row instead. 200 is what the histogram wants and
what the panel's summary is a summary of.

`lease_until` and `summary_lease_until` are columns rather than fields of `data`
on purpose: a lock you read, merge and write back through jsonb is a lock two
replicas can both take. They are two columns rather than one because the two
passes would starve each other for a shared lease at a 60-second tick, and they
write different fields — see "How the pieces fit".

Only one key survives in the extension, and it is a cache: `ai.settings`, the
short-lived local mirror of the account row the panel renders instantly from and
falls back to when signed out. Nothing else about this feature is per-origin any
more, which is the whole reason the panel is no longer host-shaped.

`AiAttribution` on `Bookmark` is unchanged as a *synced* field, but the
direction of the write inverted: it used to be written by whichever device ran
the pass, and it is now written by the server, reaching every device through the
ordinary sync pull. It is also a field the server must be able to leave alone —
see "The write path".

## Merge semantics

`listId`/`listName` are taken together from whichever side has a `listId`
(`cloud-merge.ts`). Attribution is generic newer-wins, which is almost right and
quietly wrong in one case: if the newer side *removed* the collection, a stale
`ai.collectionConfidence` from the older side would survive and claim a
confidence for an assignment that no longer exists.

So `mergeBookmarks` takes attribution from the same side it took the assignment
from, or drops it:

```ts
result.ai = listSource.ai;
```

Attribution and assignment therefore never disagree.

## Settings surface, and the Organize page

Review and filing used to live in Settings → AI: a Stepper wedged into an
880px dialog, with the accept button clipped off the right edge and the
Stepper's own rail as a stray bright bar down the left of the content. That
was the wrong container for it — suggesting collections and watching Nook file
them is a primary workflow, done by someone actively organizing their library,
not a preference set once and forgotten — so it moved to its own page:
**Organize**, in the dashboard's side nav (a sparkle icon, badged with
`reviewCount` when anything is waiting for review, the unfiled count
otherwise), and reachable from the web app directly at
`/app/dashboard/organize`. Settings → AI is short now: the two switches, the
"Search by meaning" info row, Advanced, and a button to Organize.

The page itself grew a second primary surface on top of the first redesign:
**suggesting collections now means grouping, not just naming.**
`POST /api/ai/clusters/propose` (docs/ai-cloud-contract.md, and see the
`ai-clusters*` rows in "Testing" above for the math and the route behind it)
already knows *which* unfiled bookmarks belong to each group it found, so the
client reviews groups with editable names and a member count, not bare names
a classifier would later have to match bookmarks against one at a time —
and accepting one is not "queue a pass", it *files every member in the same
transaction that creates the collection* (`PUT /api/ai/clusters/accept`).
That is also why the page follows a successful accept with
`host.sync.requestSync()` rather than polling `pending`: there is no queue
depth to watch drain for this action, only a local library that needs to
catch up to what the server already did. Alongside it, a second block —
**Needs your review** — surfaces the guesses the *classifier* made below
`collectionMinConfidence` (`GET /api/ai/review`), each with a plain "Likely"/
"Maybe" word instead of a raw decimal, an accept/reject per row and a bulk
"Accept all likely". The same list backs a small "Suggested: X" chip on
`BookmarkCard`, so a guess can be settled without opening Organize at all.
The taxonomy propose/accept pair this section used to build the whole page
around (`POST /api/ai/taxonomy/propose`, `PUT /api/ai/taxonomy`) is still
here, but demoted to a collapsed **Suggest tags** action: naming new
collections is the cluster flow's job now, so this one only ever reviews and
accepts the *tags* half of what the proposer returns.

Both surfaces require a signed-in session and nothing else, and both are the
**same components on both hosts** — nothing under `settings-dialog/ai/` or
`dashboard/organize/` branches on `host.kind` to decide what is enabled.

That used to need two paragraphs of explanation, and the reason is worth keeping
because the fix is not obvious. There was a time when the section was gated on
`host.kind === "extension"`, because a pass only ran in the extension's service
worker, and the toggles it edited lived in per-origin IndexedDB `meta` — so the
web app showed working-looking switches that nothing read. The first half of
that was fixed by moving the settings onto an account row: `GET`/`PUT
/api/ai/settings`, `apps/api/src/ai-settings.ts`, `nook_ai_settings`, one row
per account. `lib/ai-settings.ts` still keeps a short-lived local cache
(`AI_SETTINGS_META_KEY`) so the panel has something to show instantly and
something to fall back to offline or signed out, but the cache is not the source
of truth.

The second half needed the pass itself to move, and that is what this section
now says. **The queue, the run history and the accepted taxonomy are account
rows too** — `nook_ai_jobs`, `nook_ai_state`, `nook_ai_taxonomy` — so the
run-history rows ("Last run", "Last pass", "Waiting to be classified"), the
**Run now** button and the whole taxonomy review flow are the account's numbers
rather than one browser's, and they work identically in the extension and in the
web app. There is no longer a "where does this actually run?" tooltip because
there is no longer a "this host" to run on.

Two things that are still true, and both are about the panel rather than the
pass:

- A classification is an authenticated server call, so the section needs
  `host.user` (`SettingsDialog.visibleSections`). Signed out, it offers a
  sign-in banner instead.
- **The classifier's own pass can only enqueue.** `POST /api/ai/run` wakes a
  worker rather than running a batch inline, so the toast reports how many
  were queued and the panel re-reads the status every few seconds while
  `pending` is above zero. A toast claiming "18 filed" would be a guess, and
  the copy says so instead of implying it. This is still true of the
  classifier and of the tags-only "Suggest tags" acceptance below — it is
  **not** true of accepting cluster suggestions, which files instantly (see
  above), so the two primary-looking actions on this page report success
  differently on purpose rather than by oversight.

### Structure — Settings → AI

Short, in `apps/extension/src/app/settings-dialog/AiPanel.tsx` and the files
beside it under `settings-dialog/ai/`:

- An **intro line**, plain about what Nook does with AI and that it runs on
  the server rather than in this browser. One **banner** under it
  (`ai/AiOutageBanner.tsx`), only when neither server deployment is configured
  (`ai/shared.ts`'s `outageKind`), instead of repeating "no AI key" on every
  row that happened to need it.
- **File bookmarks automatically** (`ai/AutoFileSwitch.tsx`) — just the
  `autoClassify` switch and a short description now. The **Organize unfiled
  bookmarks now** button, the queue depth and the run history all moved to the
  Organize page below; this row only decides whether the per-minute worker
  tops its queue up from the account's eligible bookmarks at all.
- **Summaries** (`ai/SummariesCard.tsx`, unchanged): the toggle and the
  server-counted rows, with the paragraph explaining what leaves the browser
  behind a collapsed `Collapsible` ("What gets sent").
- **Search by meaning** (`ai/SearchByMeaningRow.tsx`, unchanged): one
  informational row, no toggle — see the pre-existing explanation below.
- **Advanced** (`ai/AdvancedSettings.tsx`, unchanged): the four thresholds —
  collection confidence, tag confidence, max tags, taxonomy language — behind
  a `Collapsible`, collapsed by default, with a **Reset to defaults** button.
- **Open Organize**: a primary button at the bottom. Closes the dialog and
  switches the dashboard to the Organize page (`onOpenOrganize`, threaded from
  `DashboardApp.tsx` through `SettingsDialog` to `AiPanel`).

### Structure — the Organize page

`apps/extension/src/app/dashboard/organize/`:

- **`OrganizePage.tsx`** — the page itself. Reached from the side nav's
  "Organize" item (`LibrarySideNav.tsx`, badged with `reviewCount` when
  non-zero, else the unfiled count — `dashboard/bookmark-utils.ts`'s
  `LibraryView` grew an `{ kind: "organize" }` case that `DashboardApp.tsx`
  renders in place of the bookmark grid/table, rather than filtering it) or
  from Settings' **Open Organize** button. Renders, top to bottom: a header
  (title, one-sentence description, and a progress bar + "N bookmarks filed ·
  M left to organize" line, computed straight from the local library's own
  `listId` — `organize-utils.ts`'s `libraryProgress`); **Suggest collections**
  (primary); **Needs your review**, shown only while there is anything in it;
  **Recently filed**; then a link back to AI settings. Once there is nothing
  unfiled and nothing to review, the first two collapse into one plain
  "Everything is organized" line with a quiet "Suggest again" button, rather
  than three panels each explaining they have nothing to say.
- **`useSuggestClusters.ts`** + **`ClusterProposals.tsx`** — the primary
  "Suggest collections" flow: `idle` → `reading` → `review` → `accepting` →
  `done`, same shape as the state machine below but built around
  `ClusterProposal.memberIds` rather than a bare name. Each proposal in
  `review` is a row with a checkbox (default ticked), an inline-editable name
  (`nameFor`/`rename` — edited text is kept separately from the proposal and
  only substituted in on accept, so the server's own `why`/`sampleTitles`
  never have to be re-fetched over a rename), the member count, the reason,
  and a collapsed "show all" that resolves `memberIds` to titles from the
  *local* library (`clusterMemberTitles`) rather than trusting the server's
  own `sampleTitles` for anything past the collapsed preview — the client
  already holds every bookmark the server could have named. A sticky footer
  (same reasoning as the old review step's, below) reads "Create N
  collections and file M bookmarks", counting only the ticked proposals'
  own `memberIds` rather than trusting `size` to agree with them
  (`tickedClusterCounts`). `unclustered` is reported plainly
  (`describeUnclustered`) rather than folded into the count of what worked.
  Accepting calls `PUT /api/ai/clusters/accept`, then
  `host.sync.requestSync()` and the page's own `onAccepted` (a fresh
  `GET /api/ai/status` and review-list read) — no queue to poll, see above.
- **`useReviewList.tsx`** + **`ReviewList.tsx`** — "Needs your review":
  `GET /api/ai/review` read once into a context (`ReviewListProvider`,
  mounted in `DashboardApp.tsx` above both the page and the bookmark grid) so
  the page's list and every `BookmarkCard`'s "Suggested: X" chip
  (`BookmarkCard.tsx`) share one fetch and one optimistic-update path rather
  than each holding a copy. `resolve()` removes the affected rows from state
  immediately and calls `POST /api/ai/review/resolve`; a failure outcome
  restores them, a success calls `host.sync.requestSync()` only when it
  actually filed something (a pure reject changed nothing the sync layer
  tracks). Confidence never reaches the screen as a number —
  `reviewConfidenceLabel` renders "Likely" at or above 0.6, "Maybe" below —
  and "Accept all likely" resolves every row at or above that same line in
  one call.
- **`useSuggestCollections.ts`** + **`SuggestionReview.tsx`** + **`SuggestTags.tsx`**
  — what is left of the page's *original* primary flow
  (`idle` → `reading` → `review` → `accepting` → `done` against
  `POST /api/ai/taxonomy/propose` / `PUT /api/ai/taxonomy`), now the
  secondary, collapsed **Suggest tags** action: naming collections is
  `useSuggestClusters.ts`'s job, so `tagsOnly: true` drops whatever
  collections the proposer names alongside the tags before they reach
  `state`, leaving `SuggestionReview.tsx`'s "New collections" list with
  nothing to render and `accept()` sending `collections: []` without either
  of them needing to know why. The one behavioural addition from the old
  primary flow survives unconditionally: accepting still makes sure
  `autoClassify` is on and immediately calls `POST /api/ai/run`.
- **`RecentlyFiled.tsx`** + **`organize-utils.ts`** — "Recently filed" reads
  `status.run.log` (last 200 decisions, `{ id, confidence, assigned, at }` —
  see "The job queue" above) and maps `assigned: true` entries onto the local
  library by id, showing title + collection name as dense rows (`Item`, not
  cards). The remaining entries become the plain-language explanation line
  ("25 bookmarks didn't fit any collection. 33 came close, but below your
  confidence setting."). The log carries no collection id and no reason, only
  a confidence — so `remainderCounts` buckets purely on
  `confidence >= settings.collectionMinConfidence`. That happens to be exact,
  not a guess: reading `decideClassification` in `apps/api/src/ai.ts`, the
  `skipped: "low-confidence"` outcome is only ever returned when confidence is
  *below* the threshold, so any unassigned entry at or above it can only be
  `"none-fit"` (the model chose `__none__`, confidently). Below the threshold
  the two outcomes are genuinely indistinguishable from the log alone, but
  both mean the same true thing to the user — "Nook wasn't confident enough" —
  so they're one bucket rather than a guess dressed as two. The estimate
  behind "about N min" (`estimateMinutesRemaining`) assumes ~150 bookmarks a
  minute now, not 25 — the classification tick moved from once a minute to
  once every 10 seconds (see "The rate, and why a 12× faster tick is not a
  cost problem" above).

The old **Status** card is gone as a standalone wall of rows on either surface.
Its numbers live where they're relevant: the queue depth and progress estimate
are the Organize page's own "working" state; the summarise counts stay in the
Summaries card; a missing deployment is either the one top banner (both down)
or a short local note on the one row/step it affects (`outageKind`'s
`"classify"`/`"summarize"` cases) — never both, never repeated per row.

The Summaries card is still the part of this surface this document used to
have to apologise for, and it still does not need to. Its toggle was once a
real field that nothing acted on, and its two rows counted a local library
nothing summarised and dated a last pass nothing wrote; both rows are server
counts — `summarised` and `pending` are SQL counts over the account's records
with the same 400-character gate the pass applies. The toggle's own
description still carries the one thing nothing else on this surface does:
this is the first feature that sends page text to a third party, now folded
into the disclosure above rather than the switch's own paragraph. See
[retrieval.md](./retrieval.md)'s "Summaries" for the pass behind those
numbers.

## Configuration

| variable | where | meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | api, `.env`, `compose.yaml`, `.env.example` | Jev. Without it the panel reports the feature unavailable. |
| `NOOK_AI_PROPOSER` | api | `openai` or `gemini` — which service names the new collections and tags |
| `NOOK_AI_MODEL` | api | which model, when the proposer is OpenAI. Defaults to `gpt-4o-mini` |
| `OPENAI_API_KEY` / `GEMINI_API_KEY` | api, `.env`, `compose.yaml` | the proposer's key |
| `NOOK_AI_TICK_MS` | api | how often the classification worker looks for work. Defaults to 10,000; floored at 1,000 so a typo cannot turn it into a spin loop |
| `NOOK_AI_LEASE_SECONDS` | api | how long a pass may hold the account lease. Defaults to 120 |

## Testing

| file | covers |
| --- | --- |
| `apps/api/test/ai.unit.test.ts` | question building, decision thresholds, response parsing, the text-length floor, throttling, and the review guess — kept only on a low-confidence skip at or above `REVIEW_MIN_CONFIDENCE`, never on an assignment or a `none-fit` decline — pure, no network |
| `apps/api/test/ai-settings.unit.test.ts` | normalizing a stored row, validating a PATCH — pure, no database |
| `apps/api/test/ai-settings.integration.test.ts` | defaults for a new account, patch-merges-onto-existing, per-account isolation, cascade delete — needs `NOOK_TEST_DATABASE_URL`, self-skips otherwise |
| `apps/api/test/ai-classify.unit.test.ts` | reading a `nook_records` row as a bookmark, eligibility, candidate selection, request building from raw jsonb, the patch and its union of tags, the `Noul`/definition asymmetry, `patchChangesSomething`, Turkish-aware name folding |
| `apps/api/test/ai-taxonomy.unit.test.ts` | deterministic stride sampling and its eligibility, the accepted-taxonomy record and the digest behind each collection, the cap, collision handling, `BookmarkList` planning, the stem overlap test, reading the proposer's body |
| `apps/api/test/ai-clusters-math.unit.test.ts` | pure clustering on synthetic data: well-separated blobs recover at 100% purity, scattered noise ends up entirely unclustered, a zero vector is excluded rather than made a cluster of one, near-duplicate clusters merge, a cluster under the size floor is dropped, matching (and not matching) an existing collection's centroid, determinism, and the invariant that every input id ends up in exactly one place |
| `apps/api/test/ai-clusters.unit.test.ts` | `proposeClustersForUser` (too few considered short-circuits before reading anything else, a cluster matched to an existing collection is named with no proposer call at all, the one naming call names every remaining cluster and reports each back by its own id, `ProposerUnavailableError` vs `ProposerCallFailedError`), `acceptClustersForUser` (creates a list and files every member, a name collision files into the live list instead of duplicating it, an explicit `existingListId` wins over a mismatched name, a member no longer live or unfiled is `skipped` not filed, clearing `nook_ai_decided` only when a list was actually created, rollback on failure), and `parseClusterAcceptance`'s caps and strict validation |
| `apps/api/test/ai-jobs.unit.test.ts` | the queue (claim as one DELETE, the enqueue's inline `autoClassify`, the top-up's exclusions), the pass (the pool stopping on a neutral, the 40-character floor *not* stopping it, the gates, the lease, the two cooldowns, never rejecting, upserting a kept guess into `nook_ai_review` in one statement), the write path (the advisory lock and `FOR UPDATE`, the eligibility re-check, the union recompute, tombstones, degrading rather than throwing), the two taxonomy route bodies, the review list (`readReviewList`'s lazy prune predicate and its mapping, `parseReviewResolveRequest`'s validation, `resolveReviewItems`'s accept-via-write-path-and-re-check / reject / stale-guess / gone-collection outcomes), the `AI_TICK_INTERVAL_MS` default, and `tickAiWorker`'s re-entrancy guard |
| `apps/api/test/ai-store.unit.test.ts` | normalizing a run-state row out of anything, the log ring buffer, resolving a cooldown against a clock, and `readAiStatus` composing the whole surface including `reviewCount` |
| `apps/api/test/ai-summary.unit.test.ts` | the work list (a content hash over the source text that excludes `summary`, an unchanged record inside the decline window still parked, a changed hash re-admitted), the outcome-to-window table, the pass (writing through `applyServerWrite`, deleting the attempt row on a write, upserting it on a decline, refusing a write whose guard fails on the fresh row, a lease held by someone else), the `autoSummarize` gate, and the status counts |
| `apps/extension/tests/ai-client.test.ts` | all eight calls: the signed-out gate before any request, bearer vs cookie auth, the status mapping (incl. the two new routes' 503/429/529), defensive reading of every response (a review row missing a bookmark/collection id, a cluster proposal with no name or no members, `size` defaulting to `memberIds.length`), the "nothing to read" vs "declined" distinction, sending a tag definition back with its name, and the status subscription |
| `apps/extension/tests/ai-settings.test.ts` | server fetch/cache/fallback: offline, signed-out, a failed save, cross-context invalidation |
| `apps/extension/tests/settings-ai-panel.test.tsx` | the intro and the one "unavailable" banner, the file-automatically step (**Organize unfiled bookmarks now**, its queue depth and last-pass sentence, that it still queues summaries for a summarize-only account), the summaries card and its collapsed privacy note, the advanced disclosure (thresholds, reset to defaults), the signed-in gate — and, explicitly, that all of it works on the web host with cookie auth |
| `apps/extension/tests/organize-page.test.tsx` | the outage/signed-out/empty states, the cluster-proposal block (counts and samples render, deselecting or renaming a proposal changes the footer label and the `PUT` body, accept calls `host.sync.requestSync()`, "show all" expands past the server's sample), "Needs your review" (a plain confidence word, accept/reject/bulk-accept-likely, optimistic rollback on a failed resolve), the working-progress line at the current rate, recently-filed, and the collapsed "Suggest tags" action offering only tags even though the route also names collections |
| `apps/extension/tests/bookmark-card-review-chip.test.tsx` | the chip renders only for a bookmark actually in the review list, and its accept/reject buttons resolve and remove it |
| `apps/extension/tests/organize-utils.test.ts` | `reviewConfidenceLabel`'s threshold, `reviewRows`/`clusterMemberTitles` mapping onto the local library and dropping an id it doesn't have, the footer-label and unclustered-note copy helpers, `tickedClusterCounts` counting ticked members rather than trusting `size`, and `estimateMinutesRemaining`'s ~150/min rate |
| `apps/extension/tests/cloud-merge.test.ts` | attribution travels with the assignment |

`apps/extension/tests/ai-classify.test.ts`, `ai-runner.test.ts` and
`ai-taxonomy.test.ts` are gone with the files they covered; the first two have
`apps/api/test/ai-classify.unit.test.ts` and `ai-taxonomy.unit.test.ts` in their
place, and the runner's job is now `ai-jobs.unit.test.ts` plus `ai-store`.

## Contract

Exact shapes. Do not drift — these are the seams between the workspaces.

```ts
// apps/extension/lib/types.ts
export interface AiAttribution {
  model: string;                            // "jev-1.13.0"
  at: string;                               // ISO
  collectionConfidence?: number;
  tagConfidence?: Record<string, number>;   // tag name -> noul
  taxonomyAt?: string;                      // ISO of the accepted taxonomy
}

// apps/api/src/ai-settings.ts (AiUserSettings) — the account's row, served by
// GET/PUT /api/ai/settings. apps/extension/lib/ai-settings.ts (AiSettings) is
// the client-side copy of the same shape, kept in sync by hand like the other
// duplicated wire types in this file; IndexedDB `meta` key "ai.settings" is
// now only that client's short-lived cache, not the source of truth.
export interface AiSettings {
  /** Feature 1: file into existing collections and add existing tags. */
  autoClassify: boolean;
  /** Feature 2: propose brand-new collection names and a tag vocabulary. */
  autoTaxonomy: boolean;
  /** Feature 3: write a short summary on bookmarks long enough to need one. */
  autoSummarize: boolean;
  collectionMinConfidence: number;   // default 0.75
  tagMinNoul: number;                // default 0.80
  maxTags: number;                   // default 3
  taxonomyLanguage: TaxonomyLanguage; // default "auto"
}
```

```ts
// GET /api/ai/settings -> AiUserSettings (defaults when the account has never
// written a row).
// PUT /api/ai/settings <- Partial<AiUserSettings> (a patch: only the fields
// being changed) -> AiUserSettings (the full row, after the patch is merged
// server-side — apps/api/src/ai-settings.ts, saveAiUserSettingsPatch).
```

```ts
// POST /api/ai/classify — still the seam between the decision layer and the
// model, and still the route whose neutral 200 is shaped exactly like a
// decision. Nothing in either client calls it any more; the worker calls
// classifyBookmarkOutcome() in-process, which is exactly what the route did.
interface ClassifyRequest {
  bookmark: { id: string; title?: string; summary?: string; note?: string; site?: string; author?: string };
  collections: Array<{ id: string; name: string; samples: string[] }>;
  // `samples` is carried on the wire and is always empty for a tag: see the
  // Noul/Choice asymmetry above. A member-less accepted tag carries `definition`
  // instead, and that one *is* sent.
  tags: Array<{ name: string; samples: string[]; definition?: string }>;
  settings: { collectionMinConfidence: number; tagMinNoul: number; maxTags: number };
}
interface ClassifyResponse {
  model: string;
  collection: {
    assign: boolean;
    id: string | null;         // null when !assign
    name: string | null;
    confidence: number;
    probabilities: Record<string, number>;
  };
  tags: Array<{ name: string; noul: number }>;   // already thresholded and capped
  skipped?: "none-fit" | "low-confidence";
  // The top choice, kept rather than thrown away, when `skipped ===
  // "low-confidence"` and confidence still clears REVIEW_MIN_CONFIDENCE (0.35)
  // — see "Review list". Never present alongside "none-fit", never for a
  // choice the collections array didn't offer, and never changes `collection`
  // above: assign stays false, id stays null.
  guess?: { id: string; name: string; confidence: number };
  usage?: { inputTokens: number; outputTokens: number };
}

// POST /api/ai/propose-taxonomy — likewise the proposer's own route. The
// client-facing proposal route is /api/ai/taxonomy/propose below.
interface ProposeTaxonomyRequest {
  sample: Array<{ title: string; site: string }>;
  existingCollections: string[];
  maxCollections: number;   // default 8
  maxTags: number;         // default 20
}
interface ProposeTaxonomyResponse {
  collections: Array<{ name: string; why: string }>;
  tags: Array<{ name: string }>;
}
```

Both of those routes remain, and both remain session-guarded. Neither is
client-facing now: the pass is in the same process as the model call, so it calls
`classifyBookmarkOutcome` and `proposeTaxonomy` from `apps/api/src/ai.ts`
directly rather than over HTTP. The panel reaches the feature through the four
routes below.

### The four routes the pass moved in on

Exact shapes in [ai-cloud-contract.md](./ai-cloud-contract.md); summarised here
because `AiPanel.tsx` and `ai-client.ts` are written against them.

```ts
// GET /api/ai/status -> AiStatusResponse
//   available: boolean; settings: AiUserSettings; pending: number;
//   taxonomy: AcceptedTaxonomy; run: AiRunSummary; summarize: SummarizeStatus;
//   reviewCount: number
// The two cooldown stamps are resolved to booleans on the wire (isUnavailable,
// isBackingOff): "when" is a thing only the worker acts on, and "is it in effect
// now" is the only thing a panel can render. `reviewCount` is additive, like
// `summarize` — the same count GET /api/ai/review's `total` reports, read here
// with no pruning side effect so a panel polling this route every few seconds
// isn't also sweeping nook_ai_review that often. 401 (no session) and 200.

interface SummarizeStatus {
  /** Whether a summariser is configured: NOOK_AI_PROPOSER plus its key. */
  available: boolean;
  /** The model a call would use, defaults included. */
  model: string;
  /** Candidates waiting to be summarised. SQL count, gate applied. */
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

// POST /api/ai/run <- {} (body ignored)
//   -> { queued: number; summariesQueued: number; status: AiStatusResponse }
//   Tops both work lists up and wakes the worker. It does NOT run a pass inline.
//   Each half is gated on its own toggle, so a user with one of them on gets only
//   that one — and a queue depth is not a pass result. 401 and 200.

// POST /api/ai/taxonomy/propose <- { language?: TaxonomyLanguage }
//   -> { sampleSize: number; collections: {name, why}[];
//        tags: {name, why?, coveredBy: string[]}[];
//        existingCollections: string[] }
//   The server samples its own library, so the client sends no sample.
//   401, 400 (malformed body / unknown language), 503 (no proposer configured), 200.

// PUT /api/ai/taxonomy <- { collections: string[]; tags: {name, definition?}[] }
//   -> { createdCollections: number; addedTags: number; dropped: number;
//        taxonomy: AcceptedTaxonomy }
//   Names only — the sample, the existing lists and the library's own tags are
//   read from nook_records at acceptance time. A tag's definition travels with
//   its name because the server cannot reconstruct it. 401, 400, 200.

// GET /api/ai/review -> { items: AiReviewItem[]; total: number }
//   Only rows whose bookmark is live and still unfiled (listId still null)
//   and whose guessed collection is still live; highest confidence first,
//   limit 200. `total` is the count before the limit. Lazily prunes stale
//   rows as a side effect of the read — see "Review list". 401, 200.
interface AiReviewItem {
  bookmarkId: string;
  listId: string;
  listName: string;
  confidence: number;
}

// POST /api/ai/review/resolve
//   <- { items: Array<{ bookmarkId: string; action: "accept" | "reject"; listId?: string }> }
//      1 to 200 items. `listId` overrides the stored guess's collection on an
//      accept; omitted, the guess itself is used.
//   -> { filed: number; rejected: number; skipped: number }
//   accept files through the same write path a classification decision uses,
//   re-checking the fresh row is still unfiled; a bookmark filed meanwhile is
//   `skipped`, not `filed`. reject only deletes the review row — the
//   bookmark stays in nook_ai_decided so it is never re-billed. The review
//   row is deleted either way. 401, 400 (malformed body), 200.
```

`SummarizeStatus` is additive, so a panel written against the old surface keeps
working by ignoring it, and it comes from the same seam as the rest of the file:
[ai-summarize-contract.md](./ai-summarize-contract.md). `POST /api/summarize`,
which used to sit beside these and returned summaries for a caller to write, is
**gone** — its documented contract was that the server never writes `summary`, and
that is no longer true. `summarizeRecords` survives in-process; the reasons are
in [retrieval.md](./retrieval.md).

The duplicated wire types on this seam are the ones
[ai-cloud-contract.md](./ai-cloud-contract.md) defines and
`apps/extension/lib/ai-client.ts` re-declares by hand: `AiLogEntry`,
`AiRunSummary`, `AcceptedTaxonomy`, `AiStatus`, `TaxonomyProposal`,
`TagProposal`, `AcceptedTagInput`, plus the two discriminated outcomes
(`ProposeOutcome`, `AcceptResult`) that exist only on the client so the panel can
render a different sentence per failure. The api workspace has no dependency on
the extension and these seams are not worth a cross-package coupling, so they are
kept in step by hand like every other duplicated wire type in this file — this
document is what makes them agree.

`__none__` is a reserved `Choice` option key for "no collection fits". It is an
implementation detail of `buildClassificationQuestions`, not part of the wire
contract.

Two response details that are not in the vendor's documentation and are
load-bearing here:

- A `Noul` answer carries **no `confidence` and no `probabilities`**, so
  `AiAttribution.tagConfidence` is populated from the noul value. The field name
  is a slight misnomer; the type is right.
- Every `probabilities` value comes back **rounded to two decimal places**, so
  they cannot be used for a fine-grained threshold or a runner-up margin, and
  should not be stored for later re-thresholding. `AiAttribution` deliberately
  keeps only `confidence` and the chosen name.

Error statuses, as observed rather than as documented: a bad key is **401**, a
missing auth header is **403**, and a malformed request is **400** or **422**
depending on what is wrong with it. The route's own statuses are 401 (no
session), 400 (malformed body), 429 (upstream throttling), 503 (`TYPESAFE_API_KEY`
not configured) and 200.

`GET`/`PUT /api/ai/settings` is simpler: 401 (no session) and 200. There is no
503 — the settings row itself has no external dependency, unlike a
classification — and a `PUT` with an invalid field (wrong type, an unknown
`taxonomyLanguage`) is 400 rather than silently defaulted, so a client bug
shows up immediately instead of writing a value nobody asked for.

## Progress notes

Appended as work lands. **Read the tail before changing thresholds or the
decision rules** — a calibration result may have already been measured.

- **2026-09-25 — calibration run against the live service.** 57 hand-labelled
  real bookmarks, 699 requests, ~$0.07. Full write-up in
  [ai-calibration.md](./ai-calibration.md). Findings folded into this document:
  - `collectionMinConfidence` default `0.85` → **`0.75`**. `0.75` files 22 (20
    correct) against `0.85`'s 15 (13 correct) for the *same* count of 2 wrong
    assignments. `0.85` bought no safety, only 17 correct answers the model had
    already gotten right. `0.75` dominates it in all four request shapes tested.
  - The **per-tag sample digest was removed** from the `tag::*` `Noul`s. It cost
    58% of the request's tokens and roughly halved tag recall. A test now pins
    the asymmetry so nobody "fixes" it back.
  - A **40-character floor** was added before the request. 39 of a real
    1,061-bookmark library carry less state text than that; 15 carry less than
    20. They were costing a full request each to return a coin flip.
  - The **Turkish-language hypothesis was disproved** (p = 0.67). See
    "Non-English content" above, which now says so explicitly.
  - `__none__` turned out to be the model's *most* confident answer
    (median 0.99), so the feature's safety rests on the option, not the
    threshold.
  - Cost figures corrected from 800 tokens / `$0.17` to the measured
    1,466 / `$0.31` per 5,000.
- **2026-09-26 — a throttled server no longer looks like a decided bookmark.**
  The server's neutral placeholder is a 200 shaped exactly like a decision
  (`confidence: 0`, no tags, no `skipped`), so a persistently throttled Jev key
  produced 200s that the client accepted, wrote into `ai.log` as
  confidence-0 verdicts, and pushed into the cursor — permanently retiring
  bookmarks the model never saw. Two changes: the classify route now propagates
  **429** once upstream throttling survives its retries, and the runner treats
  `model: "unavailable"` as a non-decision regardless. A 503 no longer sets
  `lastError`, because it is a deployment state and the panel already had a
  calmer "unavailable" status that `lastError` was shadowing.
- **2026-09-27 — two Turkish text bugs, both found by running it for real.** A live
  proposer run produced a tag called `i̇ş yönetimi ve crm`: `toLowerCase()` maps
  "İ" to "i" plus a *combining dot*, so the name carried an invisible character
  that no user can type back and no dedupe or stem comparison downstream can
  match. Fixing that with a whole-string Turkish locale then broke the opposite
  way — "UI" became "uı" — because this library mixes English initialisms with
  Turkish nouns in the same string. The fix folds **per word**, choosing the
  locale by looking for a Turkish-specific letter, which makes it idempotent in
  both directions: "ÇAĞRI" and "çağrı" now land on the same key instead of on
  "çağri" and "çağrı", which never matched each other. Both normalisers (server
  and client) are pinned by tests.
- **2026-09-27 — a setting for the naming language, and a model that had to be
  measured rather than chosen.** See "What the proposer is actually like" above.
  The short version: `Match my library` won, `gpt-4o-mini` won, and the tag
  vocabulary cap went back up to 20 because the lower value was silently dropping
  tags the user had ticked.
- **2026-09-26 — tag generation finished, and it was the missing half.** The
  proposer had been returning tag names since the taxonomy flow landed, and the
  client had been reading them off the response and dropping them: nothing could
  offer a tag no bookmark carried, so the whole idea was inert. `ai.taxonomy`
  now carries a `tags` vocabulary and `buildTagOptions` appends it after the
  library's real tags, so a member-less tag earns its first member the ordinary
  way. Verified on the live service: a zero-member vocabulary put
  `yazılım geliştirme` on 20 of 60 real bookmarks in one pass. Also measured and
  recorded above: the proposer is not deterministic, and its collection names
  overlap the tag names it proposes for the same theme.
- **2026-09-26 — AI settings scoped to the extension.** Found while finishing
  the taxonomy flow: `ai.settings`, `ai.taxonomy` and the status counters live
  in per-origin IndexedDB `meta`, which does not sync, and the runner only runs
  in the extension's service worker. The web host therefore had working-looking
  toggles that nothing read. The section is now gated on
  `host.kind === "extension"`. Known limitation, not yet acted on: the web app
  can read the library but cannot trigger a pass, so an extension-less user has
  no way to classify at all.
- **2026-09-26 — taxonomy flow completed.** `lib/ai-taxonomy.ts` samples
  unfiled bookmarks with a deterministic stride, calls
  `POST /api/ai/propose-taxonomy`, and the panel reviews the proposals before
  turning accepted ones into real `BookmarkList` records plus the
  `ai.taxonomy` record the runner already knew how to read. The proposed **tag**
  vocabulary was returned but not stored at this point; see the entry above.
- **2026-09-26 — settings moved off the extension, closing the limitation two
  entries up.** `ai.settings` is now an account row (`GET`/`PUT
  /api/ai/settings`, `apps/api/src/ai-settings.ts`, `nook_ai_settings`) instead
  of per-origin IndexedDB `meta`, so Settings → AI shows on both hosts and a
  toggle flipped in the web app is the same toggle the extension's runner reads
  before every tick. `lib/ai-runner.ts` fetches it fresh every tick (through
  its own already-DI'd `fetch`/session, not the module-level cache) rather than
  trusting a possibly-stale cached read, so a run always acts on the newest
  saved value; `aiIsArmable()` in `entrypoints/background/index.ts`, which asks
  on every saved bookmark, goes through the module-level default instead, which
  now keeps a 60-second in-memory cache so importing a library one bookmark at
  a time doesn't turn into one request per bookmark. What did **not** move:
  `ai.taxonomy` and the run counters (`ai.cursor`, `ai.log`) are run history the
  extension-only runner reads back, not a user-facing setting, so they stay
  per-origin `meta` — `AiPanel.tsx` hides the run-history rows on the web host
  rather than rendering a confident "Never" next to a feature the connected
  extension may actually be running. The still-open half of the old
  limitation stands: an account with no browser extension installed at all can
  turn a toggle on from the web and nothing will ever act on it, because the
  classification queue itself is still extension-only. That is unchanged by
  this entry and is a bigger seam than a settings move — see "How the pieces
  fit".
- **2026-09-27 — the classification pass moved to the server.** The runner, the
  queue, the processed-id cursor, the accepted taxonomy and the cooldowns all
  moved to `apps/api` (`ai-jobs.ts`, `ai-store.ts`, plus the ported
  `ai-classify.ts` / `ai-taxonomy.ts`); the `nook-ai-classify-periodic` and
  `nook-ai-classify-soon` alarms, the `CLASSIFY_NOW` message and every call
  site in the service worker are gone. What the extension kept of this feature
  is `lib/ai-client.ts` and the settings panel, and the reason it kept exactly
  that is that everything else in it is now an account row or a table the server
  already writes. Both halves of the limitation the entry above left open are
  closed: a taxonomy accepted on the web reaches the classifier, because the
  classifier reads `nook_ai_taxonomy` rather than a per-origin IndexedDB key; and
  an account with no extension installed at all can classify, because the queue
  is fed by the sync hook rather than by an alarm that needs a browser to be
  open. A pass now continues with every browser closed. See "How the pieces
  fit", "The job queue" and "The write path"; the wire shapes are in
  [ai-cloud-contract.md](./ai-cloud-contract.md).
- **2026-09-27 — the 40-character floor was a bug, not a neutral case.** This is
  the important one, and it only became visible once the pass was reading the
  library itself. `classifyBookmarkOutcome` returns the neutral
  `UNAVAILABLE_MODEL` placeholder for a bookmark whose state text is under
  `MIN_CLASSIFIABLE_CHARS` — a *per-bookmark cost guard*, and a legitimate
  answer, not a failure. The deleted `ai-runner.ts:514` treated that same
  `model === "unavailable"` as a terminal `unhealthy` and **stopped the whole
  pool**. So one bare X post, one emoji, one author handle silently ended the
  pass and burned the rest of the batch, and this document's own numbers say how
  likely that was: 39 of a real 1,061-bookmark library are under the line, 15
  are under 20, and the *newest* saves are the most likely to be one. The
  runner was collapsing three unrelated conditions into a single check — a
  missing key, a genuine upstream failure, and a legitimate skip — and a client
  cannot tell them apart, because all three are the same 200.
  Server-side they are separable and now are: the floor is applied to the
  request *before* any call is dispatched, an under-floor candidate is counted as
  skipped and remembered in `nook_ai_decided` (we have read it, it will never be
  worth another look), and the batch carries on. A genuine `UNAVAILABLE_MODEL`
  still stops the pool, which is now the only thing that does. This is the
  check introduced in the 2026-09-25 entry above, extended by the 2026-09-26
  entry that made `model: "unavailable"` a non-decision rather than a confidence-0
  verdict: **the check was right and its scope was wrong.** A client could not
  fix it, and "do not move this check back into the response handling" is written
  into the code beside the fix, because it is exactly the kind of thing that
  gets "simplified" into existence — with a symptom that looks like nothing at
  all rather than like an error: a classification feature that quietly files
  nothing on a library full of tweets.
- **2026-09-27 — `nook_ai_decided`, and the money the cap was leaking.** The
  old runner's memory of "we already bought a decision for this" was a list of
  ids in `ai.cursor`, capped at **2,000** — and a cap on that list leaks money,
  because a decision that assigned nothing writes nothing to the record, so the
  id list was the only memory of it. Past the cap the oldest ids were dropped,
  and candidates are taken newest-first, so those came back only once everything
  newer was resolved: on a library of a few thousand undecided bookmarks every
  one of the oldest was re-bought forever, because nothing about them ever
  changed. The document used to leave that implicit. The memory is a table now,
  unbounded and durable, and the leak is closed because the thing that leaked was
  the cap rather than the idea. It is deliberately not a field on
  `nook_records`: a write would bump the version, push a no-op change to every
  device and resurface the bookmark as freshly edited — the exact harm the
  capped cursor existed to avoid, 2,000 times instead of once. The table is not
  in [ai-cloud-contract.md](./ai-cloud-contract.md); it is in `schema.sql`, with
  the argument.
- **2026-09-27 — tag definitions travel on acceptance.** The contract originally
  said the acceptance body carries **names only**, on the reasoning that
  everything else can be read from `nook_records` at acceptance time. That is
  true of the sample, the existing lists and the library's own tags, and it is
  false of a tag's definition: the proposer wrote it, the review list is the
  last place it exists, and `buildTagOptions` cannot invent it. This document's
  own measurement is what caught it — definitions put **12 of 12** vocabulary
  entries to use against **10 of 12** for bare names, at 24% more input tokens —
  so dropping it on the way in is a measured regression. `definition` is optional
  on the body — a proposer that returned no `why` still yields a usable tag, just
  one asked about by bare name — so what the contract requires is that the client
  sends it back whenever it has one, not that it is mandatory. The asymmetry is
  worth stating honestly rather than papering over: a *collection*'s `why` is
  genuinely lost on acceptance, and provably does not matter, because it only
  ever rendered in the review list and the digest that backs an accepted option
  is derived from the library, not from the sentence.
- **2026-09-27 — `autoClassify` gates the queue, not just the pass.** The
  `autoClassify` guard is read *inside* the enqueue statement, on both the sync
  hook and the top-up, which is the behaviour a user expects from a toggle: a
  queue that fills while the switch is off and drains the moment it is on,
  rather than a backlog that lands all at once. The second half of that is
  honesty on the panel's side. `pending` is shown as a number of bookmarks the
  server is working through, and with the guard in the enqueue it can never be a
  queue that cannot drain — a row that arrived before the toggle was turned off
  is not something the user can see or clear, and a count of those would be a
  number nobody could act on.
- **2026-09-27 — summarisation was not moved, and does not work.** Unchanged by
  this migration, and recorded here so the absence is not mistaken for an
  oversight. `autoSummarize` is still a real field of the account's settings row
  and the toggle still saves it, but **nothing runs it**: `POST /api/summarize`
  has no caller in either host, and the panel's local-library counting and its
  `ai.summary-run` seam are gone — the two rows that counted a library nothing
  summarises and dated a "last pass" nothing wrote are removed rather than
  reworded, because a row that can only ever report a constant is noise and a
  number is a claim. The card and the toggle stay, and its description says
  plainly that nothing fills summaries in yet. It is the same seam it was before
  the move and it is still the next one; [retrieval.md](./retrieval.md)'s
  "Summaries" section should be read with that in mind, since it describes work
  that is measured but unwired.
- **2026-09-27 — summarisation runs now, and the entry above ("summarisation was
  not moved, and does not work") is superseded.** Read this one instead of it.
  `autoSummarize` was a real field of the account's settings row, a switch in
  Settings → AI on both hosts, and a preference nothing had ever acted on: there
  was no pass, and the panel's `ai.summary-run` cursor was a documented seam
  nothing wrote. It runs on Nook's server now, **on** the machinery above rather
  than beside it — the same per-minute tick, the same `nook_ai_state` for run
  history, the same `applyServerWrite`, and a second lease column so the two
  passes cannot starve each other for one. The work list is a read rather than a
  queue, and its rule is the one in [retrieval.md](./retrieval.md): no summary,
  past the 400-character gate, and either nothing was ever attempted on this
  exact text or the last attempt was long enough ago to be worth repeating.
  "Exact text" is a sha256 over `title`, `description` and `note` and
  **deliberately not over `summary`**, and that exclusion is the mechanism rather
  than a detail: a hash over the record would move on every write, so a write
  could present itself as a change in the source and the memory would never
  suppress anything. `nook_ai_summaries` is deliberately **not** `nook_ai_decided`
  — a permanent "already tried" marker is right for a decision that may be bought
  once ever and wrong for a field the user is allowed to clear, because it would
  make a summary undeletable, which is worse than re-billing it. So a written
  summary **deletes** its row, and only a refusal or a failure keeps one, on one
  of two windows: a model that read the text and declined gets **7 days**
  (`NOOK_AI_SUMMARY_DECLINE_MS`), a call that failed gets **30 minutes**
  (`NOOK_AI_SUMMARY_RETRY_MS`). Five of the seven skip reasons are not attempts
  and leave no row at all, so a description that later grows past 400 characters
  is picked up on the very next tick rather than a week later. **The one honest
  cost of the design is a latency:** the candidate query cannot compute the hash —
  Postgres has no sha256 for text without an extension, and doing it in SQL would
  mean re-implementing the prompt's field order and caps in a second language — so
  it filters on the short window only, and a note you edited is summarised again
  once its attempt is 30 minutes old rather than instantly. The opposite
  approximation would park that note for seven days, which is a visible bug, and
  newest-first ordering means a fresh save is never the thing that waits.
  `POST /api/summarize` is **removed**: its documented contract was "the server
  does not write `summary` anywhere", and a route that computes summaries and
  discards them is a trap for the next reader. `POST /api/ai/classify` and
  `POST /api/ai/propose-taxonomy` stay, and stay session-guarded — the asymmetry is
  deliberate, because those are the model calls the pass makes and the pass is in
  the same process as the model. Cost, on the record: **≈$0.00026 a bookmark**
  against classification's **$0.000062**, so about 4×, **≈$0.43** over 5,000
  bookmarks a third of which clear the gate, bounded by the library rather than by
  the tick, and with no spend cap because embeddings and classification have none
  either. And it is the first feature here that sends **page text** to a third
  party — up to 4,000 characters of the description, the title and the note, where
  taxonomy sends titles and hostnames — which is why the toggle now carries that
  sentence on its own face rather than leaving it to a document.
- **2026-09-28 — the review list, and a tick fast enough for it to matter.**
  Production data on a real account: after accepting 8 collections, the pass
  filed 17 of 75 bookmarks and left ~33 more with a plausible top collection
  under the confidence threshold — a guess `decideClassification` already
  computed and threw away outright (`collection.id` is `null` on a
  `skipped: "low-confidence"` response either way). Two changes, landed
  together because the second makes the first worth having sooner:
  - `decideClassification` now keeps that guess as `guess: { id, name,
    confidence }` on the response, above a new floor, `REVIEW_MIN_CONFIDENCE`
    (0.35), that decides whether a number is worth showing a human at all
    rather than whether to file anything — filing is unchanged either way. A
    new table, `nook_ai_review`, and two new routes, `GET /api/ai/review` and
    `POST /api/ai/review/resolve`, are the only things that read or act on it;
    see "Review list" above for the full account, including why the table is
    pruned lazily rather than on the reconciler's schedule and why `accept`
    reuses `applyServerWrite` rather than a second write path.
  - `AI_TICK_INTERVAL_MS` dropped from 60,000 to 10,000. The once-a-minute
    figure was never a cost guard — cost is per bookmark, and `nook_ai_decided`
    is what makes billing per-bookmark safe regardless of tick rate — it was an
    unexamined holdover from the extension's own polling cadence. ≈150
    bookmarks a minute now, not 25; a 1,000-bookmark backlog clears in roughly
    7 minutes instead of roughly 40. This is also why `tickAiWorker` gained a
    re-entrancy guard: a tick busy enough to outlive 10 seconds was rare at the
    old cadence and is not rare at this one, and while nothing about an
    overlap could have double-billed (the claim is one atomic
    `DELETE ... RETURNING`, and a second tick reaching an account mid-pass
    fails `acquireRunLease` and returns before claiming anything), an
    unguarded pile-up would still re-run the accounts query and a doomed lease
    attempt per account for as long as the slow tick kept running, and could
    let two overlapping ticks each believe they were the 15-minute reconcile
    tick. See "The tick and its ceiling".

