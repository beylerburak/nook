# AI classification

Nook classifies saved bookmarks into your existing collections and tags using
[TypeSafe AI](https://typesafe.ai)'s **Jev** model. Two independent features, both
toggled in Settings → AI.

| Feature | What it does |
| --- | --- |
| **File into collections** | Every new bookmark is placed into one of your existing collections, or left alone. |
| **Grow the taxonomy** | Suggests brand-new collection names and a tag vocabulary from your library, then files into those. |

Both are off by default. Classification is a background pass; it never blocks
saving a bookmark.

## How the pieces fit

```
extension (the only host where a pass can run)
  lib/ai-settings.ts    toggles + thresholds, IndexedDB `meta` key `ai.settings`
  lib/ai-classify.ts    PURE: pick candidates, apply a decision, build the patch
  lib/ai-runner.ts      queue: batches, concurrency, backoff, alarm + cooldown
  lib/ai-taxonomy.ts    sampling, proposals, creating BookmarkList records
  src/app/settings-dialog/AiPanel.tsx    the whole settings surface
  entrypoints/background/index.ts        the 5-minute alarm, and "Classify now"
        |
        |  POST /api/ai/classify          one bookmark  -> one decision
        |  POST /api/ai/propose-taxonomy  library sample -> new taxonomy
        v
apps/api (the only place with secrets)
  src/ai.ts             Jev + proposer calls, thresholds, pure decision helpers
  src/server.ts         the two routes, session-guarded
```

`lib/ai-classify.ts` and `lib/ai-taxonomy.ts` are deliberately free of `fetch`,
IndexedDB and `chrome.*` — every decision they make is unit-testable with no
browser. `ai-runner.ts` and the impure half of `ai-taxonomy.ts` take their
`fetch` and clock as injectable dependencies for the same reason.

Writes go through `NookDB.updateBookmark(id, patch)`, which stamps `updatedAt`
and fires `notifyChange()`. Cloud sync and cross-context refresh then take care
of themselves — there is no separate sync path for AI.

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
handle, and 39 of a real 1,061-bookmark library fall under that line.

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
means each bookmark is billed at most once, ever.

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
  -> POST /api/ai/propose-taxonomy   (a cheap text LLM — gpt-4o-mini or gemini-2.5-flash)
  -> preview in Settings: checkboxes + a one-line "why" per proposal
  -> you accept; real BookmarkList records are created
  -> meta["ai.taxonomy"] records each accepted name with its sample titles
  -> the normal engine runs; the new collections are just more options
```

Trigger: the **Suggest taxonomy** button in the panel, plus the `autoTaxonomy`
toggle that gates it.

The proposer returns **two** vocabularies, and both are offered for review:

- **Collections**, which become real `BookmarkList` records. They are exclusive:
  one bookmark, one collection.
- **Tags**, stored as a flat vocabulary in `ai.taxonomy.tags` — see below.

### Tags that have no members yet

This is the part that is easy to get wrong. The runner builds its tag questions
from the tags bookmarks *already* carry, so **a proposed tag with no members
could never be offered by any code that existed** — the first version of this
feature generated them, parsed them, and dropped them on the floor.

The fix is one field. `ai.taxonomy.tags` holds names nothing carries yet, and
`buildTagOptions` appends them after the library's real tags, capped at 20
questions. A new tag then earns its first member the ordinary way — the model is
asked `Does this saved item belong under the tag "yazılım geliştirme"?` and
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

Settings and progress live in the IndexedDB `meta` store, which survives
`wipeLocalLibrary()` — these are device preferences, like appearance.

| key | holds |
| --- | --- |
| `ai.settings` | toggles and thresholds |
| `ai.taxonomy` | accepted taxonomy: `collections` (name + sample titles each) and `tags` (names with no members yet) |
| `ai.cursor` | processed ids, counters, last run, cooldown windows |
| `ai.log` | last 200 decisions, for the confidence histogram |

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

## Settings surface

Settings → AI is **extension-only**, and requires a signed-in session. Both
conditions are real, not caution:

- A classification is an authenticated server call, so it needs `host.user`.
- The pass runs in the extension's **service worker** and authenticates with the
  bearer token the cloud-sync bridge writes. The web app has no service worker
  and authenticates by cookie, so a toggle there would write `ai.settings` to a
  per-origin meta store that nothing on that origin ever reads. The section is
  hidden on the web host rather than offering a switch that visibly does
  nothing. `ai.taxonomy` and the status counters are inert there for the same
  reason, and meta does not sync — only bookmarks and lists do.

The panel carries two toggles, three thresholds, a status row, a **Classify now**
button, and the taxonomy review flow. See `AiPanel.tsx`.

## Configuration

| variable | where | meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | api, `.env`, `compose.yaml`, `.env.example` | Jev. Without it the panel reports the feature unavailable. |
| `NOOK_AI_PROPOSER` | api | `openai` or `gemini` — which service names the new collections and tags |
| `NOOK_AI_MODEL` | api | which model, when the proposer is OpenAI. Defaults to `gpt-4o-mini` |
| `OPENAI_API_KEY` / `GEMINI_API_KEY` | api, `.env`, `compose.yaml` | the proposer's key |

## Testing

| file | covers |
| --- | --- |
| `apps/api/test/ai.unit.test.ts` | question building, decision thresholds, response parsing, the text-length floor, throttling — pure, no network |
| `apps/extension/tests/ai-classify.test.ts` | candidate selection, patch building, manual-assignment protection |
| `apps/extension/tests/ai-runner.test.ts` | batching, toggle off, session required, cooldowns, the neutral-placeholder guard |
| `apps/extension/tests/ai-taxonomy.test.ts` | deterministic stride sampling, collision handling, BookmarkList creation |
| `apps/extension/tests/settings-ai-panel.test.tsx` | toggles, thresholds, proposal review, and the extension-only gate |
| `apps/extension/tests/cloud-merge.test.ts` | attribution travels with the assignment |

## Contract

Exact shapes. Do not drift — these are the seams between the four pieces.

```ts
// apps/extension/lib/types.ts
export interface AiAttribution {
  model: string;                            // "jev-1.13.0"
  at: string;                               // ISO
  collectionConfidence?: number;
  tagConfidence?: Record<string, number>;   // tag name -> noul
  taxonomyAt?: string;                      // ISO of the accepted taxonomy
}

// apps/extension/lib/ai-settings.ts — IndexedDB `meta` key "ai.settings"
export interface AiSettings {
  /** Feature 1: file into existing collections and add existing tags. */
  autoClassify: boolean;
  /** Feature 2: propose brand-new collection names and a tag vocabulary. */
  autoTaxonomy: boolean;
  collectionMinConfidence: number;   // default 0.85
  tagMinNoul: number;                // default 0.80
  maxTags: number;                   // default 3
}
```

```ts
// POST /api/ai/classify
interface ClassifyRequest {
  bookmark: { id: string; title?: string; summary?: string; note?: string; site?: string; author?: string };
  collections: Array<{ id: string; name: string; samples: string[] }>;
  tags: Array<{ name: string; samples: string[] }>;
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
  usage?: { inputTokens: number; outputTokens: number };
}

// POST /api/ai/propose-taxonomy
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
