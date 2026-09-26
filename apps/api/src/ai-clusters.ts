/**
 * Suggestions from clusters (docs/ai.md, "Suggestions from clusters"): the
 * inverted taxonomy flow. The existing "Suggest collections" feature
 * (ai-taxonomy.ts / ai-jobs.ts's taxonomy routes) shows a generative model an
 * 80-to-200-bookmark sample, asks it to invent collection names, and then
 * classifies the *whole* library one bookmark at a time against those names.
 * Measured on a real 1,063-bookmark library of saved posts, that filed only
 * ~24%: the sample never covers a library that size, so most bookmarks are
 * never even considered against the names the model happened to invent.
 *
 * Every bookmark already carries an embedding (`nook_embeddings`,
 * `text-embedding-3-small` — docs/retrieval.md), so the fix is to invert the
 * order of operations: cluster the account's *unfiled* bookmarks by embedding
 * first — deterministic, dependency-free math in `cluster-math.ts` — and only
 * then ask the generative model to do the one thing it is actually needed for,
 * which is to *name* a handful of already-formed groups. Filing is instant on
 * acceptance, because cluster membership is already known; nothing has to be
 * classified one bookmark at a time.
 *
 * Split the way ai.ts/ai-taxonomy.ts/ai-jobs.ts already are: `cluster-math.ts`
 * is the pure half (no `fetch`, no `pg`), and this file is the impure half —
 * the reads, the one proposer call, and the write path. It reuses rather than
 * reimplements: `resolveProposer`/`generate`/`stripCodeFence` from ./ai.ts are
 * the exact same provider/model/key resolution and JSON-output hardening the
 * taxonomy proposer uses (both additive exports on that file — no behaviour
 * there changed), `planLists` from ./ai-taxonomy.ts is the same collision
 * discipline `acceptTaxonomyForUser` uses to create list rows, and
 * `readAcceptedTaxonomy`/`saveAcceptedTaxonomy` from ./ai-store.ts are the same
 * account row `acceptTaxonomyForUser` writes, so a newly-filed cluster's name is
 * offered to the classifier on its very next pass exactly the way an accepted
 * taxonomy name already is.
 */

import type { Pool, PoolClient } from "pg";
import {
  type AiDeps,
  type ProposalMessages,
  type TaxonomyLanguage,
  generate,
  resolveProposer,
  stripCodeFence,
} from "./ai.js";
import { foldCase, type AiTaxonomyOption, type ClassifiableList } from "./ai-classify.js";
import { clusterEmbeddings } from "./cluster-math.js";
import { planLists, type AcceptedTaxonomy, type TaxonomyProposal } from "./ai-taxonomy.js";
import { readAcceptedTaxonomy, saveAcceptedTaxonomy } from "./ai-store.js";
import { getAiUserSettings } from "./ai-settings.js";
import { embeddingAvailability } from "./embeddings.js";
// Reused rather than duplicated: the same "not configured" signal the taxonomy
// routes already throw, so the route below maps it to the same 503 by catching
// the same class.
import { ProposerUnavailableError } from "./ai-jobs.js";

// -- errors -------------------------------------------------------------------

/**
 * The proposer *is* configured, but the one naming call itself failed (network
 * error, non-2xx, or a response with no usable content) — distinct from
 * `ProposerUnavailableError`, which means "there is no proposer to call at
 * all". The existing `/api/ai/taxonomy/propose` route only ever needs the
 * first kind (`proposeTaxonomy` in ./ai.ts silently degrades a failed call to
 * an empty result), but this route's contract asks for the failure to be
 * visible — a naming round that silently returned nothing would look, to the
 * "Organize" page, exactly like a library with no clusterable structure at
 * all, which is a materially different thing to tell the user.
 */
export class ProposerCallFailedError extends Error {}

// -- limits ---------------------------------------------------------------

/** Below this many unfiled, embedded bookmarks there is nothing to cluster
 *  meaningfully — `cluster-math.ts`'s own `minClusterSize` floor (5, or 2% of
 *  n) would not leave room for more than one or two groups anyway, and it is
 *  cheaper to say so before spending a proposer call finding that out. */
const MIN_CONSIDERED = 20;

/** Sent to the naming model per cluster: enough for it to recognise a theme
 *  without paying for a whole cluster's worth of titles. Mirrors
 *  `MAX_OPTION_SAMPLES` in ai-taxonomy.ts, which is the same trade for the
 *  existing taxonomy flow's collection digests. */
const REPRESENTATIVES_PER_CLUSTER = 6;

/** Kept in the response for the review UI's preview line. Capped at 5 per the
 *  route contract. */
const SAMPLE_TITLES_KEPT = 5;

/** A representative's text is a label, not a body — mirrors `MAX_TITLE_CHARS`
 *  in ai.ts/ai-taxonomy.ts. */
const MAX_SNIPPET_CHARS = 200;

export const MAX_ACCEPTED_COLLECTIONS = 50;
export const MAX_ACCEPTED_MEMBER_IDS = 5000;

/** Per-collection sample cap on acceptance, matching `MAX_OPTION_SAMPLES` in
 *  ai-taxonomy.ts — the same number of member titles the existing taxonomy
 *  flow keeps per accepted collection, for the same reason: a few titles are
 *  enough evidence, and every extra one costs context on the next
 *  classification pass that reads this record. */
const MAX_ACCEPTED_SAMPLES = 5;

// -- small helpers ----------------------------------------------------------

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function collapseName(value: unknown): string {
  const text = cleanText(value);
  return text ? text.replace(/\s+/g, " ") : "";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The same key `collectionKey` in ai-taxonomy.ts computes, and it MUST stay
 * identical: that private helper is what decides a name collides with a live
 * collection there, and this file makes the same decision at acceptance time
 * ("a name that collides with a live list files into that list instead"). Not
 * imported because it is not exported — this is the same "two copies kept in
 * step by hand" discipline `foldCase` and `normalizeTagName` already use
 * across the api/extension boundary, one file closer to home.
 */
function collectionKey(name: string): string {
  const collapsed = collapseName(name);
  const withoutHash = collapsed.startsWith("#") ? collapsed.slice(1) : collapsed;
  return foldCase(withoutHash.trim());
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string" || url.trim() === "") return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

function unitVector(vector: readonly number[]): number[] {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) return vector.map(() => 0);
  return vector.map((value) => value / norm);
}

/** Cosine similarity of two already-unit vectors is a plain dot product. Used
 *  only to *rank* a cluster's own members by nearness to its centroid — a
 *  presentation concern, not a clustering decision, so it does not need to
 *  share machinery with cluster-math.ts's own (unit-vector) distance math. */
function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length && i < b.length; i++) sum += a[i] * b[i];
  return sum;
}

// -- reading the library ------------------------------------------------------

export interface EmbeddedBookmark {
  id: string;
  text: string;
  site?: string;
  author?: string;
  vector: number[];
}

interface EmbeddedRow {
  id: string;
  title: string | null;
  short_description: string | null;
  note: string | null;
  url: string | null;
  handle: string | null;
  vector: number[];
}

function toEmbeddedBookmark(row: EmbeddedRow): EmbeddedBookmark {
  const text = truncate(cleanText(row.title) ?? cleanText(row.short_description) ?? cleanText(row.note) ?? "", MAX_SNIPPET_CHARS);
  const site = hostOf(row.url);
  const author = cleanText(row.handle);
  return { id: row.id, text, ...(site ? { site } : {}), ...(author ? { author } : {}), vector: row.vector };
}

/**
 * The account's live, unfiled bookmarks that already have an embedding under
 * the active model/dim — exactly the population the problem statement names:
 * "cluster the unfiled library by embedding". `listId IS NULL` is the same
 * eligibility half classification's own `bookmarkNeedsClassification` reads
 * (the `ai == null` half is deliberately NOT applied here: a bookmark the
 * classifier already ruled "nothing fits" is still unfiled and still exactly
 * the kind of bookmark this feature exists to find a home for — the two
 * features answer different questions about the same "still unfiled" state).
 *
 * The join to `nook_embeddings` on `(model, dim)` is what "already has an
 * embedding" means precisely: a row under a stale model or dimension is
 * invisible here for the same reason every other embedding read in this repo
 * filters on both (docs/retrieval.md, "one model per index") — comparing a
 * vector from one embedding space against another produces a number that means
 * nothing.
 */
async function readUnfiledEmbedded(pool: Pool, userId: string, model: string, dim: number): Promise<EmbeddedBookmark[]> {
  const result = await pool.query<EmbeddedRow>(
    `SELECT r.id,
            r.data->>'title'              AS title,
            r.data->>'shortDescription'   AS short_description,
            r.data->>'note'               AS note,
            r.data->>'url'                AS url,
            r.data->'creator'->>'handle'  AS handle,
            e.vector
     FROM nook_records r
     JOIN nook_embeddings e ON e.user_id = r.user_id AND e.bookmark_id = r.id AND e.model = $2 AND e.dim = $3
     WHERE r.user_id = $1 AND r.kind = 'bookmark' AND r.deleted_at IS NULL AND r.data->>'listId' IS NULL`,
    [userId, model, dim],
  );
  return result.rows.map(toEmbeddedBookmark);
}

interface ExistingCentroidRow {
  list_id: string;
  vector: number[];
}

/**
 * One centroid per live collection that has at least one embedded, filed
 * member — the sum of its members' vectors, unnormalized. Summing rather than
 * averaging costs nothing here: `clusterEmbeddings`'s existing-collection match
 * normalizes whatever it is handed, and cosine similarity is scale-invariant,
 * so the sum and the mean point in the exact same direction.
 *
 * A collection with no embedded members yet (brand new, or created before the
 * index existed) simply has no entry and can never be matched against — which
 * is the honest answer: there is no evidence yet for what it is "about".
 */
async function readExistingCollectionCentroids(
  pool: Pool,
  userId: string,
  model: string,
  dim: number,
): Promise<Map<string, number[]>> {
  const result = await pool.query<ExistingCentroidRow>(
    `SELECT r.data->>'listId' AS list_id, e.vector
     FROM nook_records r
     JOIN nook_embeddings e ON e.user_id = r.user_id AND e.bookmark_id = r.id AND e.model = $2 AND e.dim = $3
     JOIN nook_records l ON l.user_id = r.user_id AND l.kind = 'list' AND l.id = r.data->>'listId' AND l.deleted_at IS NULL
     WHERE r.user_id = $1 AND r.kind = 'bookmark' AND r.deleted_at IS NULL AND r.data->>'listId' IS NOT NULL`,
    [userId, model, dim],
  );
  const sums = new Map<string, number[]>();
  for (const row of result.rows) {
    if (!row.list_id || !Array.isArray(row.vector)) continue;
    const existing = sums.get(row.list_id);
    if (existing) {
      for (let i = 0; i < existing.length && i < row.vector.length; i++) existing[i] += row.vector[i];
    } else {
      sums.set(row.list_id, [...row.vector]);
    }
  }
  return sums;
}

/** Every live collection's name, for the naming prompt's "do not propose a
 *  name that already exists" instruction — read separately from the centroids
 *  above because a brand-new, still-empty collection has no centroid but is
 *  just as real a name to avoid duplicating. */
async function readLiveListNames(pool: Pool, userId: string): Promise<Map<string, string>> {
  const result = await pool.query<{ id: string; name: string | null }>(
    `SELECT id, data->>'name' AS name FROM nook_records WHERE user_id=$1 AND kind='list' AND deleted_at IS NULL`,
    [userId],
  );
  const names = new Map<string, string>();
  for (const row of result.rows) {
    const name = cleanText(row.name);
    if (name) names.set(row.id, name);
  }
  return names;
}

// -- the naming call ----------------------------------------------------------

interface ClusterForNaming {
  id: string;
  representatives: EmbeddedBookmark[];
}

/**
 * One request, naming every cluster that needs a brand-new name at once — the
 * doc's cost line ("one proposer call per suggestion round") depends on this
 * being a single call rather than one per cluster. A cluster already matched to
 * an existing collection is never included here at all: it does not need a
 * name invented, because the honest name for "more of what's already in
 * Reading" is "Reading".
 */
export function buildClusterNamingMessages(
  clusters: readonly ClusterForNaming[],
  existingNames: readonly string[],
  language: TaxonomyLanguage = "auto",
): ProposalMessages {
  const system = [
    "You name groups of a person's saved bookmarks that an embedding-based",
    "clustering step has already formed. You are given, for each group, a",
    "handful of representative items (their title or a short snippet, plus the",
    "site or author when known). Every item in a group is already confirmed to",
    "belong there - your only job is to name the theme, not to re-decide",
    "membership.",
    "",
    "Rules:",
    "Name every group given to you - do not skip any and do not invent new ones.",
    languageInstruction(language),
    "Each name must be 1 to 4 words, specific, and describe a theme rather than",
    "a bucket like \"misc\" or \"other\".",
    "Do not propose a name that already exists among the library's collections.",
    "Do not propose the same name for two different groups.",
    "Every group needs a one-sentence `why` naming the theme its items share.",
    "Spell names with the letters the language actually uses: keep every",
    "diacritic (`ç ğ ı İ ö ş ü Ç Ğ Ş Ü`). Do not ASCII-fold, transliterate or",
    "slugify them - \"acik kaynak\" is wrong, \"açık kaynak\" is right.",
    "Separate the words of a name with spaces, never hyphens or underscores.",
    "No emojis.",
    "",
    "Reply with JSON only: no prose, no code fences, exactly this shape:",
    '{"clusters":[{"id":"...","name":"...","why":"..."}]}',
  ].join("\n");

  const groups = clusters.map((cluster) => {
    const lines = cluster.representatives.map((rep) => {
      const tail = [rep.site, rep.author].filter((value): value is string => Boolean(value)).join(", ");
      return tail ? `- ${rep.text} (${tail})` : `- ${rep.text}`;
    });
    return [`Group ${cluster.id}:`, ...lines].join("\n");
  });
  const existing = existingNames.length ? existingNames.join(", ") : "(none)";
  const user = [...groups, "", `Existing collections (do not re-propose these): ${existing}`].join("\n\n");

  return { system, user };
}

/** Mirrors `languageInstruction` in ai.ts — duplicated rather than imported
 *  because that copy is not exported and the wording is specific to a single
 *  flat taxonomy proposal ("Write every name..."), where this prompt names
 *  several groups in one call; close enough in spirit to share the reasoning,
 *  not close enough in text to share the function. */
function languageInstruction(language: TaxonomyLanguage): string {
  if (language === "auto") return "Write every name in the same language as the representative items.";
  const named = LANGUAGE_NAMES[language];
  return `Write every name in ${named}, whatever language the items are in.`;
}

const LANGUAGE_NAMES: Record<Exclude<TaxonomyLanguage, "auto">, string> = {
  en: "English",
  tr: "Turkish",
  de: "German",
  fr: "French",
  es: "Spanish",
};

/**
 * Parses the naming model's JSON, tolerantly — same hardening as
 * `parseTaxonomyProposal` in ai.ts (peel a code fence, fall back to the
 * outermost braces, parse inside a try/catch), against a different shape.
 * A cluster missing from the response, or missing a `name` or `why`, is simply
 * absent from the returned map: the caller folds that cluster's members back
 * into "unclustered" rather than showing a proposal with no name or no reason.
 */
export function parseClusterNamingResponse(
  text: string,
  validIds: ReadonlySet<string>,
): Map<string, { name: string; why: string }> {
  const named = new Map<string, { name: string; why: string }>();
  if (typeof text !== "string") return named;
  const unfenced = stripCodeFence(text);
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  const json = start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return named;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return named;
  const body = parsed as { clusters?: unknown };
  for (const entry of Array.isArray(body.clusters) ? body.clusters : []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as { id?: unknown; name?: unknown; why?: unknown };
    const id = cleanText(record.id) ?? "";
    if (!validIds.has(id) || named.has(id)) continue;
    const name = collapseName(record.name);
    const why = collapseName(record.why);
    if (!name || !why) continue;
    named.set(id, { name, why });
  }
  return named;
}

// -- propose --------------------------------------------------------------

export interface ClusterProposal {
  id: string;
  name: string;
  why: string;
  size: number;
  memberIds: string[];
  /** At most 5, nearest-to-centroid first. */
  sampleTitles: string[];
  existingListId: string | null;
}

export interface ProposeClustersResponse {
  proposals: ClusterProposal[];
  unclustered: number;
  considered: number;
}

export interface AiClusterDeps extends AiDeps {
  clusterSeed?: number;
}

/**
 * `POST /api/ai/clusters/propose`'s whole implementation. See the file header
 * for the pipeline; this function is the orchestration of it end to end:
 *
 * 1. Read the account's unfiled, embedded bookmarks. Fewer than
 *    `MIN_CONSIDERED` and there is nothing worth clustering — returned before
 *    any proposer availability is even checked, because a library this small
 *    genuinely needs no model call to answer honestly.
 * 2. Cluster them (`clusterEmbeddings`, deterministic, no model call).
 * 3. Split the surviving clusters: one whose centroid already matches an
 *    existing collection needs no name invented (the honest name for it is
 *    the collection it matches), and is never sent to the naming model at
 *    all — the rest are.
 * 4. If there is at least one cluster to name, resolve the configured
 *    proposer and make exactly one call. Not configured is
 *    `ProposerUnavailableError` (503, same as `/api/ai/taxonomy/propose`); a
 *    configured proposer whose call itself failed is `ProposerCallFailedError`
 *    (502) — a materially different signal than "no clusterable structure
 *    exists", which the client must not confuse with an empty result.
 * 5. A cluster the model did not return a usable name for degrades to
 *    "unclustered" rather than failing the whole call: one bad line in a JSON
 *    response must not cost every other cluster its proposal, for the same
 *    reason a single malformed taxonomy entry does not fail the whole
 *    proposal in ai.ts.
 */
export async function proposeClustersForUser(
  pool: Pool,
  userId: string,
  language?: TaxonomyLanguage,
  deps: AiClusterDeps = {},
): Promise<ProposeClustersResponse> {
  const { model, dim } = embeddingAvailability();
  const embedded = await readUnfiledEmbedded(pool, userId, model, dim);
  const considered = embedded.length;
  if (considered < MIN_CONSIDERED) {
    return { proposals: [], unclustered: considered, considered };
  }

  const [existingCentroids, existingNames, settings] = await Promise.all([
    readExistingCollectionCentroids(pool, userId, model, dim),
    readLiveListNames(pool, userId),
    getAiUserSettings(pool, userId),
  ]);

  const embeddedById = new Map(embedded.map((bookmark) => [bookmark.id, bookmark]));
  const clustered = clusterEmbeddings(
    embedded.map((bookmark) => ({ id: bookmark.id, vector: bookmark.vector })),
    existingCentroids,
    typeof deps.clusterSeed === "number" ? { seed: deps.clusterSeed } : {},
  );
  let unclustered = clustered.unclusteredIds.length;
  if (clustered.clusters.length === 0) {
    return { proposals: [], unclustered, considered };
  }

  // Nearest-to-centroid ranking, shared by both halves below: the same ranked
  // list backs a matched cluster's `sampleTitles` and an unnamed cluster's
  // representatives sent to the naming model, so the two never disagree about
  // which members best represent the group.
  const rankedByCluster = clustered.clusters.map((cluster) => {
    const centroid = cluster.centroid;
    return [...cluster.memberIds]
      .map((id) => embeddedById.get(id))
      .filter((bookmark): bookmark is EmbeddedBookmark => Boolean(bookmark))
      .sort((left, right) => dot(unitVector(right.vector), centroid) - dot(unitVector(left.vector), centroid));
  });

  const idOf = (index: number): string => `cluster-${index}`;
  const toName: ClusterForNaming[] = [];
  const matched: Array<{ index: number; name: string; why: string }> = [];
  clustered.clusters.forEach((cluster, index) => {
    if (cluster.existingListId && existingNames.has(cluster.existingListId)) {
      matched.push({
        index,
        name: existingNames.get(cluster.existingListId)!,
        why: `Close to what you already keep in "${existingNames.get(cluster.existingListId)!}".`,
      });
    } else {
      toName.push({ id: idOf(index), representatives: rankedByCluster[index].slice(0, REPRESENTATIVES_PER_CLUSTER) });
    }
  });

  let named = new Map<string, { name: string; why: string }>();
  if (toName.length > 0) {
    const proposer = resolveProposer();
    if (!proposer) throw new ProposerUnavailableError();
    const messages = buildClusterNamingMessages(
      toName,
      [...existingNames.values()],
      language ?? settings.taxonomyLanguage,
    );
    const generated = await generate(messages, proposer, deps);
    if (!generated.ok) throw new ProposerCallFailedError(generated.error);
    named = parseClusterNamingResponse(generated.text, new Set(toName.map((cluster) => cluster.id)));
  }

  const proposals: ClusterProposal[] = [];
  clustered.clusters.forEach((cluster, index) => {
    const match = matched.find((entry) => entry.index === index);
    const namedEntry = match ? undefined : named.get(idOf(index));
    const resolvedName = match ?? namedEntry;
    if (!resolvedName) {
      // Either not matched to an existing collection AND the model did not
      // return a usable name for it — folded back into "unclustered" rather
      // than shown with no name.
      unclustered += cluster.memberIds.length;
      return;
    }
    proposals.push({
      id: idOf(index),
      name: resolvedName.name,
      why: resolvedName.why,
      size: cluster.memberIds.length,
      memberIds: cluster.memberIds,
      sampleTitles: rankedByCluster[index].slice(0, SAMPLE_TITLES_KEPT).map((bookmark) => bookmark.text).filter((text) => text !== ""),
      existingListId: cluster.existingListId && existingNames.has(cluster.existingListId) ? cluster.existingListId : null,
    });
  });

  proposals.sort((left, right) => right.size - left.size);
  return { proposals, unclustered, considered };
}

// -- accept -----------------------------------------------------------------

export interface AcceptedClusterInput {
  name: string;
  memberIds: string[];
  existingListId: string | null;
}

export interface AcceptClustersResponse {
  createdCollections: number;
  filed: number;
  skipped: number;
}

interface ListRow {
  id: string;
  name: string | null;
}

async function readLiveListsOn(db: PoolClient, userId: string): Promise<ClassifiableList[]> {
  const result = await db.query<ListRow>(
    `SELECT id, data->>'name' AS name FROM nook_records WHERE user_id=$1 AND kind='list' AND deleted_at IS NULL`,
    [userId],
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name ?? undefined }));
}

/**
 * Mirrors the collection half of `toAcceptedTaxonomy` in ai-taxonomy.ts, with
 * one deliberate difference: the samples here are a cluster's own real
 * membership, never a word-overlap guess over an unrelated sample pool. The
 * taxonomy flow has to guess which of its 200 sampled bookmarks belong to a
 * proposed name, because the naming model only ever returns a name, not a
 * membership list; this flow already knows exact membership; there is no
 * heuristic left to run.
 *
 * Earlier accepted batches are kept rather than replaced, for the same reason
 * `toAcceptedTaxonomy` keeps them: this runs once per "Suggest collections"
 * round, and a record that only described the newest round would erase the
 * evidence behind every collection accepted before it.
 */
function mergeAcceptedCollections(previous: readonly AiTaxonomyOption[], fresh: readonly AiTaxonomyOption[]): AiTaxonomyOption[] {
  const merged: AiTaxonomyOption[] = [];
  const seen = new Set<string>();
  for (const option of fresh) {
    const key = collectionKey(option.name);
    if (option.name === "" || seen.has(key)) continue;
    seen.add(key);
    merged.push(option);
  }
  for (const option of previous) {
    const name = option?.name ?? "";
    const key = collectionKey(name);
    if (name === "" || seen.has(key)) continue;
    seen.add(key);
    merged.push(option);
  }
  return merged;
}

/**
 * `PUT /api/ai/clusters/accept`'s whole implementation, in one transaction
 * under the same advisory lock `acceptTaxonomyForUser` and every server write
 * in this feature take (`pg_advisory_xact_lock(hashtext(user_id))` —
 * docs/ai.md, "The write path"). That lock is what makes filing thousands of
 * member ids as a handful of bulk `UPDATE`s safe rather than a race with a
 * concurrent sync: it is the same lock `syncRecords` takes before its own
 * read-check-write, so the two cannot interleave, and it is why this does
 * NOT call `applyServerWrite` per bookmark — that helper opens its *own*
 * connection and takes the *same* lock, so calling it from inside a
 * transaction that already holds it (on a different connection) would be a
 * self-inflicted deadlock, not a safety net.
 *
 * Order of work:
 *
 * 1. Resolve each requested collection to the real list it should file into:
 *    an explicit `existingListId` that is still live, or a name that collides
 *    with a live collection, files into that collection rather than creating
 *    a duplicate — the same collision rule `acceptTaxonomyForUser` applies via
 *    `planLists`/`dropTakenProposals`. Everything else is a new list, planned
 *    and inserted the same way `acceptTaxonomyForUser` does.
 * 2. File every member id that is still live and unfiled on the row as read
 *    right now, inside this same lock — the same eligibility re-check
 *    `applyServerWrite`'s guard performs, expressed as the `UPDATE`'s own
 *    WHERE clause instead of a per-row round trip. A member that is gone,
 *    deleted, or was filed by a human (or an earlier acceptance) in the
 *    meantime is silently left alone and counted as `skipped`, never
 *    overwritten.
 * 3. Record the accepted names in `nook_ai_taxonomy`, the same account row
 *    `acceptTaxonomyForUser` writes, so the classifier offers these
 *    collections to *future* bookmarks on its very next pass.
 * 4. Clear `nook_ai_decided` when a list was created, for the same reason
 *    `acceptTaxonomyForUser` does: a "nothing fit" verdict bought against a
 *    taxonomy that did not yet have this collection is stale the moment the
 *    collection exists.
 */
export async function acceptClustersForUser(
  pool: Pool,
  userId: string,
  collections: readonly AcceptedClusterInput[],
  deps: AiClusterDeps & { now?: () => number; newId?: () => string } = {},
): Promise<AcceptClustersResponse> {
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [userId]);

    const existingLists = await readLiveListsOn(client, userId);
    const liveListIds = new Set(existingLists.map((list) => list.id));
    const nameById = new Map<string, string>();
    const listIdByKey = new Map<string, string>();
    for (const list of existingLists) {
      const name = collapseName(list.name);
      if (!name) continue;
      nameById.set(list.id, name);
      listIdByKey.set(collectionKey(name), list.id);
    }

    // Only the names that resolve to neither an explicit live existingListId
    // nor a live name collision need a fresh list — planLists applies the same
    // collision discipline `acceptTaxonomyForUser` uses, including deduping two
    // requested names that fold to the same key against each other.
    const unresolved = collections.filter((entry) => {
      if (entry.existingListId && liveListIds.has(entry.existingListId)) return false;
      return !listIdByKey.has(collectionKey(entry.name));
    });
    const proposals: TaxonomyProposal[] = unresolved.map((entry) => ({ name: collapseName(entry.name), why: "" }));
    const planned = planLists(proposals, existingLists, at, newId);
    for (const list of planned) {
      await client.query(
        `INSERT INTO nook_records (user_id, kind, id, data, deleted_at)
         VALUES ($1, 'list', $2, $3::jsonb, $4)
         ON CONFLICT (user_id, kind, id) DO UPDATE SET
           data=EXCLUDED.data,
           deleted_at=EXCLUDED.deleted_at,
           version=nextval('nook_sync_version_seq'),
           updated_at=now()`,
        [userId, list.id, JSON.stringify(list), list.deletedAt ?? null],
      );
      const listName = collapseName(list.name);
      nameById.set(list.id, listName);
      listIdByKey.set(collectionKey(listName), list.id);
    }

    // Resolve every requested collection to the real listId it files into —
    // explicit id, then name collision, then the list just planned above.
    const resolved: Array<{ listId: string; listName: string; memberIds: string[] }> = [];
    for (const entry of collections) {
      const listId =
        (entry.existingListId && liveListIds.has(entry.existingListId) ? entry.existingListId : undefined) ??
        listIdByKey.get(collectionKey(entry.name));
      // Defensive only: every requested name is either a live collision or was
      // just planned into `listIdByKey` above, so this is unreachable given a
      // strictly validated request.
      if (!listId) continue;
      resolved.push({ listId, listName: nameById.get(listId) ?? collapseName(entry.name), memberIds: entry.memberIds });
    }

    const attempted = new Set<string>();
    const filedIds = new Set<string>();
    for (const entry of resolved) {
      for (const id of entry.memberIds) attempted.add(id);
      if (entry.memberIds.length === 0) continue;
      const result = await client.query<{ id: string }>(
        `UPDATE nook_records SET
           data = data || jsonb_build_object(
             'listId', $2::text,
             'listName', $3::text,
             'ai', jsonb_build_object('model', 'nook-clusters', 'source', 'cluster', 'at', $4::text),
             -- Stamped like applyServerWrite does: the merge keeps the newer
             -- updatedAt, so without it a device's older copy would undo this.
             'updatedAt', $4::text
           ),
           version = nextval('nook_sync_version_seq'),
           updated_at = now()
         WHERE user_id = $1
           AND kind = 'bookmark'
           AND id = ANY($5::text[])
           AND deleted_at IS NULL
           AND coalesce(btrim(data->>'deletedAt'), '') = ''
           AND data->>'listId' IS NULL -- ->> so an explicit JSON null counts as unfiled
         RETURNING id`,
        [userId, entry.listId, entry.listName, at, entry.memberIds],
      );
      for (const row of result.rows) filedIds.add(row.id);
    }

    // The accepted-taxonomy record, so the classifier offers these names to
    // future bookmarks. Samples are the titles of members that were actually
    // filed — real evidence, not a guess — capped the same way the existing
    // taxonomy flow caps its own per-collection digest.
    const sampleIds = resolved.flatMap((entry) => entry.memberIds.filter((id) => filedIds.has(id)).slice(0, MAX_ACCEPTED_SAMPLES));
    const titleById = new Map<string, string>();
    if (sampleIds.length > 0) {
      const titleRows = await client.query<{ id: string; title: string | null }>(
        `SELECT id, data->>'title' AS title FROM nook_records WHERE user_id=$1 AND kind='bookmark' AND id = ANY($2::text[])`,
        [userId, [...new Set(sampleIds)]],
      );
      for (const row of titleRows.rows) {
        const title = cleanText(row.title);
        if (title) titleById.set(row.id, title);
      }
    }
    const freshOptions: AiTaxonomyOption[] = resolved.map((entry) => {
      const name = entry.listName;
      const samples = entry.memberIds
        .filter((id) => filedIds.has(id))
        .slice(0, MAX_ACCEPTED_SAMPLES)
        .map((id) => titleById.get(id))
        .filter((title): title is string => Boolean(title));
      // The same name-derived key `toAcceptedTaxonomy` stores under, not the
      // real listId: matched by name against a live list either way
      // (buildCollectionOptions in ai-jobs.ts), and staying in the same key
      // space is what lets an entry accepted through this flow and one
      // accepted through the taxonomy flow supersede each other correctly.
      return { id: name.toLowerCase(), name, samples };
    });

    const previous = await readAcceptedTaxonomy(client, userId);
    const taxonomy: AcceptedTaxonomy = {
      acceptedAt: at,
      collections: mergeAcceptedCollections(previous.collections, freshOptions),
      tags: previous.tags,
    };
    await saveAcceptedTaxonomy(client, userId, taxonomy);

    // A decision to file nothing was a decision against the collections that
    // existed then; a newly created one changes the question, so every
    // "nothing fit" verdict in nook_ai_decided is stale the moment it lands.
    if (planned.length > 0) {
      await client.query("DELETE FROM nook_ai_decided WHERE user_id = $1", [userId]);
    }

    await client.query("COMMIT");
    return { createdCollections: planned.length, filed: filedIds.size, skipped: attempted.size - filedIds.size };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Unusable connection; releasing it is all that is left.
    }
    throw error;
  } finally {
    client.release();
  }
}

// -- request validation ---------------------------------------------------

/**
 * `POST /api/ai/clusters/propose`'s body: `{ language?: string }`, exactly the
 * same shape and the same validation `parseTaxonomyProposeBody` in ai-jobs.ts
 * already applies to `/api/ai/taxonomy/propose`'s identical body — reused
 * directly rather than re-implemented, since it is already exported and
 * nothing about it is specific to the taxonomy flow.
 */
export { parseTaxonomyProposeBody as parseClusterProposeBody } from "./ai-jobs.js";

function parseMemberIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Invalid memberIds array");
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry === "") throw new Error("Invalid member id");
    ids.push(entry);
  }
  return ids;
}

function parseExistingListId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value === "") throw new Error("Invalid existingListId");
  return value;
}

/**
 * `PUT /api/ai/clusters/accept`'s body. Strict rather than tolerant, unlike
 * `parseClassifyRequest`'s "drop the bad entry" style: the review list showed
 * the user exactly which collections and which member counts they are about
 * to create, so a malformed entry is a client bug worth a 400, not a silent
 * partial acceptance the user did not ask for and cannot see.
 */
export function parseClusterAcceptance(value: unknown): { collections: AcceptedClusterInput[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.collections)) throw new Error("Invalid collections array");
  if (body.collections.length > MAX_ACCEPTED_COLLECTIONS) throw new Error("Too many collections");

  const collections: AcceptedClusterInput[] = [];
  let totalIds = 0;
  for (const entry of body.collections) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid collection entry");
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) throw new Error("Invalid collection name");
    const memberIds = parseMemberIds(record.memberIds);
    totalIds += memberIds.length;
    if (totalIds > MAX_ACCEPTED_MEMBER_IDS) throw new Error("Too many member ids");
    collections.push({ name, memberIds, existingListId: parseExistingListId(record.existingListId) });
  }
  return { collections };
}
