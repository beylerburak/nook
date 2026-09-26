# AI calibration

A measurement run against the live Jev service, on 57 real bookmarks from the
production library, with 57 of them hand-labelled first. This file exists
because [ai.md](./ai.md) says a calibration pass is needed before the
thresholds are trusted, and because the Progress notes say to read the tail
before changing a threshold.

The short version: **Jev reads Turkish fine, and the `0.85` default should come
down, not up.** The single most damaging thing in the request is not the
threshold at all — it is the per-tag sample digest, which costs 58% of the
tokens and destroys tag recall.

## What ran

| | |
| --- | --- |
| date | 2026-09-25, 22:25 UTC |
| endpoint | `POST https://api.typesafe.ai/v1/systemone` |
| model requested | `jev-latest` |
| **model reported** | **`jev-1.13.0`** |
| items classified | 57 |
| requests, total | 699 |
| requests accepted and billed | 657 |
| total spend | about **$0.07** |

`GET /v1/models` lists only the two aliases. `jev-latest` was released
2026-09-10 and currently resolves to `jev-1.13.0`; `jev-preview` resolves to
the same id. Sending the pinned id `jev-1.13.0` works and answers identically,
so the version can be pinned if these thresholds are ever going to be
re-measured.

### Where the data came from

**The real library, not a fixture and not synthetic.** The live Postgres in
`compose.yaml` was reachable on `127.0.0.1:15481`, and `nook_records` held 1,061
non-deleted bookmark rows (1,050 from X, 11 saved from Chrome, created between
2024-09-14 and 2026-09-25). Every query was wrapped in
`BEGIN TRANSACTION READ ONLY`. Nothing was written.

The 57 items in the labelled set were drawn from that library, read one by one,
and labelled by hand. No item was invented.

### The taxonomy is not the real one

This is the most important caveat in the file and it is not a footnote.

The live library has **one collection** (named `Testo`, holding one bookmark)
and **twelve tagged bookmarks** using two tag names (`web`, `claude`). There is
no real taxonomy here to measure against. So the taxonomy used in this
experiment was constructed, from what the library's content actually looks
like, to be a plausible four-collection / seven-tag shape:

| id | name | member titles in the digest |
| --- | --- | --- |
| `l_ai` | Yapay Zeka | 8 |
| `l_design` | Tasarım | 8 |
| `l_dev` | Geliştirme | 8 |
| `l_infra` | Sistem ve Altyapı | 8 |

| tag | |
| --- | --- |
| `claude` | `open-source` |
| `türkçe` | `ücretsiz` |
| `shadcn` | `web` |
| `mcp` | |

The digest titles are real library rows, none of which are in the labelled set,
so nothing leaks. Two of the `l_infra` digest members are Chinese and French,
which is realistic and appears to cause no trouble.

Every accuracy number below is therefore a property of *this taxonomy applied
to this library*. A real taxonomy with eight collections, overlapping topics
and a thinner `__none__` rate will behave differently, and mostly worse.

### Four request shapes

`docs/ai.md` specifies the request; `apps/api/src/ai.ts` implements it. The
implementation landed while this run was in progress, so the run was repeated
against both, plus two controls:

| arm | collection criteria | tag questions | tokens/call |
| --- | --- | --- | --- |
| **shipped** | `name — contains: ` + 5 titles at 90 chars, `\|` joined | structured `{tag, covers, question}` with the digest repeated in `criteria` | **3,478** |
| digest-inline | same | one plain sentence, digest interpolated | 2,569 |
| **no-digest** | same | one plain sentence, no digest | **1,466** |
| wide | 8 titles at 160 chars, one per line, with a header | one plain sentence, no digest | 2,284 |

The collection Choice is byte-identical across the first three arms, so it acts
as a control: **75.4% top-1 in all three.** Only the tag questions move.

Unless a table says otherwise, the rest of this file reports the **shipped**
arm, because that is the code that exists.

## Ground truth

57 items, labelled before any call was made. 33 Turkish, 22 English, 2 with no
text at all. 39 easy, 7 medium, 11 hard. 42 have a collection, 15 belong
nowhere.

### The 15 that belong nowhere

Deliberate, and mostly not because of language. These are the items the
`__none__` option exists for:

| item | why |
| --- | --- |
| best TV series of all time | entertainment |
| a photo of a portable 5G router | hardware |
| installed a Switch emulator, playing Zelda | gaming chatter |
| an FM26 skin and stadium patch | gaming |
| a singer closed a restaurant named after his ex-wife | news |
| a child in Gaza playing among the rubble | news |
| the video editor profession is dying | opinion, no artifact |
| how to get your first thousand users for free | growth advice, not a tool |
| Translumo, live subtitles for a Korean drama | **the one judgement I am unsure of** |
| "Dark mode" | two words |
| "ai legal" from an account whose handle reads like a designer | two words and a misleading handle |
| a handle and nothing else | media-only bookmark |
| a single emoji | media-only bookmark |
| "It is so COOL" | media-only bookmark |
| "🙃 Based" | media-only bookmark |

The last six are not judgement calls. After the state filter they reduce to a
title with no content, and there is nothing to classify. **This is the finding
the taxonomy feature should care about most**, and it is not a language
problem — the library is full of media-only bookmarks and the design has no
guard for them.

Translumo is my least confident label in the set. It is a real program, so
`l_dev` is defensible; it is written as a tip for watching television. If the
model files it, I would not call that a clear error, and it is the single
largest source of uncertainty in the numbers below.

### The hard cases

Eleven items where two collections were defensible. The pattern is consistent
enough to be worth naming: **every one of them is an AI item that is really
about the artefact rather than the model.**

- a terminal for juggling AI CLIs, filed `l_ai` although it is a terminal
- a ready-made Claude Code prompt for cleaning an Android TV over ADB
- Opus 4.6 designing directly in Figma
- Gemini 3.1 Pro generating website designs
- a list of thousands of free APIs
- Cloudflare's AI site scanning
- an AI chat app for Next.js on shadcn/ui
- a Google CLI with skills and an MCP server
- an OpenAI embedding release
- eleven words about storing dates as floats
- "herkes AI ile UI tasarımı yaparken"

The model got 3 of these 11 right. Every one of the 8 it got wrong was a
`l_ai` item it placed in a neighbouring collection, or a `l_design` item it
placed in `l_ai`. The model's default move on an ambiguous AI item is to reach
for `l_ai`, because `l_ai`'s digest is the largest and most distinctive of the
four.

## Results

Top-1, before any threshold, across all four arms:

| arm | top-1 | tokens/call |
| --- | --- | --- |
| shipped | **75.4%** (43/57) | 3,478 |
| no-digest | **75.4%** (43/57) | 1,466 |
| wide | **82.5%** (47/57) | 2,284 |
| names only, no digest at all | 66.7% (38/57) | 975 |

The digests in the collection Choice are doing real work. Replacing the shipped
5×90-character digest with names only costs 8.7 points of top-1. That confirms
the claim in [ai.md](./ai.md) that carrying member titles "is what lets one
call suffice" — it is worth the tokens. The `wide` arm shows a *richer* digest
(8 titles, 160 chars, one per line under a header) is worth a further 7 points
over the shipped 5×90, for 800 fewer tokens than the shipped shape. That is a
free improvement if the format is ever revisited.

### Collection threshold sweep, shipped shape

`filed` counts items assigned. `wrong` is the number that matters: a wrong
assignment is a bad filing the user has to undo, and it is much worse than a
miss. 42 items had a right answer available.

| threshold | filed | correct | **wrong** | missed | recall | precision |
| --- | --- | --- | --- | --- | --- | --- |
| 0.00 | 40 | 30 | 10 | 4 | 71.4% | 75.0% |
| 0.50 | 30 | 25 | 5 | 13 | 59.5% | 83.3% |
| 0.60 | 29 | 25 | 4 | 13 | 59.5% | 86.2% |
| 0.70 | 25 | 22 | 3 | 17 | 52.4% | 88.0% |
| **0.75** | **22** | **20** | **2** | **20** | **47.6%** | **90.9%** |
| 0.80 | 18 | 16 | 2 | 24 | 38.1% | 88.9% |
| **0.85** (current default) | 15 | 13 | 2 | 27 | 31.0% | 86.7% |
| 0.90 | 13 | 12 | 1 | 29 | 28.6% | 92.3% |
| 0.95 | 7 | 7 | 0 | 35 | 16.7% | 100% |

**`0.75` strictly dominates the current `0.85`.** Same number of wrong
assignments, five more correct filings, +16.6 points of recall. The sweep is
identical in the other two shipped-shaped arms.

The other three arms agree: 0.75 gives 2 wrong against 0.85's 2 wrong, in every
arm. `0.85` is not buying any safety here. It is only buying fewer filings.

### The miss/misfile tradeoff, stated plainly

At `0.85` the feature files 15 of 42 fileable bookmarks. **Two thirds of the
time it does nothing, and the two thirds it skips are not the two thirds that
were hard** — they are spread evenly across the confidence range.

At `0.50` it files 30 and gets 25 right, 5 wrong. That is the shape a user
would notice and dislike: five bookmarks quietly sitting in the wrong
collection, no signal that anything happened, and no way to tell which five.

There is no threshold that is both safe and useful here. Between 0.50 and 0.75
the wrong count goes 5 → 2 and the correct count goes 25 → 20. The knee is at
0.75. Below it you are buying wrong assignments with correct ones, one for one.

### Where the misses actually come from

At `0.85`, of the 27 items that could have been filed and were not:

| reason | shipped | wide |
| --- | --- | --- |
| the model picked the right collection, under the threshold | **17** | 15 |
| the model said `__none__` | 4 | 3 |
| the model named a different collection | 6 | 5 |

**Seventeen of the 27 are recoverable by lowering the threshold.** The threshold
is rejecting answers the model got right. That is the whole argument for
lowering it, and it is a much better argument than anything about language.

### Confidence does separate right from wrong — but not `__none__`

Median confidence when the top-1 answer was right: **0.92**. When it was
wrong: **0.59**. That is a clean separation and it is the mechanism the
threshold relies on. It works.

The histogram shows where it is weak:

| confidence bucket | n | correct |
| --- | --- | --- |
| 0.2–0.3 | 1 | 1 |
| 0.3–0.4 | 3 | 1 |
| 0.4–0.5 | 6 | 3 |
| 0.5–0.6 | 4 | 2 |
| 0.6–0.7 | 5 | 5 |
| 0.7–0.8 | 4 | 3 |
| 0.8–0.9 | 8 | 7 |
| 0.9–1.0 | 18 | 17 |

Everything below 0.7 is close to a coin flip. Everything above is trustworthy.
The threshold should sit in the gap, which is 0.7–0.8, not at 0.85.

### `__none__` is the most confident answer the model gives

This is the finding that most changes how `__none__` should be handled.

| group | n | median confidence |
| --- | --- | --- |
| items that **do** have a collection | 42 | 0.78 |
| items that fit **nowhere** | 15 | **0.99** |

The model is *more* certain when it is declining to file than when it is
choosing. 14 of the 15 nowhere items came back `__none__` with confidence
0.93–1.00.

Consequence: **`confidence` carries no useful signal about whether `__none__`
is the right answer.** It cannot be thresholded, and no value of
`collectionMinConfidence` can be tuned to catch the one nowhere item the model
filed anyway (Translumo, confidence 0.59 — it happens to sit below 0.75, which
is luck, not design). If a stray `__none__` needs catching, that is a separate
question, not a threshold.

It also means the "safe failure is inaction" defence in [ai.md](./ai.md) is
carried by the `__none__` option rather than by the threshold. That is fine,
but it should be said plainly, because the doc attributes the safety to the
threshold.

## Turkish vs English confidence

This is the number the whole exercise was for. **Turkish is not the weak link.**

Shipped shape:

| group | n | min | p25 | median | p75 | p90 | max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Turkish, has a collection | 24 | 0.36 | 0.65 | 0.82 | 0.93 | 0.97 | 0.99 |
| English, has a collection | 18 | 0.23 | 0.49 | 0.78 | 0.94 | 0.96 | 0.98 |
| Turkish, fits nowhere | 9 | 0.51 | 0.86 | 0.97 | 1.00 | 1.00 | 1.00 |
| English, fits nowhere | 4 | 0.39 | 0.67 | 0.95 | 0.99 | 0.99 | 0.99 |

Mann-Whitney U, Turkish against English, on collection confidence:

| subset | tr median | en median | z | p |
| --- | --- | --- | --- | --- |
| all items | 0.88 | 0.78 | −1.07 | 0.283 |
| only items with a collection | 0.82 | 0.78 | −0.43 | **0.666** |
| only correct top-1 | 0.92 | 0.81 | −0.33 | 0.738 |
| only easy items | 0.91 | 0.81 | −0.60 | 0.551 |

The wide arm gives the same answer: p = 0.949 on items with a collection,
p = 0.730 on easy items, with identical means of 0.72.

**There is no detectable difference in confidence between Turkish and English
content.** Turkish median confidence is equal or higher in every arm. If
anything the model is marginally *more* certain about Turkish items, which is
the opposite of the hypothesis in [ai.md](./ai.md).

Share of fileable items clearing each threshold, shipped shape (n=24 Turkish,
n=18 English):

| threshold | Turkish | English |
| --- | --- | --- |
| 0.50 | 79.2% | 72.2% |
| 0.60 | 75.0% | 72.2% |
| 0.70 | 62.5% | 61.1% |
| 0.80 | 50.0% | 38.9% |
| 0.90 | 37.5% | 27.8% |

Turkish is never lower, and at the thresholds that matter it is between one and
ten points higher.

### The model reads Turkish essentially perfectly

The `türkçe` noul, asked as a plain sentence with no digest, is a language
detector with no errors worth speaking of:

| | Turkish items (n=33) | English items (n=22) |
| --- | --- | --- |
| median noul | 0.98 | 0.02 |
| range | 0.01 – 1.00 | 0.00 – 0.06 |

54 of 55 classified correctly at a 0.5 cut. p < 0.0001 on the separation.

Jev is not failing to *read* Turkish. It reads it well enough to identify the
language of a tweet from its text with near-perfect accuracy, and it classifies
Turkish content with the same confidence and at the same rate as English.

### The one real Turkish effect, and it is not where expected

`open-source` is the only question where language matters:

| arm | Turkish median | English median | p |
| --- | --- | --- | --- |
| shipped | 0.19 | 0.59 | 0.038 |
| no-digest | 0.17 | 0.62 | 0.012 |
| wide | 0.14 | 0.64 | 0.007 |

The model under-scores "is this about open source" for Turkish items
consistently, in every arm. Both the noul instructions and the criteria carry
the English words *open source* and *free source code* and *public
repository*, and a Turkish item that says only "açık kaynak" or "ücretsiz" does
not obviously match them.

Two consequences:

1. This is an **English-vocabulary artefact in the question**, not a Turkish
   comprehension failure. The obvious fix is to write the criteria so the
   Turkish words count: mention `açık kaynak` and `ücretsiz` alongside
   "open source". Not tested here — it is a prediction, not a measurement.
2. It is why `open-source` is the only tag whose precision is below 100%, and
   why 4 of the 5 wrong tags in the wide arm are `open-source`. Two of those
   four are cases where **my ground truth is the questionable one** — a post
   about a shadcn registry component really is about open source, and my rule
   was strict text-evidence-only. I cannot tell from the text which of us is
   right. Do not trust this measurement for that tag.

`claude` shows no language effect (p = 0.47–0.58). The brand name is a
language-neutral token and behaves identically in both.

## Tag noul threshold

**The per-tag sample digest is the most damaging thing in the request.**

Measured on the same 57 items, same collection Choice, only the tag questions
differ:

| arm | tokens/call | tag recall @0.80 | tag precision @0.80 | P(true noul > false noul) |
| --- | --- | --- | --- | --- |
| **shipped** (structured, digest in instructions *and* criteria) | 3,478 | **47.9%** | 97.1% | 92.7% |
| digest interpolated into one sentence | 2,569 | 78.9% | 83.6% | 96.2% |
| **plain sentence, no digest** | **1,466** | **81.7%** | 96.7% | **97.5%** |

Dropping the tag digest cuts the request by **58%** and *raises* tag recall by
**34 points**, for 0.4 points of precision. The model is strictly better off
being asked a plain question.

The damage is concentrated in the one tag this library cares about most:

| tag | shipped recall @0.80 | no-digest recall @0.80 |
| --- | --- | --- |
| `türkçe` | **27.3%** | **97.0%** |
| `ücretsiz` | 70.0% | 100% |
| `shadcn` | 83.3% | 83.3% |
| `web` | 50.0% | 25.0% |
| `claude` | 40.0% | 40.0% |
| `open-source` | 100% | 66.7% |
| `mcp` | 50.0% | 100% |

Median noul on true `türkçe` instances: **0.42** shipped, **0.98** without the
digest. Shipped, the model answers "does this belong under the tag `türkçe`,
which already covers: *[five Turkish titles]*" for a Turkish item and means
about half of the time. The digest turns an absolute question into a
similarity question, and the similarity is being judged against other
bookmarks rather than against the tag.

The comment above `sampleDigest` in `apps/api/src/ai.ts` says the member titles
"are what let one call suffice". That is true of the **collection Choice** and
the measurement confirms it there. It does not hold for the **Nouls**, and it
was carried across without evidence. The Nouls are absolute questions and they
get worse when you dilute them with evidence.

`open-source` moves the other way (100% → 66.7%), which is consistent with the
vocabulary artefact above: the digest supplies the English words the item
lacks, so with a digest the model matches them more often. For a tag whose name
is a literal English phrase, the digest helps. For a tag whose name is a
property of the item rather than a phrase in it, it hurts badly.

### Threshold sweep, shipped shape

| threshold | recall | precision | wrong tags | items tagged | items carrying a wrong tag |
| --- | --- | --- | --- | --- | --- |
| 0.30 | 90.1% | 53.3% | 56 | 48 | 31 |
| 0.50 | 62.0% | 62.0% | 27 | 34 | 21 |
| 0.60 | 57.7% | 73.2% | 15 | 31 | 14 |
| 0.70 | 57.7% | 85.4% | 7 | 28 | 6 |
| 0.75 | 52.1% | 94.9% | 2 | 23 | 2 |
| **0.80** (current default) | **47.9%** | **97.1%** | 1 | 21 | 1 |
| 0.85 | 38.0% | 100% | 0 | 19 | 0 |
| 0.90 | 31.0% | 100% | 0 | 17 | 0 |

71 ground-truth tag instances over 57 items. After the `maxTags: 3` cap, which
bound on **0 of 57 items** at any threshold of 0.70 or above — it is not doing
anything at these thresholds.

`0.80` is defensible and I would not argue with it hard. The sweep without the
tag digest, where the nouls are finally on a usable scale:

| threshold | recall | precision | wrong tags |
| --- | --- | --- | --- |
| 0.50 | 95.8% | 80.7% | 16 |
| 0.60 | 90.1% | 84.2% | 12 |
| 0.70 | 83.1% | 89.4% | 7 |
| 0.80 | 81.7% | 92.1% | 5 |
| 0.90 | 69.0% | 100% | 0 |

`0.80` sits at a reasonable point. The stronger recommendation is not to move
it but to **fix the questions**, after which `0.80` looks like a good number
rather than a compromise.

One caveat on the whole tag section: these labels are mine, text-evidence-only,
on a 7-tag vocabulary I invented. Tag thresholds do not transfer between
vocabularies the way the `P(true noul > false noul)` figure partly does.

## Real cost

The design assumes ~800 input tokens and ~`$0.000034` per classification. The
shipped request is **3,478 input tokens and `$0.000146`** — **4.3× the
assumption**.

| | tokens | $ per classification | 5,000 bookmarks |
| --- | --- | --- | --- |
| design assumption | 800 | 0.0000336 | **$0.17** |
| shipped shape, measured | 3,478 | 0.000146 | **$0.73** |
| shipped without tag digests | 1,466 | 0.0000616 | $0.31 |
| wide emulation | 2,284 | 0.0000959 | $0.48 |
| names only, no digests | 975 | 0.0000410 | $0.20 |

Not an order of magnitude off, but the headline "$0.17 for 5,000 bookmarks" in
[ai.md](./ai.md) understates the shipped request by 4.3×. Output tokens average
197 per call and are free, so only input matters.

### Where the tokens go

Measured by removing one piece at a time from a single request:

| request | input tokens |
| --- | --- |
| one noul, tiny state | 410 |
| 7 nouls, no choice | 491 |
| choice with **names only** + 7 nouls | 595 |
| choice with 3-sample digests + 7 nouls | 1,067 |
| choice with 8-sample digests + 7 nouls | 1,854 |
| shipped shape (digests on the choice **and** on all 7 nouls) | 3,478 |

Two things follow.

**About 400 tokens are fixed overhead** that no amount of trimming removes.
The "800 tokens" figure in the design is roughly the cost of *names only plus a
margin* — it looks like the collection criteria were budgeted as if they
carried names, while the same document says they carry member titles.

**The per-tag digests are ~2,000 tokens, 58% of the request, and they make
tags worse.** They are the single largest cost in the design and they buy
nothing.

### Is the collection digest worth it?

Per correct top-1 answer, at `$42` per billion input tokens:

| digest | tokens | top-1 | $ per correct answer |
| --- | --- | --- | --- |
| names only | 975 | 66.7% | $0.0000614 |
| 3 samples | 1,446 | 77.2% | $0.0000787 |
| 5×90 (shipped) | 3,478 | 75.4% | $0.0001937 |
| 8×160 (wide) | 2,284 | 82.5% | $0.0001162 |

Names-only is the cheapest per correct answer, which is true and irrelevant.
[ai.md](./ai.md) says "we optimise for decision quality, not cost", and at
these prices the whole 1,061-bookmark library costs well under a dollar. Buy
the accuracy. The wide arm is the best of both: the most accurate *and*
cheaper than what ships.

## Error paths

Every one of these was sent against the live service.

| case | status | body |
| --- | --- | --- |
| deliberately bogus key | **401** | `{"detail":{"error_type":"authentication_error","message":"Cannot authenticate with the server. Please check your API key and try again."}}` |
| no `Authorization` header | **403** | `{"detail":{"error_type":"authentication_error","message":"Must supply an API key! Check your request and try again."}}` |
| missing `model` | 422 | `{"detail":[{"type":"missing","loc":["body","model"],"msg":"Field required","input":{…whole request…}}]}` |
| choice with no `criteria` | 422 | `{"detail":[{…,"loc":["body","questions","c","choice","criteria"],…}]}` — note the spurious `choice` segment, which is not a field you sent |
| unknown model id | **400** | `{"detail":{"error_type":"api_usage_error","message":"Unknown model: jev-9.9.9"}}` |
| state over the context ceiling | **400** | `{"detail":{"error_type":"max_tokens_exceeded"}}` |
| 256 choice options | **400** | `{"detail":"Too many choices. Must have at most 255 choices."}` |
| wrong path | 404 | `{"detail":"Not Found"}` |
| 21 nouls in one request | 200 | all 21 answered |

Things worth knowing:

- **`detail` has three different shapes.** An object with `error_type` and
  `message` on 400/401/403, an *array* of pydantic-style errors on 422, and a
  bare string on 404. Anything that does `body.detail.message` breaks on two of
  the three.
- **A 422 echoes your entire request body back** in `input`, bookmark text
  included. `requestJson` only reads the status and never logs the body, so
  nothing leaks today — but do not start logging it.
- **The context ceiling is a 400, not the 422 the docs promise.** Accepted at
  27,570 input tokens, rejected from roughly 38,000 up. The published figure is
  64k per request, 32k for state plus the longest question, so the request-level
  ceiling is stricter than that in practice.
- **The 255-option cap counts `__none__`.** The real ceiling is 254
  collections. `apps/api/src/ai.ts` already caps at 254 for this reason, so this
  is handled.
- `apps/api/src/ai.ts` retries only 429 and 529 and treats everything else as a
  hard failure returning a neutral classification. That is the right policy
  against the table above: a 401, 403, 400, 422 or 404 will not fix itself, and
  the bookmark correctly stays eligible.

### 429 could not be provoked

The documented limits are 250,000 tokens/second and 1,200 requests/minute.
Neither fired.

| attempt | rate | result |
| --- | --- | --- |
| 260 realistic 2,284-token requests, 60 concurrent | ~260,000 tokens/s over 2.29 s | 260 × **200** |
| 40 requests of 27,570 tokens, 40 concurrent | ~658,000 tokens/s over 1.68 s | 40 × **200** |

The second is 2.6× the documented token ceiling and returned nothing but 200s.
I did not send enough requests to approach 1,200/minute, so that limit is
untested.

**No rate-limit headers at all.** Not on success, not anywhere. No
`x-ratelimit-remaining-requests`, no `retry-after`, no `retry-after`-equivalent.
`backoffDelay` reads `retry-after` and will always fall through to its
exponential path, which is a reasonable default but is not what the code
appears to expect. If the limits are real, they will be enforced as bare 429s
with nothing to pre-empt them with, and `MAX_ATTEMPTS = 3` with a 5s ceiling on
`retry-after` will simply give up. At the request sizes measured here that is
the right behaviour: the client re-runs the queue on the next alarm.

It is also possible the published limits are aspirational and the real ceiling
is elsewhere. Either way, do not build anything that depends on reading a limit
header off this API.

### The envelope matches `parseSystemOneResponse`

Checked field by field against the real service. The parser is correct.

| what | observed | parser |
| --- | --- | --- |
| top level | exactly `model`, `answers`, `usage` | reads all three |
| `model` | `jev-1.13.0` when you send `jev-latest` | passes through |
| `usage` | **`input_tokens` / `output_tokens`** (snake_case) | reads `rawUsage.input_tokens` ✓ |
| choice answer | `type`, `choice`, `probabilities`, `confidence` | all four ✓ |
| noul answer | `type`, `noul` **only** | reads `noul` ✓ |
| score answer | `type`, `score`, `legend`, `probabilities`, `confidence` | not used |
| `probabilities` keys | every criteria key including `__none__` | iterates them ✓ |
| answers per question | exactly one, same id, no extras | iterates *questions*, not answers ✓ |

The `noul` answer carries **no `confidence` and no `probabilities`**, so
`AiAttribution.tagConfidence` is populated from the noul value. The field name
is a slight misnomer but the type is right.

Two things about `probabilities` that are not in the docs:

- **Every value is rounded to two decimal places.** All 285 probabilities
  across 57 runs were exact 2-dp values. They sum to 1, but the smallest
  non-zero probability is 0.01 and ties are common. `probabilities` cannot be
  used for a fine-grained threshold or a reliable runner-up margin, and it
  should not be stored for later re-thresholding. Store `confidence` and
  `choice`.
- The choice answer's `confidence` is *not* a function of `probabilities[choice]`
  alone, so do not try to derive one from the other.

## Verdict

**The default `0.85` should come down to `0.75`.** Not up. At 0.75 the feature
files five more bookmarks correctly for exactly the same number of wrong
filings. The evidence for raising it — the Turkish language risk — is not
there: Turkish and English confidence are statistically indistinguishable
(p = 0.67 on the subset that matters).

**It should ship**, with two changes, and with the under-firing stated plainly
in the UI rather than discovered by the user. At 0.75 it files roughly half of
what it could. That is the model's real accuracy on a four-collection taxonomy
over a messy real library, and no threshold fixes it.

**The single biggest caveat:** the feature's accuracy is limited by the
*taxonomy*, not by the language and not by the threshold. Every one of the
eight hard cases the model got wrong was an AI item placed in a neighbouring
collection, and the model's bias is always toward the collection with the
largest, most distinctive digest. A user with a sprawling, overlapping taxonomy
will get worse results than these numbers, and the `__none__` rate will change.
This has not been tested against a real taxonomy because this library does not
have one.

The second caveat, and the one I would act on first: **39 bookmarks in this
library carry 40 characters of text or less** after the state filter — 15 of
them 20 characters or less, and a handful are a bare emoji or nothing but the
author's handle. They are not a language problem, and no threshold or prompt
fixes them. The current code spends a request on each and gets a coin flip.

## Recommended changes

Each tied to something measured above.

1. **`DEFAULT_COLLECTION_MIN_CONFIDENCE`: 0.85 → 0.75.**
   `apps/api/src/ai.ts:105`. Filed/correct/wrong goes 15/13/2 → 22/20/2. Same
   wrong count, +54% correct filings. 0.75 dominates 0.85 in all four arms.

2. **Drop the `covers` digest from the tag nouls.** `sampleDigest` in
   `buildClassificationQuestions`. Tag recall 47.9% → 81.7%, `türkçe` recall
   27.3% → 97.0%, tokens 3,478 → 1,466. Keep the digest on the collection
   Choice, where it is worth 8.7 points of top-1. The comment justifying the
   digest is true of the Choice and false of the Nouls.

3. **Add a guard for bookmarks with no text.** A cheap
   `title.length + summary.length` floor in `buildClassificationState`'s
   caller, returning `neutralClassification()` without a request. 39 of this
   library's 1,061 bookmarks fall under 40 characters of state text and 15 fall
   under 20. This is the largest single category of unclassifiable bookmark and
   nothing in the current design catches it.

4. **Fix the cost figures in "The model"** in [ai.md](./ai.md): 3,478 input
   tokens, `$0.000146` per classification, 5,000 bookmarks ≈ `$0.73` — or
   `$0.31` after change 2. Not 800 tokens and `$0.17`. Also worth recording
   that ~400 tokens per request are fixed overhead and that the per-tag digests
   were ~58% of the shipped request.

5. **Do not add a language-specific threshold, and do not raise 0.85 for
   Turkish.** p = 0.67. If anything, state in [ai.md](./ai.md) that the
   measurement came back negative, so the next person does not re-derive the
   fear from the TypeSafe docs alone.

6. **Correct the "Non-English content" section.** The safe failure is carried
   by the `__none__` option, not by the threshold: items that fit nowhere come
   back at median confidence 0.99, *higher* than items that fit somewhere
   (0.78). `confidence` cannot detect a bad `__none__`. Third defence in that
   section is now done — point it here.

7. **Mention the `covers` digest finding in the TypeSafe-shaped guidance.** The
   generalisation is that a Noul is an absolute question and evidence in the
   question dilutes it, while a Choice is relative and evidence in the question
   sharpens it. That is the same split [ai.md](./ai.md) already makes for
   `decideClassification`, and the digest is where it gets violated.

8. **Write tag criteria in both languages, or in the library's language.** The
   `open-source` noul is the only measurably language-sensitive question
   (Turkish median 0.19 vs English 0.59, p = 0.038, consistent across all four
   arms), and the cause is that its criteria only offer English words while a
   Turkish item says `açık kaynak`. Untested — measure before shipping.

9. **Store `confidence` and `choice`, not `probabilities`.** Every
   `probabilities` value is rounded to 2 dp. `AiAttribution` already only keeps
   confidences, which is right; say so in a comment so it is not "improved"
   later.

10. **Do not build anything on rate-limit headers.** None are returned,
    including on the responses that exceeded the published token ceiling by
    2.6×. The current retry policy (429/529 only, 3 attempts, 5s ceiling,
    neutral on failure) is correct as written.

Two things that are already right and should not be changed: the 254-collection
cap that accounts for `__none__` taking one of the 255 slots, and
`parseSystemOneResponse`'s handling of the envelope, which matches the service
exactly, including the snake_case `usage` keys.
