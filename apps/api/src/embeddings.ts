/**
 * The embedding index behind the search half of docs/retrieval.md: what a
 * bookmark says, as a vector, beside a folded copy of the same words.
 *
 * Split the way ai.ts is split. Everything that decides *what* gets indexed is
 * pure and exported, so `embeddedText`, `foldForSearch`, `contentHash` and
 * `planEmbeddingWork` can be tested with no key, no network and no database. The
 * impure half is small and takes its `fetch` by injection for the same reason.
 *
 * Two properties outrank everything else in this file:
 *
 * - **A failed embed never fails a save.** Sync is the trigger here, not the
 *   consumer: `enqueueIndexing` is called after COMMIT and returns immediately,
 *   and every failure below degrades to "not indexed yet" instead of throwing.
 *   `reconcileIndex` is what makes that eventually true, so nothing in this file
 *   is ever the only copy of anything.
 * - **The vector is derived.** It is a pure function of `nook_records.data`, so
 *   every write is an idempotent upsert or delete, the table has no foreign key
 *   into `nook_records`, and a row that disagrees with the bookmark is a bug in
 *   the work plan rather than a conflict to resolve.
 *
 * The wire shapes are duplicated from apps/extension/lib/types.ts rather than
 * imported, as in ai.ts: the api workspace does not depend on the extension.
 */

import { createHash } from "node:crypto";
import type { Pool } from "pg";

// -- configuration --

const OPENAI_EMBEDDINGS_ENDPOINT = "https://api.openai.com/v1/embeddings";

/**
 * `text-embedding-3-small` is a measured choice, not the default-by-omission. On
 * TR-MTEB it is the strongest of the three measured on *retrieval* (64.99) and the
 * weakest on similarity, which only matters if the library is ever clustered into
 * a taxonomy without a generative model naming the clusters. Search is retrieval.
 * At 768 dimensions it is also the cheapest. See docs/retrieval.md.
 */
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

/** Truncation is not re-billed (the same 1,055 texts cost the same at 256, 768
 *  and 1536), so this is a storage dial rather than a commitment. */
const DEFAULT_EMBEDDING_DIM = 768;

/** Generous next to the 8.4s the whole library was measured at, and short enough
 *  that a hung connection releases a pool slot instead of pinning it. */
const REQUEST_TIMEOUT_MS = 30_000;

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Env is read at call time, as in ai.ts, so a test needs no key and a rotated
 *  key is picked up without a restart. */
function envModel(): string {
  return cleanText(process.env.NOOK_EMBEDDING_MODEL) || DEFAULT_EMBEDDING_MODEL;
}

function envDim(): number {
  const parsed = Number(cleanText(process.env.NOOK_EMBEDDING_DIM));
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return DEFAULT_EMBEDDING_DIM;
  return parsed;
}

// -- limits --

/** Per-field caps, the same ones docs/ai.md set for the classification state: a
 *  page capture's `description` is a whole article, and a runaway one must not be
 *  allowed to decide the vector on its own. */
const EMBEDDED_FIELD_LIMITS = {
  title: 500,
  handle: 300,
  note: 4000,
  description: 4000,
  shortDescription: 4000,
} as const;

/** Ceiling on the joined string, and the order the fields are joined in is
 *  therefore the order in which text is lost. Title first (it is the label every
 *  result is shown with), then the handle, then the note: a note is the user's
 *  own words in a few dozen characters, and it is what makes a bookmark findable
 *  by the reason they saved it rather than by what it is about. `description`
 *  comes before `shortDescription` because on this library the latter is a
 *  truncation of the former (see the note in `embeddedText`), so the full text is
 *  the one worth keeping when the two collide. */
const MAX_EMBEDDED_CHARS = 6000;

/**
 * The 40-character floor from docs/ai.md, reused rather than re-measured because
 * it is the same population: a media-only bookmark reduces to a bare title, an
 * emoji, or just the author's handle. 39 of a real 1,061-bookmark library fall
 * under 40 characters. A vector built from one of those matches every other
 * short record and nothing else, so it is pure cost - and, worse, it *is* a
 * result, so it crowds out the real ones.
 */
const MIN_EMBEDDED_CHARS = 40;

// -- types --

/**
 * A synced bookmark, in the shape `syncRecords` returns it. Duplicated rather
 * than imported because sync.ts imports this module: the hook there is one line
 * and a type-only cycle between them buys nothing.
 */
export interface IndexableRecord {
  id: string;
  /** The record as the client authored it - the same jsonb that is authoritative. */
  data: Record<string, unknown>;
  /**
   * Only the reconciler sets this, from `nook_records.deleted_at`. Sync carries
   * the same fact inside `data.deletedAt`, and `isDeleted` reads both, so a record
   * cannot be a tombstone to one caller and a live bookmark to another.
   */
  deletedAt?: string | null;
}

/** One row of `nook_embeddings` for the model it was written under, which is
 *  exactly the comparison the work plan needs and nothing more. */
export interface IndexedEntry {
  content_hash: string;
  model: string;
  dim: number;
}

export interface EmbeddingAvailability {
  /** `OPENAI_API_KEY` is present, so the index can be built at all. The client
   *  keeps its local substring pass when this is false and does not pretend the
   *  server is thinking. */
  available: boolean;
  /** The model that a row would be written under right now, defaults included. */
  model: string;
  dim: number;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Injectable so the unit tests never touch the network. */
export interface EmbeddingDeps {
  fetch?: FetchLike;
}

// -- pure: what we embed --

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function capText(value: unknown, max: number): string | undefined {
  const text = cleanText(value);
  return text === undefined ? undefined : truncate(text, max);
}

function creatorHandle(data: Record<string, unknown>): unknown {
  const creator = data.creator;
  if (!creator || typeof creator !== "object" || Array.isArray(creator)) return undefined;
  return (creator as Record<string, unknown>).handle;
}

/**
 * The exact string that gets embedded, hashed and folded. `""` means "not worth
 * embedding", which is a different answer from "no text".
 *
 * Only five fields, and never the rest: `url` because a query string can carry a
 * session token and the tokens are pure noise to a model, `media` because it is a
 * list of URLs, `tags` because they are the user's own vocabulary and a `#tag`
 * query already answers exactly and locally, and `ai` because it is a receipt
 * about an automated decision rather than anything about the bookmark. That is
 * the filter ai.md already established for classification, widened to the full
 * `description`.
 *
 * `shortDescription` and `description` are both included because the doc names
 * both and they are not always the same relationship: a web capture sets
 * `shortDescription` to the first 180 characters of `description`, but other
 * records carry only one of the two, and dropping either loses half the library's
 * text. Where they do overlap the same sentence is sent twice, which is a
 * duplicate in the vector - a real cost this accepts deliberately, because the
 * alternative (guessing which one a given record has) is wrong more often.
 *
 * Lifecycle is deliberately NOT read here: whether a record is live is a question
 * for the work plan, and folding it into a text extractor would make
 * "deleted" and "too short to be worth embedding" the same return value.
 */
export function embeddedText(record: IndexableRecord): string {
  const data = (record?.data ?? {}) as Record<string, unknown>;
  const parts = [
    capText(data.title, EMBEDDED_FIELD_LIMITS.title),
    capText(creatorHandle(data), EMBEDDED_FIELD_LIMITS.handle),
    capText(data.note, EMBEDDED_FIELD_LIMITS.note),
    capText(data.description, EMBEDDED_FIELD_LIMITS.description),
    capText(data.shortDescription, EMBEDDED_FIELD_LIMITS.shortDescription),
  ].filter((part): part is string => Boolean(part));
  const text = parts.join("\n").slice(0, MAX_EMBEDDED_CHARS);
  return text.length < MIN_EMBEDDED_CHARS ? "" : text;
}

/** A tombstone, by either signal. See `IndexableRecord.deletedAt`. */
function isDeleted(record: IndexableRecord): boolean {
  return cleanText(record.deletedAt) !== undefined || cleanText(record.data?.deletedAt) !== undefined;
}

// -- pure: folding --

/**
 * Any letter that marks a word as Turkish, which is the only thing that tells us
 * which lowercasing rules to use. Note the absence of "i" and "I": they are the
 * whole problem - see the note on `foldWord`.
 *
 * Deliberately the same expression as `TURKISH_LETTER` in
 * apps/extension/lib/ai-classify.ts. Copied rather than imported: the api
 * workspace does not depend on the extension, and a fold that disagrees between
 * the two sides writes keys nothing can find again.
 */
const TURKISH_LETTER = /[ıİğĞşŞçÇöÖüÜ]/;

/**
 * Lowercases one word in the locale that word is written in.
 *
 * Per word, not per string, and that is the part that matters. A single string in
 * this library mixes both: "UI Tasarımları" is an English initialism next to a
 * Turkish noun. Under the Turkish locale "UI" becomes "uı"; under the default
 * locale "İş" becomes "i̇ş" with a combining dot that no user can type back. Folding
 * word by word gets both right.
 *
 * Same behaviour as `foldWord` in apps/extension/lib/ai-classify.ts, on purpose.
 */
function foldWord(word: string): string {
  return TURKISH_LETTER.test(word) ? word.toLocaleLowerCase("tr") : word.toLowerCase();
}

/**
 * Latin letters whose diacritic is not a separate code point, so the combining
 * mark sweep below cannot reach them.
 *
 * `ı` leads the list and its mapping is the one that is a decision rather than a
 * convention: folding the dotless i onto the dotted i makes "ısı" findable by a
 * user who types "isi", which is a trade this index should make and `foldCase`
 * in the extension should not. There the two must stay distinct, because a stored
 * tag has to match what the user retypes. Here the query and the column are
 * folded by the same function, so conflation can only add recall, never subtract
 * it. The rest are the common European letters, for a library that is not purely
 * Turkish.
 */
const UNDECOMPOSED_LETTERS: Record<string, string> = {
  "ı": "i",
  "ø": "o",
  "đ": "d",
  "ð": "d",
  "þ": "t",
  "ł": "l",
  "ß": "ss",
  "æ": "ae",
  "œ": "oe",
};

const UNDECOMPOSED_PATTERN = new RegExp(`[${Object.keys(UNDECOMPOSED_LETTERS).join("")}]`, "gu");

/** Combining marks, which is what NFD leaves behind for ç ğ ö ş ü and friends. */
const COMBINING_MARK = /\p{M}/gu;

/**
 * The form written to `search_text`, so that `ILIKE` over it is both
 * case-insensitive and accent-insensitive.
 *
 * A plain `tsvector` does badly on this library: Turkish agglutination defeats
 * stemming ("kitap" should find "kitapları"), and Postgres' `unaccent` is an
 * extension, which this schema does not use. Pre-folding the text is
 * dependency-free, and the folding is written in JS because the folding the repo
 * already has - `foldCase` in apps/extension/lib/ai-classify.ts - is Turkish-aware
 * and, as the two bugs in its own comments record, was not the first version.
 *
 * Three steps, in this order:
 *
 * 1. Per-word case fold, so `İ` becomes a plain `i` and `I` inside "UI" survives
 *    as `i` rather than becoming `ı`.
 * 2. `NFD` and drop the combining marks, which is what actually removes the
 *    accents - and which also cleans up `İ` a second time, since the default
 *    locale turns it into "i" plus a dot that step 3 then throws away. A belt to
 *    the braces of step 1, and the reason the output is guaranteed mark-free.
 * 3. The letters NFD cannot decompose, from `UNDECOMPOSED_LETTERS`.
 *
 * Idempotent by construction, and that is the property worth having: the output
 * contains no uppercase, no `I`, no `İ` and no combining marks, so a second pass
 * has nothing left to change. It has to be idempotent because the column is
 * written once and re-read forever - a fold that converged slowly would make the
 * index's own spelling depend on how many times it had been through.
 *
 * Splits on any whitespace run rather than the single space `foldCase` splits on,
 * because the embedded text is joined across fields, and drops the empty words a
 * leading or trailing run produces. The only visible difference from `foldCase`
 * is that runs of whitespace collapse to one space, which nothing in a
 * whitespace-separated term match can tell apart, and which is the right answer
 * for a column meant to be `ILIKE`'d.
 */
export function foldForSearch(text: string): string {
  return text
    .split(/\s+/)
    .filter((word) => word !== "")
    .map(foldWord)
    .join(" ")
    .normalize("NFD")
    .replace(COMBINING_MARK, "")
    .replace(UNDECOMPOSED_PATTERN, (letter) => UNDECOMPOSED_LETTERS[letter]);
}

// -- pure: the content hash --

/**
 * A stable hash of the embedded text, and the gate on spending money.
 *
 * Over the embedded text and nothing else. `updatedAt` moves when a tag is edited,
 * a note is added or a sync lands, none of which change what was embedded, so
 * hashing the record would re-embed the library on every tag edit. One hash per
 * record over at most 6,000 characters is microseconds, and sha256 is the
 * shortest thing that is obviously not going to collide.
 */
export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// -- pure: the work plan --

export interface EmbeddingWorkPlan {
  /** Ids to embed: new, or whose text, model or dim differs. */
  embed: string[];
  /** Ids whose row must go: the bookmark was deleted, or no longer has enough
   *  text to embed. Never "skip and keep" - see `planEmbeddingWork`. */
  remove: string[];
  /** Ids deliberately left alone. This is the whole cost argument: a tag edit
   *  that does not change the text ends up here and costs one SELECT. */
  skip: string[];
}

function emptyPlan(): EmbeddingWorkPlan {
  return { embed: [], remove: [], skip: [] };
}

/**
 * Which of `records` are worth a request, given what is already indexed. Pure and
 * total: a record with no id, or an id that is not a string, is ignored rather
 * than thrown on, because the caller is a loop over a sync response.
 *
 * `existing` is scoped to one model - the active one. That is what makes a model
 * change work with no migration and no marker row: under the new model the
 * user has no rows at all, so every bookmark looks new and gets re-embedded, and
 * the rows written by the previous model stay invisible to every query (they all
 * filter on `model`). A `dim` change is caught the same way, by comparison,
 * because those rows do exist under the active model and simply disagree.
 */
export function planEmbeddingWork(
  records: readonly IndexableRecord[],
  existing: ReadonlyMap<string, IndexedEntry>,
  model: string = envModel(),
  dim: number = envDim(),
): EmbeddingWorkPlan {
  const plan = emptyPlan();
  for (const record of records) {
    if (!record || typeof record.id !== "string" || record.id === "") continue;
    const row = existing.get(record.id);
    const text = embeddedText(record);
    if (isDeleted(record) || text === "") {
      // A row for a bookmark that is gone, or that has lost its text, is worse
      // than no row: it is a vector the search will happily return for something
      // the user deleted. And skipping it is permanent - nothing else ever looks
      // at that row again, so it would survive every future pass.
      (row ? plan.remove : plan.skip).push(record.id);
      continue;
    }
    if (row && row.content_hash === contentHash(text) && row.model === model && row.dim === dim) {
      plan.skip.push(record.id);
      continue;
    }
    plan.embed.push(record.id);
  }
  return plan;
}

// -- the call --

/**
 * Inputs per request. The endpoint accepts 2,048, but its real ceiling is tokens:
 * 300,000 across the whole batch. The measured library averages 73 tokens per
 * bookmark (77,008 tokens over 1,055 texts), so a count cap big enough to put
 * that library in one request - which is the 8.4s figure docs/retrieval.md
 * measured - would blow that ceiling on the *worst* case, a bookmark at the
 * 6,000-character cap (~1,500 tokens). 128 is the largest count whose worst case
 * (~192,000 tokens) still fits, and at the measured average it is a ~9,300-token
 * request.
 *
 * The cost of that safety is that the library takes 9 requests instead of 1:
 * about 38 seconds of background work for $0.0015. Batching exists to keep the
 * request count proportional to the library, not to make it exactly one.
 */
export const EMBEDDING_BATCH_SIZE = 128;

/**
 * Requests in flight. Two is enough to overlap the ~8s round trip, which is the
 * only reason to batch at all, while leaving a low-tier key nowhere near its
 * limit. Four would halve a full pass to about 19 seconds and buy nothing a user
 * can see, because none of this work is ever in front of a request.
 */
export const EMBEDDING_CONCURRENCY = 2;

export interface EmbeddedVector {
  /**
   * Position in the input array, carried rather than implied by array order
   * because a batch that fails leaves a hole: a caller pairing vectors up by
   * position with the texts it sent would write a bookmark's neighbour's vector
   * over it, and the failure would be silent and permanent.
   */
  index: number;
  vector: number[];
}

export interface EmbedTextsResult {
  vectors: EmbeddedVector[];
  /** The provider's own numbers, not an estimate - this is the only record of
   *  what a pass cost, and the doc's cost table was built from it. */
  usage: { promptTokens: number; totalTokens: number };
  batches: number;
  failedBatches: number;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

interface BatchOutcome {
  vectors: EmbeddedVector[];
  promptTokens: number;
  totalTokens: number;
  failed: boolean;
}

const NO_BATCH: BatchOutcome = { vectors: [], promptTokens: 0, totalTokens: 0, failed: true };

/** One request. Never throws: this is a background pass, and a throw here would
 *  surface on a sync that has already committed. */
async function embedBatch(
  texts: readonly string[],
  offset: number,
  apiKey: string,
  model: string,
  dim: number,
  doFetch: FetchLike,
): Promise<BatchOutcome> {
  let response: Response;
  try {
    response = await doFetch(OPENAI_EMBEDDINGS_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: [...texts], dimensions: dim }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn(`[embeddings] batch of ${texts.length} failed: ${errorMessage(error)}`);
    return NO_BATCH;
  }
  if (!response.ok) {
    console.warn(`[embeddings] batch of ${texts.length} failed: ${response.status}`);
    return NO_BATCH;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    console.warn(`[embeddings] batch of ${texts.length} returned malformed JSON: ${errorMessage(error)}`);
    return NO_BATCH;
  }

  const envelope = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const data = Array.isArray(envelope.data) ? envelope.data : [];
  const rawUsage = (envelope.usage && typeof envelope.usage === "object" ? envelope.usage : {}) as Record<
    string,
    unknown
  >;
  const usage = {
    promptTokens: Math.max(0, Math.trunc(Number(rawUsage.prompt_tokens) || 0)),
    totalTokens: Math.max(0, Math.trunc(Number(rawUsage.total_tokens) || 0)),
  };

  const vectors: EmbeddedVector[] = [];
  for (let position = 0; position < data.length; position++) {
    const entry = (data[position] && typeof data[position] === "object" ? data[position] : {}) as Record<
      string,
      unknown
    >;
    const embedding = entry.embedding;
    if (!Array.isArray(embedding) || embedding.length !== dim) {
      // A vector of the wrong length is not a smaller index, it is a different
      // space: a query embedded at the configured dim would be compared against
      // it and produce a number that means nothing. Losing the batch is the only
      // safe reading, and it is cheap to lose - the reconciler will try again.
      console.warn(`[embeddings] discarding a batch: expected ${dim} dimensions, got a vector that is not`);
      return { vectors: [], ...usage, failed: true };
    }
    // `index` is relative to this batch. Trust the position we read it at when it
    // is missing or out of range, and never write outside the texts we sent.
    const local = Number.isInteger(entry.index) ? Number(entry.index) : position;
    if (local < 0 || local >= texts.length) continue;
    vectors.push({ index: offset + local, vector: embedding.map(Number) });
  }

  if (vectors.length === 0) {
    console.warn(`[embeddings] batch of ${texts.length} returned no embeddings`);
    return { vectors: [], ...usage, failed: true };
  }
  return { vectors, ...usage, failed: false };
}

/**
 * Embed a list of texts, in batches, at low concurrency.
 *
 * Degrades to an empty result rather than throwing: a failed embed must never
 * fail a sync, and the reconciler is the backstop for whatever is missing. A
 * batch that fails takes only its own texts down - the batches around it still
 * land, which is the reason failures are handled per batch rather than around the
 * whole run.
 */
export async function embedTexts(
  texts: readonly string[],
  deps: EmbeddingDeps = {},
): Promise<EmbedTextsResult> {
  const batches = texts.length > 0 ? Math.ceil(texts.length / EMBEDDING_BATCH_SIZE) : 0;
  const empty: EmbedTextsResult = {
    vectors: [],
    usage: { promptTokens: 0, totalTokens: 0 },
    batches,
    failedBatches: 0,
  };
  if (texts.length === 0) return empty;

  const apiKey = cleanText(process.env.OPENAI_API_KEY);
  if (!apiKey) {
    console.warn("[embeddings] OPENAI_API_KEY is not configured; nothing embedded");
    return { ...empty, failedBatches: batches };
  }

  const model = envModel();
  const dim = envDim();
  const doFetch = deps.fetch ?? fetch;
  const result: EmbedTextsResult = {
    vectors: [],
    usage: { promptTokens: 0, totalTokens: 0 },
    batches,
    failedBatches: 0,
  };

  // The offset travels with the batch rather than being recovered from it: a
  // duplicated text is a perfectly normal thing to be asked to embed, and looking
  // the batch's first text back up in the input would find the earlier copy.
  const queued = chunk(texts, EMBEDDING_BATCH_SIZE).map((batch, position) => ({
    offset: position * EMBEDDING_BATCH_SIZE,
    texts: batch,
  }));
  for (const window of chunk(queued, EMBEDDING_CONCURRENCY)) {
    const settled = await Promise.all(
      window.map((batch) => embedBatch(batch.texts, batch.offset, apiKey, model, dim, doFetch)),
    );
    for (const outcome of settled) {
      result.vectors.push(...outcome.vectors);
      result.usage.promptTokens += outcome.promptTokens;
      result.usage.totalTokens += outcome.totalTokens;
      if (outcome.failed) result.failedBatches++;
    }
  }
  result.vectors.sort((left, right) => left.index - right.index);
  return result;
}

// -- persistence --

export interface IndexRecordsResult {
  embedded: number;
  removed: number;
  skipped: number;
  failedBatches: number;
  usage: { promptTokens: number; totalTokens: number };
  /** Set when the pass gave up. Carried rather than thrown: the caller is a
   *  detached queue entry, where a rejection is a crash. */
  error?: string;
}

function zeroIndexResult(): IndexRecordsResult {
  return {
    embedded: 0,
    removed: 0,
    skipped: 0,
    failedBatches: 0,
    usage: { promptTokens: 0, totalTokens: 0 },
  };
}

async function readIndexed(
  pool: Pool,
  userId: string,
  model: string,
  ids: readonly string[],
): Promise<Map<string, IndexedEntry>> {
  const result = await pool.query<{ bookmark_id: string; content_hash: string; model: string; dim: number }>(
    `SELECT bookmark_id, content_hash, model, dim FROM nook_embeddings
     WHERE user_id=$1 AND model=$2 AND bookmark_id = ANY($3::text[])`,
    [userId, model, [...ids]],
  );
  return new Map(
    result.rows.map((row) => [row.bookmark_id, { content_hash: row.content_hash, model: row.model, dim: row.dim }]),
  );
}

async function deleteRows(pool: Pool, userId: string, model: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `DELETE FROM nook_embeddings WHERE user_id=$1 AND model=$2 AND bookmark_id = ANY($3::text[])`,
    [userId, model, [...ids]],
  );
}

async function upsertRow(
  pool: Pool,
  userId: string,
  model: string,
  bookmarkId: string,
  dim: number,
  hash: string,
  searchText: string,
  vector: readonly number[],
): Promise<void> {
  await pool.query(
    `INSERT INTO nook_embeddings (user_id, model, bookmark_id, dim, content_hash, search_text, vector)
     VALUES ($1, $2, $3, $4, $5, $6, $7::real[])
     ON CONFLICT (user_id, model, bookmark_id) DO UPDATE SET
       dim=EXCLUDED.dim,
       content_hash=EXCLUDED.content_hash,
       search_text=EXCLUDED.search_text,
       vector=EXCLUDED.vector,
       updated_at=now()`,
    [userId, model, bookmarkId, dim, hash, searchText, [...vector]],
  );
}

/**
 * Index a batch of records: upsert the ones whose text changed, delete the ones
 * that no longer deserve a row.
 *
 * Re-reads the index for exactly the ids it was handed rather than trusting the
 * caller, because the caller's `applied` list can be minutes old in the queue and
 * a record that was indexed since then needs no second request. That re-read is
 * also what makes the content hash worth having: it is the difference between one
 * embedding request per sync and one per bookmark.
 *
 * Never throws, and never holds a transaction: the vector is derived, so a
 * half-finished batch is a library with some bookmarks not yet findable, which is
 * the ordinary state of a background index.
 */
export async function indexRecords(
  pool: Pool,
  userId: string,
  records: readonly IndexableRecord[],
  deps: EmbeddingDeps = {},
): Promise<IndexRecordsResult> {
  const byId = new Map<string, IndexableRecord>();
  for (const record of records) {
    if (record && typeof record.id === "string" && record.id !== "" && !byId.has(record.id)) {
      byId.set(record.id, record);
    }
  }
  if (byId.size === 0) return zeroIndexResult();

  const model = envModel();
  const dim = envDim();
  const result = zeroIndexResult();
  try {
    const existing = await readIndexed(pool, userId, model, [...byId.keys()]);
    const plan = planEmbeddingWork([...byId.values()], existing, model, dim);
    result.skipped = plan.skip.length;

    await deleteRows(pool, userId, model, plan.remove);
    result.removed = plan.remove.length;

    // Only the ids with text go to the provider, in one deterministic order, so
    // the vector at position i always belongs to the record at position i.
    const pending = plan.embed.map((id) => byId.get(id)).filter((record): record is IndexableRecord => Boolean(record));
    if (pending.length === 0) return result;
    const embedded = await embedTexts(pending.map((record) => embeddedText(record)), deps);
    result.failedBatches = embedded.failedBatches;
    result.usage = embedded.usage;

    const vectors = new Map(embedded.vectors.map((entry) => [entry.index, entry.vector]));
    for (let position = 0; position < pending.length; position++) {
      const vector = vectors.get(position);
      // A hole means this record's batch failed. Leave it unindexed rather than
      // guess: the reconciler will come back for it.
      if (!vector) continue;
      const record = pending[position];
      const text = embeddedText(record);
      await upsertRow(pool, userId, model, record.id, dim, contentHash(text), foldForSearch(text), vector);
      result.embedded++;
    }
    return result;
  } catch (error) {
    result.error = errorMessage(error);
    console.warn(`[embeddings] indexing ${byId.size} records for ${userId} failed: ${result.error}`);
    return result;
  }
}

// -- the queue --

interface QueueJob {
  pool: Pool;
  userId: string;
  records: IndexableRecord[];
  deps: EmbeddingDeps;
}

/** Bounds a runaway sync loop. Work lost here is exactly the work
 *  `reconcileIndex` exists to find, so this is a warning and not an error. */
const MAX_QUEUED_JOBS = 32;

const queue: QueueJob[] = [];
let inFlight = 0;

/**
 * The hook the sync route calls. Returns immediately and does no I/O on the
 * calling path: a sync response is never delayed by an embedding round trip, and
 * nothing in here can fail a sync that has already committed.
 *
 * `records` must be bookmarks. The sync hook filters on `kind`, and nothing else
 * calls this; a list has no text worth a vector and no way to tell it apart here.
 *
 * Batching comes from this boundary rather than from the queue: a sync of 100
 * records is one job, so it is one SELECT and at most `ceil(100/128)` requests.
 * Repeated enqueues of the same bookmark are not coalesced, and do not need to be
 * - each job re-checks the content hash, so the redundant ones cost one SELECT
 * and no request.
 */
export function enqueueIndexing(
  pool: Pool,
  userId: string,
  records: readonly IndexableRecord[],
  deps: EmbeddingDeps = {},
): void {
  if (!embeddingAvailability().available) return;
  const bookmarkRecords = records.filter((record) => record && typeof record.id === "string" && record.id !== "");
  if (bookmarkRecords.length === 0) return;
  if (queue.length >= MAX_QUEUED_JOBS) {
    console.warn(
      `[embeddings] index queue is full (${MAX_QUEUED_JOBS} jobs); dropping ${bookmarkRecords.length} records for reconciliation`,
    );
    return;
  }
  queue.push({ pool, userId, records: bookmarkRecords, deps });
  drain();
}

async function runJob(job: QueueJob): Promise<void> {
  try {
    const result = await indexRecords(job.pool, job.userId, job.records, job.deps);
    if (result.error) console.warn(`[embeddings] queued indexing failed for ${job.userId}: ${result.error}`);
  } catch (error) {
    // Unreachable: indexRecords never throws. Kept because this runs detached
    // from any request, where an unhandled rejection takes the process with it.
    console.error(`[embeddings] queued indexing crashed for ${job.userId}: ${errorMessage(error)}`);
  }
}

function drain(): void {
  while (inFlight < EMBEDDING_CONCURRENCY && queue.length > 0) {
    const job = queue.shift();
    if (!job) return;
    inFlight++;
    void runJob(job).finally(() => {
      inFlight--;
      drain();
    });
  }
}

// -- reconciliation --

export interface ReconcileResult {
  scanned: number;
  scheduled: number;
  removed: number;
  error?: string;
}

async function readLiveBookmarks(pool: Pool, userId: string): Promise<IndexableRecord[]> {
  // Tombstones are excluded rather than read and filtered: a soft-deleted
  // record's index row is an orphan by definition, and this is the pass that
  // finds orphans.
  const result = await pool.query<{ id: string; data: Record<string, unknown>; deleted_at: string | null }>(
    `SELECT id, data, deleted_at FROM nook_records
     WHERE user_id=$1 AND kind='bookmark' AND deleted_at IS NULL`,
    [userId],
  );
  return result.rows.map((row) => ({ id: row.id, data: row.data, deletedAt: row.deleted_at }));
}

/**
 * The backstop. Finds everything the queue missed and hands it to the queue.
 *
 * Three things end up wrong on their own, and only the first is obvious:
 *
 * - **A restart in the middle of a pass.** The queue is in-process, so anything
 *   still in it when the process dies is gone, and nothing re-sends those syncs.
 * - **A model change.** `readAllIndexed` filters on the active model, so under a
 *   new model the user has no rows at all, every live bookmark looks new, and the
 *   whole library is re-embedded. That is the entire mechanism, and it is why
 *   `model` and `dim` are stored beside every vector: there is no migration to run
 *   and no marker row to keep in step, and the rows written by the previous model
 *   are invisible rather than wrong, because every query filters on `model`.
 * - **A dim change.** Those rows do exist under the active model, so this one is
 *   caught by the `row.dim` comparison in `planEmbeddingWork`.
 *
 * Also deletes rows whose bookmark is gone. A bookmark deleted while the process
 * was down leaves a vector that a search would otherwise keep returning, and
 * nothing else in the system would ever look at that row again.
 *
 * Chunked to the provider's batch size so one queue entry is one request, and so
 * a ten-thousand-bookmark library does not become a single unbounded job.
 */
export async function reconcileIndex(
  pool: Pool,
  userId: string,
  deps: EmbeddingDeps = {},
): Promise<ReconcileResult> {
  const model = envModel();
  const dim = envDim();
  try {
    const [records, indexed] = await Promise.all([
      readLiveBookmarks(pool, userId),
      readAllIndexed(pool, userId, model),
    ]);
    const live = new Set(records.map((record) => record.id));
    const orphans = [...indexed.keys()].filter((id) => !live.has(id));
    await deleteRows(pool, userId, model, orphans);

    const plan = planEmbeddingWork(records, indexed, model, dim);
    await deleteRows(pool, userId, model, plan.remove);

    const byId = new Map(records.map((record) => [record.id, record]));
    const work = plan.embed
      .map((id) => byId.get(id))
      .filter((record): record is IndexableRecord => Boolean(record));
    for (const batch of chunk(work, EMBEDDING_BATCH_SIZE)) enqueueIndexing(pool, userId, batch, deps);

    return { scanned: records.length, scheduled: work.length, removed: orphans.length + plan.remove.length };
  } catch (error) {
    const message = errorMessage(error);
    console.warn(`[embeddings] reconciliation failed for ${userId}: ${message}`);
    return { scanned: 0, scheduled: 0, removed: 0, error: message };
  }
}

async function readAllIndexed(pool: Pool, userId: string, model: string): Promise<Map<string, IndexedEntry>> {
  const result = await pool.query<{ bookmark_id: string; content_hash: string; model: string; dim: number }>(
    `SELECT bookmark_id, content_hash, model, dim FROM nook_embeddings WHERE user_id=$1 AND model=$2`,
    [userId, model],
  );
  return new Map(
    result.rows.map((row) => [row.bookmark_id, { content_hash: row.content_hash, model: row.model, dim: row.dim }]),
  );
}

// -- availability --

/**
 * Whether the index can be built, and under what model and dimension. Exported so
 * the search route can report it without importing the database side of this file.
 */
export function embeddingAvailability(): EmbeddingAvailability {
  return {
    available: Boolean(cleanText(process.env.OPENAI_API_KEY)),
    model: envModel(),
    dim: envDim(),
  };
}
