# Retrieval and bookmark intelligence

Two features built on one idea: a bookmark's text is worth indexing, and once
it is, several things become cheap.

- **Search** — currently one `String.includes()` over a concatenated string
  (`lib/retrieval.ts`, `matchesSearch` — it moved out of `bookmark-utils.ts` so `lib` never imports from `src`). Measured against the real
  library, six natural Turkish or English queries returned **zero** substring
  matches and the right results semantically.
- **Summaries** — `shortDescription` is a mechanical truncation to 180
  characters. A long article is unreadable in the library list because of it.

MCP and an agent chat are deliberately **out of scope** here. See "Later" at the
bottom.

Related reading: [ai.md](./ai.md) (the classification feature this sits beside)
and [ai-calibration.md](./ai-calibration.md) (the measurement discipline this
follows — every threshold below was measured, not guessed).

## Measured cost

Run against the live OpenAI API over the real library — 1,047 indexable
bookmarks, **189,219 input tokens**, in 5.0 seconds.

| | |
| --- | --- |
| Embed the whole library, once | **$0.0038** |
| Re-embed one bookmark | $0.0000036 |
| 100 new bookmarks a day for a year | **$0.13** |
| One search query | $0.00000013 |
| 10,000 searches | **$0.0013** |
| Summarise the whole library, once | **$0.028** |

A second pass over the same library cost **0 embedded in 0.01s** — no provider
request at all. That is the entire cost argument: the content hash means a
bookmark is embedded once, on the pass where its text actually changed.

There is no budget worth managing. What is worth managing is latency and rate
limits, so the embedder batches — 128 inputs per request, not one call per
bookmark, because a whole-library cap of 25,000 would blow the provider's
300,000-token-per-batch ceiling on the worst case.

> These figures were wrong the first time and the error is worth recording: the
> first version of this table said 77,008 tokens, from a 3.2 characters-per-token
> estimate. Measured, it is **2.93** — a BPE ratio is not 3.2 for this content,
> and the estimate was off by 2.5×, not by a rounding error. See
> [retrieval-measurements.md](./retrieval-measurements.md).

## Why `text-embedding-3-small`, and what "better" means

TR-MTEB (Findings of EMNLP 2025) is the first standardised Turkish embedding
benchmark, and its numbers split exactly along the line this feature needs:

| model | dim | mean | retrieval | STS |
| --- | --- | --- | --- | --- |
| **text-embedding-3-small** | 768 | 66.61 | **64.99** (best) | **70.85** (worst) |
| multilingual-e5-large | 1024 | 66.82 | 60.62 | 81.18 |
| paraphrase-multilingual-mpnet-base-v2 | 768 | 61.71 | 49.27 | 82.18 |

It does not collapse on Turkish — on retrieval it is the strongest model
measured. It is the weakest on *similarity*, which matters only if the library is
ever clustered into a taxonomy without a generative model naming the clusters.
Search is retrieval, so this is the right model, and at 768 dimensions it is also
the cheapest.

"Positioned for better" is therefore not "bigger model". It is:

1. **`model`, `dim` and a content hash stored beside every vector**, so changing
   model or dimension is a background re-embed, not a migration. This is the
   decision that keeps a future quality upgrade cheap.
2. **Dimension truncation available now.** The same 1,055 texts cost the same at
   1536, 768 and 256 dimensions — 13.0 MB, 6.5 MB, 2.2 MB — so storage is a dial
   rather than a commitment.
3. **One model per index**, enforced by every query filtering on `model`. Two
   models in one column are not searchable together.
4. **Measure on this library before shipping**, which is how every threshold in
   `ai.md` was set, and how the two Turkish casing bugs were found.

## Storage: a separate table, and why

Embeddings are **derived data**. The bookmark is authoritative and already lives
in `nook_records.data`; a vector can be recomputed from it at any time. So the
vector does not go in the JSONB, because that table is the sync protocol's
carrier for authoritative user data and the sync contract deliberately stays
narrow (`kind IN ('bookmark','list')`, a 512 KB per-record cap). A vector in
there would be 6.5 MB of recomputable data replicated to every device on every
change, to save nothing.

```sql
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

CREATE INDEX IF NOT EXISTS nook_embeddings_user_model_idx
  ON nook_embeddings (user_id, model);
```

**No pgvector, and no extension at all.** At 1,061 rows a brute-force cosine in
Node is under a millisecond, and lexical matching is `ILIKE` over one column. The
raw-SQL, zero-dependency style of this repo is a better fit than a new Postgres
image. pgvector arrives when the library is big enough for it to matter, as an
index on a column that already exists.

### The summarisation pass's own memory is server-side too

Summarising adds two more pieces of server-side state, and neither is synced,
which is the same rule as the vector: a fact about our own requests is not the
bookmark.

- `nook_ai_summaries` — one row per bookmark that was **attempted and produced
  nothing**, holding a sha256 of the prompt's own text, when the attempt
  happened, and which of the two retry windows applies to it. It is not a queue
  and it is deliberately not a field on `nook_records`: a written summary
  *deletes* its row, so a record carrying a summary holds no memory of having
  been asked, and that is what keeps a cleared one re-summarisable. Rows whose
  bookmark is gone are pruned on the reconciler's cadence.
- `nook_ai_state.summary_lease_until` — the pass's lease, beside the
  classification pass's `lease_until`. Two columns rather than one: a shared
  lease at a 60-second tick would have the two passes starving each other for
  it, they write different fields, and the advisory lock the write path takes
  already serialises the writes that could genuinely conflict.

Every table and column the pass uses is enumerated in the "Storage" table of
[ai.md](./ai.md); the rule these two serve is in "Summaries" above.

### The content hash must cover the embedded text, not the record

`updatedAt` changes when a tag is edited, a note is added, a sync lands — none of
which change what was embedded. Hashing the *record* would re-embed the library
on every tag edit. The hash is over the exact string that was sent to the
embedding model, and nothing else.

## How the index gets built

The API already receives every bookmark through `POST /api/sync`, so the index
needs **no new client code at all**. After `syncRecords` commits, the applied
bookmark records whose embedded text changed are queued.

- **In-process queue**, small concurrency, so a sync response is never delayed by
  an embedding round trip.
- **Reconciliation pass** on startup and periodically, which finds rows that are
  missing or whose `content_hash` no longer matches. The queue alone loses work
  on a restart; the pass is what makes it eventually correct.
- **Batched provider calls** — the whole library in one request.
- A bookmark that has never been indexed is simply not findable yet. It appears
  within a second of being saved, and the reconciliation pass is the backstop.

## Search

Two signals, fused. Not one, because measured semantic-only search misses exact
terms: the query "veritabanı performans sorunu" returned a top hit at 0.44 about
performance in an unrelated sense.

- **Lexical** — every whitespace-separated term must appear in `search_text`.
  Exact, accent-insensitive because the column is pre-folded.
- **Semantic** — cosine over `vector`.
- **Fusion** — Reciprocal Rank Fusion, `1 / (k + rank)`, summed. Rank-based, so
  the two scores never have to be commensurable, which matters because one is
  cosine and the other is a boolean.

```ts
POST /api/search
{ q: string, limit?: number, collections?: string[]; tags?: string[]; sources?: string[] }
->
{ results: Array<{ id: string; score: number; lexicalRank: number | null; semanticRank: number | null }>,
  total: number }
```

Results are **ids and scores, not content**. The client already holds the whole
library in IndexedDB; shipping 1,061 documents back over the wire to display a
filtered list of them would be waste. A future MCP surface reads the same rows
directly from Postgres.

Client behaviour, which is the part that decides whether this is usable:

- `@author` and `#tag` prefixes **stay local**. They are exact, instant and
  offline, and they already work.
- A bare query shows local substring results immediately, then replaces them with
  server results. No spinner, no empty list while a request is in flight.
- Signed out, offline, or a server with no index configured: the local pass is
  the whole answer, and the UI does not pretend otherwise.

## Turkish, measured rather than assumed

[ai.md](./ai.md) records that Jev is **not** weaker on Turkish (p = 0.67), which
disproved the fear the vendor's docs invite. The embedding model is a separate
question and it was measured separately.

| group | n | substring | semantic | hybrid |
| --- | --- | --- | --- | --- |
| Turkish, exact term | 3 | 100% | 67% | **100%** |
| English, exact term | 1 | 100% | 50% | **100%** |
| Turkish, paraphrase | 5 | 3% | 19% | **20%** |
| English, paraphrase | 5 | 0% | **65%** | **65%** |

**A 45-point gap, and it is not a Turkish weakness.** The evidence is a matched
pair: q06 `yapay zekayla web sitesi yapmak` and q12 `make websites using AI` are
the same request in two languages, and they score **2/6 and 2/6 — identical.** The
aggregate gap comes from which queries happened to get written.

The mechanism is vocabulary mismatch, and it is demonstrable. Three Turkish posts,
each searched twice — once with the post's own Turkish words, once paraphrased
away from them:

| target | query in the post's own words | rank | paraphrased | rank |
| --- | --- | --- | --- | --- |
| `mediaanalysisd` | `mediaanalysisd disk alanı cache` | **1** | `yapay zekanın diskte bıraktığı önbellek` | 14 |
| `Aider RepoMap` | `Aider RepoMap büyük codebase` | **2** | `yapay zekanın kafası karışıyor` | 126 |
| `GPT Image 2` | `GPT Image 2 prompt koleksiyonu` | **1** | `ücretsiz görsel prompt listesi` | 1 |

With the content's own vocabulary the target is rank 1 in all three. The clearest
single case: `tasarım sistemi` finds 1 of 9 design-system documents, because
**nine records in this library say "design system" in English and not one says
"tasarım sistemi" in Turkish.** The user has to guess the content's own wording.

So the honest statement is: Turkish **exact** search is perfect, Turkish
**paraphrase** search is weak, and the cause is a library written in mixed
technical vocabulary rather than a model that cannot read Turkish. A Turkish user
searching for something they saved in English should search the English. The
caveat is five paraphrased queries per language, which is thin, and this is
recorded as a known limit rather than a settled result.

## Summaries

Jev cannot generate text — that is the same constraint that put a generative
model in the taxonomy flow. Summarisation uses the configured proposer service.

- **One or two sentences, plain text, no preamble.** The prompt's real job is
  fighting a model that opens by referring to the artifact.
- **In the content's own language**, not the naming language. A Turkish article
  gets a Turkish summary regardless of what the taxonomy is called. Measured:
  **0 of 57 in the wrong language**, 36/36 Turkish and 21/21 English.
- **Only where it earns its place**, gated at `description.length > 400`. That is
  at least 220 characters the library row does not show, and 400 is a judgement
  about how much *unseen* text a summary is worth — not a measured number. On this
  library the gate passes **241 of 1,061**, and every one of them is an X post:
  **no web capture passes it**, the longest being 251 characters, so the article
  case this was written for cannot be tested here.

### A pass now runs, on the server

All of the above used to describe a capability with no runner. It has one now, on
the same machinery as classification in [ai.md](./ai.md) — the same per-minute
tick, the same account-row lease machinery (a second column beside the first, so
the two passes cannot starve each other), the same conflict-safe write, the same
account row for run history. **"The job queue" in that document is where the
machinery is described**; this section is only about what is specific to
summarising. The work list, the tick, the lease and the write path are all
shared, and none of them was written twice to accommodate a second pass.

Three things about where the work comes from:

- **The work list is a read, not a queue.** There is nothing to insert: a
  candidate is a candidate at every moment, so the pass asks `nook_records` for
  the next 25, newest first, and takes them. Classification needs a table because
  a decision is bought once and the queue row is how that is enforced. Here the
  record itself is the claim and the attempt table is the memory of what has
  already been asked about.
- **The tick is once a minute** — the same `NOOK_AI_TICK_MS` clock as
  classification — and a pass continues with **every browser closed**, which is
  the point of having moved at all. A bookmark that clears the gate is summarised
  within a minute or two of landing, with nothing installed and nothing awake.
- **The toggle gates the work list, inside the query.** `autoSummarize` is read
  in the same statement that finds the candidates, for the same reason
  `autoClassify` is read inside the classification enqueue: the decision has to
  be the newest one, and the number the panel shows can then never be a queue
  that cannot drain. Turned off, "waiting" is zero however many pages would
  qualify, and the copy on that row says so instead of showing a count nobody
  could act on.

### The work list, and what it remembers

> A live bookmark is a candidate when it has no summary, its `description` clears
> the existing length gate, and either **nothing has ever been attempted on this
> exact text** or **the last attempt was long enough ago to be worth repeating**.

That is the `planEmbeddingWork` discipline already in
`apps/api/src/embeddings.ts` — hash the text you send, not the record — applied
to prose instead of vectors. The 400-character gate, `isWorthSummarising` and
`summarySkipReason` are the existing, tested rules, reused unchanged; the
arithmetic above still holds and the gate is still what it was.

"Exact text" is a **sha256 content hash over `title`, `description` and `note`**
— the three fields the prompt actually reads. Not the record, and **not
`summary`**, and that exclusion is the mechanism rather than a detail: a hash
taken over the record would move every time a summary landed on it, so every
write would present itself as a change in the source and the memory would never
suppress anything. Hashing the prompt's own text makes it answer exactly one
question, which is *have we already asked about this?* — the only question it is
there to answer.

The two directions are different, on purpose:

- **Writing a summary never makes the record a candidate again.** The hash does
  not move, so our own write cannot chase itself.
- **Editing your note does.** The hash moves, the record is a candidate again,
  and that is right: you changed what you saved, and the summary on the record is
  now of something else.

### Clearing a summary still works

`apps/extension/lib/types.ts` says `null` and `""` both mean "no summary", so a
cleared one is summarised again rather than merged as a permanent blank. That is
deliberate, it is unchanged, and an unattended pass depends on it — a feature
that puts back a summary the user deleted an hour ago is a bug that looks like a
haunting.

It is worth being precise about the two mechanisms, because they are easy to
conflate and only one of them is what makes the delete work:

- **The hash** stops our own write from looking like a change in the source. It
  is a statement about whether *the text* changed.
- **Deleting the attempt row when a summary is written** is what keeps a cleared
  summary re-summarisable. The row is written only for an attempt that produced
  nothing, and a written summary deletes it, so a record that has a summary
  carries no memory of having been asked. Keeping the row instead would freeze
  the record for the length of the retry window: the user clears it and nothing
  happens for half an hour, or for a week. Same haunting, with a delay.

**The second one is the one that matters for the user**, because it is the whole
difference between "clear it and the server starts again" and "clear it and the
server ignores you". The hash is what keeps the bookkeeping honest; the deleted
row is what keeps the promise.

The hash is deliberately *not* re-checked at the write. It does not need to be: a
concurrent edit does not falsify a statement about what we asked, and it makes
the *next* pass re-ask, which is the next pass's job.

### Two retry windows, not one

`nook_ai_summaries` is one row per bookmark that was **attempted and produced
nothing**, and it stores which of two windows applies to it. They are two
different answers, and conflating them is the expensive mistake:

- **The model declined** (`empty-output`, stored as `declined`): it read the text
  and had nothing to say about it. The text does not change on its own and the
  same question gets the same empty answer at full price, so this is not a retry
  policy at all — it is the bill. **`NOOK_AI_SUMMARY_DECLINE_MS`, 7 days by
  default.**
- **The call failed** (`failed`: a transport error, a 429, a dropped socket):
  nothing was learned about the text, and this is emphatically not the model's
  opinion of it. **`NOOK_AI_SUMMARY_RETRY_MS`, 30 minutes by default** — the same
  short window a throttled classification call gets.

Five of the seven skip reasons are **not attempts** and leave no row at all:
`too-short`, `already-summarised`, `not-found`, `deleted`, `unavailable`. No call
was made, so there is nothing to remember, and a row would *invent* a memory. The
case that matters is `too-short`: a 380-character description is refused by the
gate, and if refusing it left a row behind then a record the user later extended
past 400 characters would sit unexamined for a week. `unavailable` is the same
argument at the scale of the account — the pass-level cooldown already parks the
whole account for an hour, and a per-record row for every candidate would only
hide a deployment state behind dozens of identical rows.

The window is measured from the **attempt**, not from when the work was noticed,
which is why the row is written on the outcome rather than at top-up time. Rows
whose bookmark is gone or tombstoned are pruned on the reconciler's 15-minute
cadence, beside `pruneDecided` and for the same reason.

### The one honest limitation: an edited note waits

The candidate query can only see the **short** window. Postgres has no sha256 for
text without an extension, and computing one in SQL would mean re-implementing
the prompt's own field order, its per-field caps and its `shortDescription`
fallback in a second language — a second copy of a rule that has to be identical
to the first, drifting invisibly the moment a cap moved. So the query excludes a
record whose attempt is inside the short window and leaves the rest to the plan,
which does have the hash.

**The consequence: a bookmark whose note you edited is summarised again once its
last attempt is `NOOK_AI_SUMMARY_RETRY_MS` old — up to 30 minutes — rather than
instantly.** It is not instant and should not be described as instant.

The direction is the safe one. The opposite approximation — filtering on the long
window in SQL so the query could see declines too — would park an edited note for
**seven days**, and "I rewrote the note and the summary never caught up" is a
visible bug. Thirty minutes of latency on a background pass is not. It is also
bounded: the work list is ordered newest-first, so a fresh save is at the front
of the next tick's read and is never the thing that waits. The price of this
choice is one extra SELECT per declined record per tick, which is a read and not
a request.

### The write path, and the argument it overturned

Summaries are written through `applyServerWrite` — the same extracted mechanism,
the same `pg_advisory_xact_lock` a sync takes, the same `FOR UPDATE`, the same
re-check of the caller's guard on the row re-read inside the lock, the same
version bump. See "The write path" in [ai.md](./ai.md). There is exactly one
difference inside it: a summary is a replacement rather than a union, so its
patch is the same whatever the fresh row says, where a classification patch has
to be recomputed from that row so a tag the user added in the meantime survives.
The guard is still there, and it is what catches a summary that arrived from
another device or another replica while the call was in flight.

`apps/api/src/summarize.ts` carried a long comment arguing that the server must
**not** write `summary` anywhere, and that argument has been overturned rather
than deleted — the file walks through what happened to it, reason by reason. The
short version: **the rule that made all four of those reasons fit together was
that the client owns the write, so the device which asks holds the record the
merge is computed over**, and that stopped being true the moment the pass stopped
running in the extension's service worker. The one durable part of the old
argument — that a summary is user-visible prose the user is allowed to clear — is
still true, and it is exactly what the work-list rule above is built around. The
deletion hazard the old comment was reaching for is now handled by re-reading the
row under a lock rather than by not writing at all, which is a stronger answer
than the one it replaced.

### Cost, and what leaves the machine

**This is the first feature in the product that sends page text to a third
party.** Taxonomy sends titles and hostnames. Classification sends titles, a
300-character preview, notes, hostnames and an author handle. A summary sends up
to **4,000 characters of the page's own text**, plus the title and your note, to
whichever provider `NOOK_AI_PROPOSER` names — OpenAI or Google. That is a
materially larger surface than anything else in Settings → AI, and the settings
copy says so **on the toggle itself** rather than in a document: a user flipping
that switch is handing over their reading history, and that sentence belongs
where the switch is, next to the two other things the row tells them (it acts on
its own, with the browser closed, and any summary can be deleted afterwards).

Cost, at `gpt-4o-mini` ($0.15/1M in, $0.60/1M out): a call is roughly 1,000–1,300
input tokens and about 100 output, so **≈$0.00026 a bookmark** — about **4×** the
$0.000062 a classification call costs, and **bounded by the library rather than by
the tick**, because the cost is per bookmark and not per pass. A full pass over
5,000 bookmarks with about a third of them clearing the gate is **≈$0.43**. This
library is much cheaper than that shape, and the two numbers are not in
contradiction: the measured pass in the cost table above is **$0.028** over its
241 gate-passing records, $0.0001153 a record, because those are X posts averaging
roughly 1,100 user-prompt characters — about 486 prompt tokens a record — while
the figure above is sized for the 4,000-character cap the prompt allows
([retrieval-measurements.md](./retrieval-measurements.md)). The per-bookmark
number is the worst case, and the one to size a bill against.

**There is deliberately no spend cap, and no per-account budget.** Embeddings and
classification have none either, and a cap introduced for one feature and not for
the others is a worse surprise than the bill it prevents — the user would find
out by hitting it. The controls are the batch (`NOOK_AI_SUMMARY_BATCH`, 25 a
pass, clamped to the per-call ceiling of 50) and the decline memory, which is
what stops a library of long X posts being re-bought every half hour forever. The
documented per-bookmark cost is the rest of the disclosure.

### The route that is gone

**`POST /api/summarize` was removed.** Its documented contract was *"the server
does not write `summary` anywhere, and that is the design"*, and after this
change that sentence is false. A route that computes summaries and hands them
back for somebody else to write, with no caller in either host to preserve it, is
a trap for the next reader. `summarizeRecords` survives — the worker calls it
in-process. `MAX_IDS_ACCEPTED` (50) is unchanged and is now the worker's per-pass
ceiling rather than a route's framing, which is the same number for the same
reason: one pass is one window of work, not a library.

`POST /api/ai/classify` and `POST /api/ai/propose-taxonomy` **remain**, and both
remain session-guarded, and neither is called by either client any more. That
asymmetry is deliberate rather than tidiness: those two routes are the model calls
the pass makes, the pass is in the same process as the model, and a route for
each would be a second way in that nothing uses. `POST /api/ai/run` is the one
button, it gates each half on its own toggle, and it now returns both queue
depths — `queued` and `summariesQueued` — so the toast reports what was queued
and never claims that either pass happened.

### The preamble, and why it was a prompt problem

Forbidding the obvious labels changed nothing: **53 of 57 outputs (93%) still
opened by naming the artifact** — "Bu sayfa, …", "The page introduces …" — which
`cleanSummary` could not touch, because it requires a colon or dash and these
used a comma.

The tempting fix is to add "bu sayfa" to the label list. **It is the wrong fix.**
Stripping "Bu sayfa," off "Bu sayfa, Google'ın yeni modelini tanıtarak …" leaves
a dangling participle about the page, which reads worse than the preamble did.
A preamble wearing a sentence's clothes has to be forbidden, not laundered.

So the system prompt now says not to refer to the thing being summarised at all,
and names the symptom. Re-measured on 30 fresh long-form bookmarks: **3%**, down
from 93%. `cleanSummary` fired 3 times in 57 and every one was the length cap, not
a label.

### What summarising actually got right

57 real calls, hand-labelled: **50 accurate, 6 vacuous, 1 misleading, 0 invented
facts.** The invented-fact count is the one that matters most, since a user reads
a summary in a list and trusts it, and it is zero.

```ts
// apps/extension/lib/types.ts — TOP-LEVEL, deliberately not inside `ai`.
summary?: string | null;
```

`summary` is top-level rather than a field of `AiAttribution` because the two are
set independently, and `ai` is merged as a unit: `cloud-merge.ts` takes it from
whichever side supplied the `listId`, so a summary written to an unfiled bookmark
would be silently dropped the moment another device assigned it to a collection.
A top-level field gets its own newer-wins merge, which is the right rule for
"the newest summary of this bookmark wins".

## Configuration

| variable | meaning |
| --- | --- |
| `NOOK_EMBEDDING_MODEL` | default `text-embedding-3-small` |
| `NOOK_EMBEDDING_DIM` | default `768`; free to lower, since truncation is not re-billed |
| `NOOK_SUMMARY_MODEL` | the summariser's **own per-feature override, and it still wins**; with it unset the call uses the configured `NOOK_AI_MODEL`, and failing that `gpt-4o-mini` |
| `NOOK_AI_PROPOSER` | `openai` or `gemini` — which service the summariser and the taxonomy proposer call. `NOOK_AI_PROPOSER` plus its key is also what the status row's `available` reports, so a missing key reads as a deployment rather than as an error |
| `OPENAI_API_KEY` | already present, shared by the proposer and the embedder |
| `NOOK_AI_SUMMARY_BATCH` | bookmarks summarised per pass. Defaults to 25, and clamped to the per-call ceiling of 50 so an over-eager value is refused rather than silently truncating every pass |
| `NOOK_AI_SUMMARY_RETRY_MS` | how long a **failed** call is remembered before that text may be asked about again. Defaults to 30 minutes |
| `NOOK_AI_SUMMARY_DECLINE_MS` | how long a text the model **declined** is remembered. Defaults to 7 days |

Every one optional. With none of them the search route reports the index as
unavailable and the client keeps its local pass; and with no proposer configured
the status row reports `available: false`, the panel says the server has no
summariser, and a pass makes no model call at all rather than reporting summaries
that were never bought. The tick interval and the lease are shared with the
classification pass and are in [ai.md](./ai.md)'s Configuration table.

## Tests

| file | covers |
| --- | --- |
| `apps/api/test/embeddings.unit.test.ts` | text extraction, folding, hashing, batching, degradation — no network |
| `apps/api/test/retrieval.unit.test.ts` | RRF, lexical term handling, filters, empty library — no network, no DB |
| `apps/api/test/summarize.unit.test.ts` | prompt shape, the length gate, stripping preambles — no network |
| `apps/api/test/ai-summary.unit.test.ts` | the work list and what it remembers, the two retry windows, the pass and its write — no network, no DB |
| `apps/extension/tests/retrieval.test.ts` | debounce, local-then-server ordering, signed-out and offline fallbacks |
| `apps/extension/tests/cloud-merge.test.ts` | `summary` merges independently of `ai` |
| `apps/extension/tests/settings-ai-panel.test.tsx` | the summary status rows, the unavailable-versus-error states, and the third-party disclosure on the toggle |

## Progress notes

Appended as work lands. **Read this before changing a threshold, the cap, or the
prompt** — several of them were wrong on first write and a measurement found it.

- **2026-09-26 — the candidate cap was silently dropping the newest bookmarks.**
  `MAX_CANDIDATES` was 1,000 against a 1,047-row library, the reads order by
  `bookmark_id` for a stable tiebreak, and ids are snowflakes — so `LIMIT` kept
  the *oldest* 1,000 and discarded the 47 newest, which are also the longest, so
  it was a length bias as well. Nothing reported it. Now 25,000, and the response
  carries `truncated: true` when the cap binds, because a cap that may lie is
  worse than no cap. This is also the honest trigger for pgvector.
- **2026-09-26 — a semantic floor, because nonsense used to look like success.**
  "847291" returned 1,047 results topped by a post reading "ai legal", at 0.41.
  The `minScore = 0` default was justified in a comment by a 0.44 top hit on
  "veritabanı performans sorunu" — a later measurement established that nothing in
  this library is about database performance, so that number was a coincidence
  being read as a result. Floor is now 0.40; nonsense queries return
  `{ results: [], reason: "no-matches" }`.
- **2026-09-26 — the summary prompt, not the summary cleaner.** 93% of real
  summaries opened by naming the artifact ("Bu sayfa, …"), and `cleanSummary`
  could not remove it. Adding those phrases to the label list would have been
  wrong: it leaves a dangling participle. The prompt now forbids referring to the
  artifact, and the rate is **3%**. See "The preamble, and why it was a prompt
  problem".
- **2026-09-26 — the cost table was wrong by 2.5×** because of a
  characters-per-token estimate (3.2, measured 2.93). Embedding the library is
  **$0.0038**, not $0.0015. Search cost was over-stated 3×, so it was one stale
  token count rather than a pricing error. And "one request, 8.4s" is really
  **9 batches, 5.0s**, because a whole-library cap of 25,000 would exceed the
  provider's 300,000-token-per-batch ceiling on the worst case.
- **2026-09-26 — verified end to end against the live stack.** 1,047 bookmarks
  indexed in 5.0s; a second pass embedded **0** in 0.01s, which is the content
  hash doing its job; "Seedance" ranked 1 on *both* signals; "847291" returned
  nothing. Full numbers in [retrieval-measurements.md](./retrieval-measurements.md).
- **2026-09-26 — one claim in this document was retracted by measurement.** The
  hybrid was justified with "veritabanı performans sorunu", which turns out to
  have no correct answer in this library. The real evidence for fusing two
  signals is `Seedance` and `CodeMender`, and it is narrower than claimed: when
  the lexical pass finds nothing, hybrid *is* semantic-only.

## Later, deliberately not now

- **pgvector**, when brute force stops being free.
- **MCP** — `search_bookmarks`, `get_bookmark`, `add_tag`, `save_bookmark`. It
  needs a token an agent can hold, which is a decision about `user` and
  `session` tables, not a UI question.
- **An agent chat** over the same `retrieve()`.
- **Clustering** the library without a naming step, which is the one job
  `text-embedding-3-small` measured worst at, and the reason a different model is
  on the table.
