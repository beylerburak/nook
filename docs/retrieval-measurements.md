# Retrieval measurements

A measurement pass over the two features in [retrieval.md](./retrieval.md) —
hybrid search and generated summaries — run against the real library and the
real code. Every number below was measured. Where a measurement contradicts
the doc, it is listed in "Contradictions" at the bottom rather than smoothed
over.

The short version: **search should ship, with a cosine floor, and one bug in
it needs fixing first. Summaries should ship, but the post-processing does not
do the job it was written for, and the gate is justified by a fact about this
library that is the reverse of the one the code gives.**

## What ran

| | |
| --- | --- |
| date | 2026-09-26, 00:00–00:40 UTC |
| embedding model | `text-embedding-3-small`, 768 dimensions, the shipped default |
| summary model | `gpt-4o-mini` (the `NOOK_SUMMARY_MODEL` → `NOOK_AI_MODEL` → default chain) |
| embedding calls | 9 batched requests for the library, plus 73 single-query embeddings |
| generation calls | 117 summarisation calls (57 against the real code, 51 against a transcribed prompt, 9 for an A/B arm), plus 31 token probes |
| **total spend** | **$0.0159** |

### Where the data came from

**The real library.** The live Postgres in `compose.yaml`, reachable on
`127.0.0.1:15481`, one user, `nook_records` holding 1,073 bookmark rows of
which **1,061 are live**: 1,050 from X, 11 saved from Chrome, created between
2024-09-14 and 2026-09-25. Every query was wrapped in
`BEGIN TRANSACTION READ ONLY` with `default_transaction_read_only=on` and
rolled back. Nothing was written, migrated or dropped. The keys were loaded
into the process from `.env` and never printed.

The language is mixed and mostly Turkish. Both keys were present and both
worked; the database was reachable throughout. Nothing in this report is
estimated from a fixture.

### One thing changed under the measurement

`apps/api/src/summarize.ts` did not exist when this pass started. It was
written by something else at 03:21 local, part-way through, along with
`apps/extension/lib/retrieval.ts`. The gate arithmetic, the first summary run
and the quote A/B arm were done before it landed and used the specification in
the doc; everything reported under "Summaries" and "Real cost" was then **redone
against the shipped functions** and the earlier numbers are marked where they
survive. `apps/api/src/retrieval.ts` and `docs/retrieval.md` did not change
during the run, so the search half is measured against the code as read.

The index was built in memory rather than in `nook_embeddings`, which does not
exist in the live database — the table is in `schema.sql` but the migration has
never run. `embeddedText`, `foldForSearch`, `contentHash` and `embedTexts` were
imported from `apps/api/src/embeddings.ts` and used unmodified, and so were
`queryTerms`, `rankLexical`, `rankSemantic` and `fuseWithRRF` from
`retrieval.ts`. The whole library really was embedded: 1,047 rows in 4.3 s.

## The summarisation gate

`isWorthSummarising` in `apps/api/src/summarize.ts:268` returns
`description.length > MIN_SUMMARISABLE_CHARS`, and `MIN_SUMMARISABLE_CHARS` is
400 (`summarize.ts:151`). Run over the whole library:

| outcome | records | share |
| --- | --- | --- |
| worth summarising | **241** | 22.7% |
| skipped, description too short | 820 | 77.3% |
| of which: no description at all | 14 | 1.3% |
| already summarised | 0 | — |

So the gate is not a no-op. It selects 241 records and it is the difference
between $0.028 and $0.088 for a full pass.

### It earns its place, but not for the stated reason

The comment above `MIN_SUMMARISABLE_CHARS` (`summarize.ts:140`) justifies the
gate like this:

> on a real 1,061-bookmark library most records are X posts whose
> `description` *is* the truncation (x-parser.ts slices the tweet text at 180
> and stores it as both fields)

**That is not what the library looks like.** The two facts:

- The gate selects **241 records and every one of them is an X post. Zero web
  captures.** The longest of the 11 Chrome bookmarks has a 251-character
  description; the gate needs more than 400. Not one web page in this library
  can ever get a summary.
- `description` is byte-identical to `shortDescription` on 604 of the 1,061
  records — but on every one of those the description is at or under 180
  characters, i.e. the parser copied a short string into both fields. On all
  443 records whose description is *longer* than 180, `shortDescription` is a
  separate `description.slice(0, 180)` — a hard cut, with no ellipsis, so the
  library row stops mid-word. Zero records are the case the comment describes.

The gate's *effect* is right, and larger than the doc implies. 64% of all
description text in this library — 210,437 of 328,926 characters — is hidden by
the 180-character row truncation, and the 241 gate-passing records hold 71.7% of
it. The gate is worth having. The reason given for it is wrong, and the reason
it is wrong matters: the doc's headline motivation for summaries is "a long
article is unreadable in the library list because of it", and this library
contains no long articles. **The feature as designed cannot be exercised on the
library that motivated it.**

### Gate threshold sweep

| gate | records | share | X posts | web pages | median description |
| --- | --- | --- | --- | --- | --- |
| > 180 (the truncation) | 443 | 41.8% | 441 | 2 | 441c |
| > 280 | 301 | 28.4% | 301 | 0 | 654c |
| **> 400 (shipped)** | **241** | **22.7%** | **241** | **0** | **773c** |
| > 800 | 109 | 10.3% | 109 | 0 | 1,224c |

400 is a defensible line and the code's own argument for it — "at 400 the
description carries at least 220 characters the row does not show" — is
arithmetic, not taste. Nothing measured here argues for moving it.

## Summaries

19 real records that pass the shipped gate, sampled across the description
length distribution (401c to 1,990c), 3 samples each = **57 summaries**, all
generated by the real `buildSummaryPrompt` and post-processed by the real
`cleanSummary`. I read every bookmark in full before reading any summary, and
wrote down what a good summary would say. Ground truth is mine, text-evidence
only.

### Mechanical results

| | |
| --- | --- |
| wrong language | **0 / 57** |
| contains markdown | 0 / 57 |
| more than two sentences | 0 / 57 |
| empty after `cleanSummary` | 0 / 57 |
| `cleanSummary` changed the output | **3 / 57 (5.3%)** |
| — of those, a label or preamble was stripped | **0** |
| — of those, the 400-character cap cut a sentence | 3 |
| output still opens with "Bu sayfa," / "The page" | **53 / 57 (93%)** |

Output length: min 203 characters, median 308, max 395, against a
`MAX_SUMMARY_CHARS` of 400. The median sits at 77% of the cap, so the cap is
close to binding on ordinary output and did bind on 3 runs.

### Language: clean, no Turkish penalty

| source language | summaries | same-language output |
| --- | --- | --- |
| Turkish | 36 | **36 (100%)** |
| English | 21 | **21 (100%)** |

The prompt asks for the content's own language and gets it every time, in both
directions, without being told which language the library is in. Turkish
content produced Turkish summaries and English content English in 57 of 57
attempts. This is a stronger result than
[ai-calibration.md](./ai-calibration.md) got for Jev, and it is the same answer:
**language is not the weak link in this stack.**

### Accuracy

| verdict | count | share |
| --- | --- | --- |
| accurate | 50 | **87.7%** |
| vacuous — true of the bookmark, worth nothing | 6 | 10.5% |
| misleading | 1 | 1.8% |
| of which: asserted something unsupported | 2 | 3.5% |
| accurate but thin — drops the differentiating fact | 24 | 42.1% |

16 of 19 items were 3/3 accurate. All six vacuous results come from three
items, and all three are the same failure: **the summary describes the post
instead of conveying it.**

`x:2027729887172112460` is an OpenClaw cheatsheet — eleven sections of bullet
lists. All three summaries enumerate the section headings and then add "it
serves as a quick reference guide for users to effectively utilize and
troubleshoot the Openclaw platform". The 180 characters already in the list row
read `openclaw cheatsheet core commands • openclaw gateway • openclaw gateway
start | restart • openclaw channels add • openclaw channels list • openclaw
status --probe • openclaw onboard • openclaw setup • openclaw doctor •…`. The
summary is strictly worse than the truncation it replaces.

`x:2050516907304862164` is the five-parallel-Claude-Code-agents post, 1,871
characters, and the single densest thing in this library worth summarising. Two
of three summaries say that the post covers "a 5-agent solo developer model",
"cost management" and "agent isolation" and name none of the five roles, none of
the three isolation mechanisms (separate terminals, separate `CLAUDE.md`,
filesystem permissions), and neither cost figure. The third run finally names
the three mechanisms.

`x:2045561640733860216` produces the one misleading summary in the set. The
post is a priority claim — the author says he built his LLM memory system a
month before Karpathy published the same idea — and run 2 says the author
"adopted" the concept a month earlier (`benimsediğini`). That inverts the one
thing the post exists to argue.

### Invented facts: 2 in 57

I checked every claim against the source text rather than by impression, and
one candidate turned out to be fine: a summary citing "10,000+ action types and
200+ integrations" was quoting the bookmark's quoted post, which is in the
prompt. The two real ones:

1. `x:2017922211412168918` (Pencil). "Kullanıcıların **5 kelimeyle** tasarım
   oluşturabilmesini sağlayarak" — the author gave one five-word prompt and
   screenshotted the result. Nothing in the post says the tool takes, needs or
   guarantees five-word prompts. A demonstration became a product capability.
2. `x:2023824854471110957` (Ray-Ban glasses). "a real-time AI assistant **named
   Gemini**" — the assistant is the Gemini Live plus OpenClaw pair; Gemini is
   the vision model. A minor misattribution, and the run in question is also
   one of the three the length cap truncated.

So: no fabricated entities, no fabricated numbers, no fabricated quotes. Two
unsupported inferences out of 57, and one of them is the model sharpening a
claim the post made loosely. For a line of text a user reads in a list and
trusts, that is an acceptable rate. It is not zero, and the vacuous rate is not
zero either.

### Cleanup: needed 5.3% of the time, and never for the reason it was written

`cleanSummary` is described at `summarize.ts:441` as load-bearing, on the
argument that a model asked for a summary "will very often answer 'Bu bir özet:
…'". **In 57 runs it never once did.** `SUMMARY_LABELS`
(`summarize.ts:338`) lists fifteen label phrases and `stripLabels` fires on
none of the 57 outputs. The prompt's explicit "Never start with words like
'Here is a summary' or 'Bu bir özet'" is sufficient on its own for this model.

The three times `cleanSummary` did change something, it was `capLength`
cutting a second sentence off a two-sentence answer at a sentence boundary.
That is the cap doing its job, not the label stripping.

**And the preamble arrived anyway, in a costume the code does not recognise.**
53 of 57 outputs — 93% — open with a reference to the artifact rather than to
its content:

> Bu sayfa, Google'ın yeni Gemini Embedding 2 modelini tanıtarak…
> Sayfa, Microsoft'un ücretsiz ve açık kaynaklı bir Python aracı olan
> MarkItDown'ı tanıtıyor.
> The page introduces Compositor, a free, open-source image editor…
> This page describes an open-source GitHub project that enables a real-time AI
> assistant for Meta Ray-Ban smart glasses…

"Bu sayfa," and "The page introduces" are exactly the thing `cleanSummary`
exists to remove: text the caller has somewhere to put and that adds nothing
above it. `LEADING_LABEL` (`summarize.ts:356`) requires a separator after the
label — a colon, a dash — and "Bu sayfa," is followed by a comma, so it is not
matched. Neither phrase is in `SUMMARY_LABELS` at all. **This ships as stored
text on 93% of summarised bookmarks.** It is the single most consequential
finding in this file.

### Do not add the quoted post to the prompt

`buildSummaryPrompt` passes only `title`, `description` and `note`; the
`quote` object is excluded. Measured A/B on the three sample records that carry
a quote, 3 runs each:

| record | with the quote in the prompt | description only (shipped) |
| --- | --- | --- |
| `x:2059811798380110273` | 3/3 drift onto the quoted post | 3/3 accurate |
| `x:2050516907304862164` | 3/3 state the $320k as fact | 3/3 keep the author's hedge |
| `x:2031493209537265988` | 3/3 correct | 3/3 correct, two richer |

The first row is the clearest. With the quote in the prompt, one summary cites
"10,000+ action types and 200+ integrations" and another spends its second
sentence on the quoted post's origin story about the founder's mother. The
bookmark's own facts — 11 signups, 60 seconds against 20+ minutes — disappear
from all three. Without the quote, all three describe the actual bookmark and
one catches the 60-seconds-versus-20-minutes comparison.

The second row is the one that matters most. The post opens by saying the
$320k/year figure is "probably exaggerated or for marketing". With the quote in
context, all three summaries state it as established fact; without it, all
three keep the hedge — "hikayenin abartılı olabileceği belirtiliyor".

Including the quote produced four bad summaries out of six and laundered a
hedged claim into a fact. **The shipped choice is correct, and this is the
measurement that says so.** Anyone who later "improves" the prompt by feeding
it the quoted post should read this table first.

## Search

### The labelled query set

18 queries, hand-labelled before any score was looked at. Relevant means "a
user typing this wants this bookmark in their results". 14 of the 18 have at
least one relevant document; the other 4 have none, by design or by discovery.

| id | query | language | kind | relevant |
| --- | --- | --- | --- | --- |
| q01 | `CodeWiki` | tr content | exact term | 2 |
| q02 | `ccstatusline` | tr content | exact term | 1 |
| q03 | `CodeMender` | tr content | exact term | 1 |
| q04 | `Seedance` | tr content | exact term | 8 |
| q05 | `veritabanı performans sorunu` | tr | the doc's own example | **0** |
| q06 | `yapay zekayla web sitesi yapmak` | tr | paraphrase | 6 |
| q07 | `büyük projede yapay zekanın kafası karışıyor` | tr | paraphrase | 2 |
| q08 | `veritabanı yedekleme` | tr | paraphrase → a **French** post | 1 |
| q09 | `ücretsiz API` | tr | paraphrase | 6 |
| q10 | `tasarım sistemi` | tr | paraphrase → content says "design system" | 9 |
| q11 | `run a large model on a cheap graphics card` | en | paraphrase | 4 |
| q12 | `make websites using AI` | en | cross-lingual, same intent as q06 | 6 |
| q13 | `reducing the cost of AI coding tools` | en | cross-lingual | 7 |
| q14 | `postgresql backup automation` | en | cross-lingual → a **French** post | 1 |
| q15 | `how to run Claude Code with a local model for free` | en | paraphrase | 4 |
| q16 | `847291` | — | should return nothing | 0 |
| q17 | `🧿🔮` | — | should return nothing | 0 |
| q18 | `zzzqqq vwxyz plorbnak` | — | should return nothing | 0 |

Ground truth was labelled from a pool per query: the substring hits, the
lexical hits, the top 40 of each retriever, and a net over any single query
term or a 6-character prefix of it. Pooling is a real caveat — a relevant
document outside every pool would be invisible to all three systems and would
understate all three equally.

The substring baseline is transcribed from `matchesSearch` in
`apps/extension/src/app/dashboard/bookmark-utils.ts:57`: a single
`String.includes()` of the **whole** query against a lowercased concatenation
of title, descriptions, note, url, urls, creator, quote and tags.

### recall@10

| system | mean | queries with zero hits |
| --- | --- | --- |
| substring only (what ships today) | 29.8% | **9 / 14** |
| semantic only | 47.9% | 3 / 14 |
| **hybrid (lexical + semantic, RRF)** | **59.0%** | 3 / 14 |
| new lexical alone (AND over terms) | 33.9% | 8 / 14 |

Averaged over the 14 queries that have a relevant document.

**Hybrid is the best of the three, by 11.1 points over semantic-only and 29.2
over the substring pass that ships today.** The doc's claim holds. Two details
matter more than the headline:

**The doc's motivating example is a query with no answer.** `docs/retrieval.md`
cites "veritabanı performans sorunu" as the case where semantic-only search
"returned a top hit at 0.44 about performance in an unrelated sense". That is
reproduced exactly — the top hits are a vitest process-spawning post, a
log-to-fix-time post, a "Prompt performance dashboard" and a hoppscotch RAM
comparison. But **nothing in this library is about database performance**: the
five records containing "veritaban" are self-hosting, security scanning, RAG
chunking, a technology list and test coverage. The query has an empty relevant
set. It is a fourth nothing-query, not evidence about exact terms.

**The real evidence for exact terms is q03 and q04, and it is strong.**
`CodeMender` — one post naming Gemini CLI's security agent — is at **rank 144 of
1,047** semantically and rank 1 in hybrid. `Seedance` is 4/8 semantically and
8/8 in hybrid. Semantic-only does miss exact product names, and the lexical
half is what rescues them. Refuted in one direction, confirmed in the other:
the conclusion was right and the example was wrong.

**When the lexical half returns nothing, hybrid is byte-identical to
semantic-only.** Verified on all 11 queries with zero lexical hits: the top 20
are the same ids in the same order. RRF with one empty list is the other list.
So the fusion earns its keep only on queries where the user happens to use the
document's own words — which is 5 of 19 measured queries, and precisely the
exact-term ones.

### The nothing-queries: this is broken

| query | substring | lexical | semantic | hybrid | hybrid's top hit |
| --- | --- | --- | --- | --- | --- |
| `847291` | 0 | 0 | **1,047** | **1,047** | a two-word post: "ai legal" |
| `zzzqqq vwxyz plorbnak` | 0 | 0 | **1,047** | **1,047** | a post whose entire content is "🙃 Based" |
| `🧿🔮` | 0 | 0 | 1,047 | 1,047 | "Another day, another dark mode masterpiece powered by @shadcn" |

A bare number returns the entire library ranked, and the top hit is a post with
two words in it. `🧿🔮` is the one case that survives, and only by accident:
`queryTerms` folds it to zero terms, so `searchBookmarks` hits the
`parsed.terms.length === 0` guard and returns `no-matches` before embedding
anything. Nothing about the semantic path rejects a nonsense query.

`rankSemantic` is called with `minScore = 0` (`retrieval.ts:366`). On this
library no cosine is negative, so the floor never binds and every query returns
everything.

**A cosine floor is the right instrument, and 0.40 is about the right number.**

| floor | real queries with a hit in the top 10 | nonsense queries emptied |
| --- | --- | --- |
| 0.00 (shipped) | 14 / 14 | **0 / 3** |
| 0.35 | 14 / 14 | 2 / 3 |
| **0.40** | **13 / 14** | **3 / 3** |
| 0.44 | 13 / 14 | 3 / 3 |
| 0.50 | 8 / 14 | 3 / 3 |

The one real query lost at 0.40 is `veritabanı yedekleme`, whose top-1 cosine
is 0.3512 — and whose relevant document, the French Postgresus post, is at
**rank 543 of 1,047** semantically. That query was already a failure.

A floor on the *fused* score would be useless, and structurally so: RRF is
rank-only, so a rank-1 result always scores 1/(60+1) = 0.016393 whatever its
cosine. The threshold has to be on the cosine, before fusion.

The doc's stated reason for `minScore = 0` — "a cosine of 0.44 is a *correct*
top hit on this library" — is confirmed and cuts both ways. Correct top-1
cosines: `CodeWiki` 0.4744, `ccstatusline` 0.4648, `Seedance` 0.4564, `tasarım
sistemi` 0.4525, `CodeMender` 0.4474. Nonsense top-1 cosines: 0.3869, 0.3444,
0.3394. The two distributions overlap but do not coincide, and 0.40 sits in the
gap. Margin does not separate them at all: the nonsense query `847291` has a
top-1-to-top-2 margin of 0.0286, higher than 11 of the 14 real queries.

Three nonsense queries is a small sample. A floor at 0.40 is defensible; 0.46
and above starts eating real exact-term queries.

## Turkish vs English

| group | n | substring | semantic | hybrid |
| --- | --- | --- | --- | --- |
| Turkish, exact term | 3 | 100% | 67% | 100% |
| English, exact term | 1 | 100% | 50% | 100% |
| **Turkish, paraphrase** | **5** | **3%** | **19%** | **20%** |
| **English, paraphrase** | **5** | **0%** | **65%** | **65%** |

The aggregate split is stark: on paraphrased queries Turkish scores 20% and
English 65% under hybrid. **That gap is not a Turkish weakness, and the
evidence for saying so is direct.**

The two groups are matched on intent in exactly one pair — q06
`yapay zekayla web sitesi yapmak` and q12 `make websites using AI`, the same
request in two languages — and they score **2/6 and 2/6. Identical.** The 45-point
aggregate gap comes from *which queries I happened to write*, not from the
language.

The mechanism is vocabulary mismatch, and it is demonstrable. Three Turkish
posts, three queries each: one phrased with the post's own Turkish words, one
paraphrased away from them.

| target post | query using the post's own words | semantic rank | query paraphrased away | semantic rank |
| --- | --- | --- | --- | --- |
| `x:2021919417827795209` | `mediaanalysisd disk alanı cache` | **1** | `yapay zekanın diskte bıraktığı önbellek` | 14 |
| `x:2029091402215239909` | `Aider RepoMap büyük codebase` | **2** | `yapay zekanın kafası karışıyor` | 126 |
| `x:2046976594476933344` | `GPT Image 2 prompt koleksiyonu` | **1** | `ücretsiz görsel prompt listesi` | 1 |

With the content's own Turkish vocabulary the target is rank 1 in all three
cases. Paraphrased, it falls off. `text-embedding-3-small` reads Turkish fine
on this library. The two worst Turkish results have the same cause and it is
not comprehension:

- `tasarım sistemi` finds 1 of 9 design-system documents, because **nine
  records in this library say "design system" in English and not one says
  "tasarım sistemi" in Turkish**. A Turkish user has to guess the content's own
  wording.
- `veritabanı yedekleme` has to reach a post written in **French**, and does
  not (rank 543). The English equivalent, `postgresql backup automation`, puts
  the same post at **rank 1**.

Cross-lingual retrieval does work here, and it works across three languages:
English queries reach Turkish posts (`run a large model on a cheap graphics
card` returns four correct hits, two of them Turkish) and an English query
reaches a French post at rank 1.

**Verdict: Turkish is not the weak link in search, for the same reason it was
not the weak link for Jev.** The real risk is that Turkish agglutination plus
content that mixes Turkish and English vocabulary means a user has to guess
which words a bookmark uses. That is a problem for the lexical half and for
`#tag`, not for the embedding model, and no threshold or model swap fixes it.

## Real cost

### Summaries

Measured on 57 real calls with the real prompt, then extrapolated over the 241
gate-passing records with a linear fit from 15 stratified probes:

| | |
| --- | --- |
| records summarised | 241 |
| user-prompt characters | 266,608 |
| fixed overhead per call (the system prompt) | 139 tokens |
| estimated prompt tokens | 117,106 |
| estimated output tokens | 17,052 (measured mean 71/call) |
| **cost, one pass over the whole library** | **$0.0278** |
| per record | $0.0001153 |
| per 1,000 records | $0.115 |
| the same pass with no gate at all | $0.0877 |

The gate saves $0.0599, which is 68% of the spend. The design's assumption
that this is negligible is correct: **one full pass over this library costs
under three cents**, once, and never again unless a bookmark's text changes.
For scale, [ai-calibration.md](./ai-calibration.md) spent $0.07 on 699
classification calls for 57 items.

`MAX_SUMMARY_CHARS` at 400 is close to binding — median output 308 characters,
maximum observed 395 — and `MAX_COMPLETION_TOKENS` at 300 was never hit, so the
generation cap is not what is holding the length down. The prompt is.

### Search

Every figure in the doc's cost table is wrong in the same direction by the same
factor, and the error is in the token count.

| | doc | measured | ratio |
| --- | --- | --- | --- |
| embeddable text, whole library | 77,008 tokens | **189,219** | 2.46× |
| embed the whole library, once | $0.0015 | **$0.00378** | 2.52× |
| re-embed one bookmark | $0.0000015 | **$0.00000361** | 2.41× |
| 100 new bookmarks a day for a year | $0.06 | **$0.132** | 2.20× |
| one search query | $0.0000004 | $0.00000013 | 0.33× |
| 10,000 searches | $0.004 | $0.0013 | 0.33× |
| the whole library in one request, 8.4s | — | 9 batches of 128, concurrency 2, **4.3s** | — |

The library has **553,777** embeddable characters over 189,219 tokens, which is
2.93 characters per token. The doc's 77,008 tokens would be 7.19 characters
per token, which no BPE tokenizer produces. The doc's token figure looks like it
was taken before the per-field caps in `EMBEDDED_FIELD_LIMITS` were applied, or
from a character count divided by a round number.

The two search figures are *over*estimates by 3×, so the error is not a
consistent pricing mistake — it is one stale token count propagated through the
table. All of it stays negligible: 10,000 searches is a tenth of a cent.

## Verdict

**Summaries should ship.** 87.7% accurate, zero wrong-language, zero markdown,
zero fabrication of entities or numbers, two unsupported inferences in 57, and
$0.028 for the whole library. Turkish and English both work without being told
which is which. The feature does what the doc says it does.

**But do not ship it as-is.** `cleanSummary` does not do the job it was written
for: it stripped a preamble zero times in 57 runs, and the preamble arrives
93% of the time as "Bu sayfa," / "The page introduces". That text is stored and
shown. It is a three-line fix and it is the difference between a summary and a
sentence about a summary.

**Search should ship, with a floor.** Hybrid beats semantic-only by 11.1 points
and the shipped substring pass by 29.2, and it is the only one of the three
that never returns nothing when there is an answer. A `minScore` of 0.40 on the
cosine empties all three nonsense queries and costs exactly one real query that
was already failing.

**One bug needs fixing before it ships, and it is not a threshold.**
`MAX_CANDIDATES` is 1,000 (`retrieval.ts:125`) and the semantic read is
`ORDER BY bookmark_id LIMIT $3` (`retrieval.ts:644`). The comment says "1,000 is
roughly the whole measured library (1,061 bookmarks), so on a real library the
cap never binds". **This library indexes 1,047 rows, so the cap binds, and it
binds on exactly the wrong 47.** Bookmark ids are snowflake timestamps, so
ascending id order is ascending time order: the rows dropped are the 47
**newest** bookmarks, created 2026-09-17 to 2026-09-25, and they are longer than
average (median 570 characters against 359 for the kept rows). Two of my
hand-labelled relevant documents are in that set and would be unsearchable in
production.

**The single biggest caveat the user must know:** every search number here is
measured against a library that is 99% X posts, and the one thing summaries were
designed for — long articles — is almost absent from it. The longest web
capture in 1,061 bookmarks is 251 characters, and the gate needs 400. Search
quality on a library of real articles is untested, and summary quality on a real
article is untested. The Turkish verdict is also drawn from 5 paraphrased
Turkish queries, one of which was a genuine matched pair against English; the
mechanism is understood and demonstrated, but the sample is small.

## Recommended changes

Each tied to something measured above.

1. **Add a `minScore` of 0.40 to the `rankSemantic` call in
   `searchBookmarks`.** `retrieval.ts:796` calls it with the default. Measured:
   3 of 3 nonsense queries go from 1,047 results to zero, at a cost of one real
   query whose relevant document already ranked 543rd. Do **not** put the
   threshold on the fused score — RRF is rank-only, so it cannot see relevance.

2. **Fix `MAX_CANDIDATES`, and the comment that says it cannot bind.**
   `retrieval.ts:125` and the comment at `retrieval.ts:116`. At 1,047 rows the
   cap silently drops the 47 newest and longest bookmarks from the semantic
   half. Raise it, or drop the `LIMIT`, or order the semantic read by something
   that does not make recency the criterion. Whichever, the comment's claim
   that the cap never binds on a real library is false today.

3. **Extend `SUMMARY_LABELS` and `LEADING_LABEL` to catch "Bu sayfa," and
   "The page introduces".** `summarize.ts:338` and `summarize.ts:356`. 53 of 57
   outputs open this way and none are caught, because the pattern requires a
   colon or dash and these use a comma. Either add a comma to the separator
   class for these phrases, or — better — change the prompt to forbid naming the
   artifact at all, since "Bu sayfa," is a preamble wearing a sentence's
   clothes. The prompt already forbids labels; it does not forbid this.

4. **Delete or correct the `note` docstring in `buildSummaryPrompt`.**
   `summarize.ts:304` says "`note` is deliberately absent… summarising it would
   produce a summary of the wrong thing", and `summarize.ts:315` and `:322`
   include it. One of the two is wrong. If the code is right, the comment is
   actively misleading; if the comment is right, `note` is being sent. I did not
   measure this: none of my 19 sample records has a note, so no number in this
   file covers the note path.

5. **Fix the cost table in [retrieval.md](./retrieval.md).** 189,219 tokens,
   $0.00378 to embed the library, $0.00000361 per bookmark, $0.132 for 100 new
   bookmarks a day for a year, 9 batches rather than one request. The search
   figures are 3× over, not under. Add the summarisation cost, which the doc
   does not mention at all: **$0.028** for a full pass over the gate-passing
   population.

6. **Replace the motivating example in the "Search" section.**
   `docs/retrieval.md:128` uses "veritabanı performans sorunu" as the case
   where semantic-only fails. There is no database-performance content in this
   library, so the example is a query with an empty relevant set. Use `Seedance`
   (4/8 semantic, 8/8 hybrid) or `CodeMender` (rank 144 semantic, rank 1
   hybrid) instead — both are real failures of semantic-only on an exact term,
   which is the claim the example is meant to support.

7. **Correct the justification above `MIN_SUMMARISABLE_CHARS`.**
   `summarize.ts:140`. The gate's effect is right and large — 241 records, 68%
   of the spend, 71.7% of the library's description text. The stated reason is
   wrong: `description` is never the 180-character truncation of a longer
   string in this library. Long `description` fields are overwhelmingly **X
   posts**, and **no web capture passes the gate at all**. The comment should
   say that, because as written it argues for the gate using a population that
   does not exist here and implies the feature helps with articles, which on
   this library it cannot.

8. **Do not add the quoted post to the summary prompt.** Not a change — a
   guardrail. Measured: including it produced 4 bad summaries in 6, including
   turning "$320k/year, probably exaggerated" into "$320k/year". If someone
   extends `buildSummaryPrompt` to include `quote`, this table is the argument
   against.

9. **Say in the doc that `cleanSummary` is a cap, not a preamble stripper.**
   Measured 0 label strips in 57 runs. The 15-entry `SUMMARY_LABELS` list and
   the `LEADING_LABEL` loop are currently doing nothing for this model. They
   are not harmful and they are cheap, but the comment at `summarize.ts:441`
   claiming the label problem is the load-bearing one is not supported by a
   single observed instance, while the 93% "Bu sayfa," rate it does not catch
   is.

10. **State the Turkish result in [retrieval.md](./retrieval.md), including the
    part that is uncomfortable.** The doc currently argues from TR-MTEB that
    `text-embedding-3-small` "does not collapse on Turkish". On this library,
    paraphrased Turkish scores 20% under hybrid against English's 65%. The
    mechanism is not Turkish weakness — it is that a user has to guess a
    bookmark's own words, and this library's content mixes Turkish and English
    vocabulary (`tasarım sistemi` versus "design system"). Worth writing down,
    because the next person will otherwise read the aggregate and conclude the
    embedding model is weak on Turkish, which this measurement does not support.

## Contradictions with docs/retrieval.md

Places where a measurement disagrees with the doc, for whoever updates it:

1. **"1,061 bookmarks, 77,008 tokens of embeddable text"** — 189,219 tokens.
   2.93 characters per token measured; the doc's figure implies 7.19, which no
   BPE tokenizer produces.
2. **"Embed the whole library, once — $0.0015"** — $0.00378.
3. **"Re-embed one bookmark — $0.0000015"** — $0.00000361.
4. **"100 new bookmarks a day for a year — $0.06"** — $0.132.
5. **"One search query — $0.0000004" / "10,000 searches — $0.004"** —
   $0.00000013 and $0.0013. Overestimated 3×, so the table has one stale token
   count in it, not a pricing error.
6. **"the whole library is one request, 8.4s"** — `EMBEDDING_BATCH_SIZE` is 128
   and `EMBEDDING_CONCURRENCY` is 2, so 1,047 rows is 9 requests. Measured 4.3s
   wall clock.
7. **"the query 'veritabanı performans sorunu' returned a top hit at 0.44 about
   performance in an unrelated sense"** as the evidence that semantic-only
   misses exact terms — reproduced exactly, but **the query has no relevant
   document in this library**, so it is not evidence. `Seedance` and
   `CodeMender` are.
8. **"1,000 is roughly the whole measured library (1,061 bookmarks), so on a
   real library the cap never binds"** (`retrieval.ts:116`) — the index has
   1,047 rows, so it binds, and drops the 47 **newest** and longer-than-average
   bookmarks.
9. **"a cosine of 0.44 is a *correct* top hit on this library"** as the reason
   `minScore` stays 0 — true (four real queries have a top-1 above 0.44) but
   incomplete: a nonsense query reaches 0.3869, and a 0.40 floor costs one
   already-failing real query to empty all three.
10. **"on a real 1,061-bookmark library most records are X posts whose
    `description` *is* the truncation"** (`summarize.ts:140`) — the 604 records
    where the two fields are byte-identical all have descriptions at or under
    180 characters. On all 443 longer records `shortDescription` is a separate
    `slice(0, 180)`.
11. **"A long article is unreadable in the library list because of it"** — the
    longest web capture in the library is 251 characters and **no web capture
    passes the 400-character gate**. The feature cannot help with articles on
    this library, which is 99% X posts.
12. **"that is most of the work"** about stripping preambles — `cleanSummary`
    stripped a label 0 times in 57 runs. The preamble arrives 93% of the time as
    "Bu sayfa," / "The page introduces", which is not stripped.
13. **The "Measured cost" table does not mention summarisation at all**, and
    `NOOK_SUMMARY_MODEL` is in the Configuration table while no summary cost
    appears anywhere. It is $0.028 for a full pass.
14. **"It does not collapse on Turkish"** — on paraphrased queries, Turkish
    scores 20% under hybrid against English's 65%. The mechanism is vocabulary
    mismatch rather than Turkish weakness, and the one matched intent pair is
    2/6 versus 2/6, but the doc should not leave the aggregate unmentioned.

Two things in the doc that this measurement **confirms** and that should be
kept as written: hybrid beats both halves, and neither half should be dropped —
`CodeMender` at semantic rank 144 and `Seedance` at 4/8 are the evidence, and
the lexical half is what rescues both. And the embedding-model choice is right
for this library: Turkish content with its own vocabulary retrieves at rank 1,
which is not what a model that collapsed on Turkish would do.
