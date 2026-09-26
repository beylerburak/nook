/**
 * Server side of AI classification. See docs/ai.md for the architecture and
 * apps/api/src/server.ts for the two routes that call into this file.
 *
 * Jev is not an LLM: it evaluates a `state` against typed questions and returns
 * calibrated answers, so the model can only ever pick from the option keys we
 * define. Everything that turns an answer into a change therefore lives in
 * `decideClassification` below, which keeps the two thresholds in one place for
 * calibration (docs/ai-calibration.md).
 *
 * Only this file reads AI secrets, and it is stateless: nothing here touches the
 * database, because writes go through the client via NookDB.updateBookmark.
 *
 * The wire types are duplicated from apps/extension/lib/types.ts on purpose —
 * the api workspace does not depend on the extension — so the shapes below must
 * be kept identical to the Contract section of docs/ai.md.
 */

// -- wire contract (docs/ai.md, "Contract") --

export interface ClassifyRequestBookmark {
  id: string;
  title?: string;
  summary?: string;
  note?: string;
  site?: string;
  author?: string;
}

export interface ClassifyCollection {
  id: string;
  name: string;
  samples: string[];
}

export interface ClassifyTag {
  name: string;
  samples: string[];
  /**
   * What the tag means, in the user's own agreed wording — the proposer's one
   * line, shown in the review list and kept on acceptance.
   *
   * This is NOT the member-title digest that `samples` carries, and the two must
   * not be merged. `samples` is evidence about *other bookmarks*, and putting it
   * in a Noul measurably halves tag recall (docs/ai-calibration.md): it turns an
   * absolute question into a similarity comparison against neighbours. A
   * definition is evidence about the *tag itself*, which is what a Noul with no
   * members is missing entirely.
   */
  definition?: string;
}

export interface ClassifySettings {
  collectionMinConfidence: number;
  tagMinNoul: number;
  maxTags: number;
}

export interface ClassifyRequest {
  bookmark: ClassifyRequestBookmark;
  collections: ClassifyCollection[];
  tags: ClassifyTag[];
  settings: ClassifySettings;
}

export interface ClassifyResponse {
  model: string;
  collection: {
    assign: boolean;
    /** null when !assign */
    id: string | null;
    name: string | null;
    confidence: number;
    probabilities: Record<string, number>;
  };
  /** already thresholded and capped */
  tags: Array<{ name: string; noul: number }>;
  skipped?: "none-fit" | "low-confidence";
  usage?: { inputTokens: number; outputTokens: number };
}

/** What language the new names should be written in. `auto` follows the sample,
 *  which is the right default for a mixed library; the rest let a user whose
 *  library is one language say so rather than have the model guess. */
export type TaxonomyLanguage = "auto" | "en" | "tr" | "de" | "fr" | "es";

export interface ProposeTaxonomyRequest {
  sample: Array<{ title: string; site: string }>;
  existingCollections: string[];
  maxCollections: number;
  maxTags: number;
  language?: TaxonomyLanguage;
}

export interface ProposeTaxonomyResponse {
  collections: Array<{ name: string; why: string }>;
  /**
   * A tag carries a `why` for the same reason a collection does: it is shown in
   * the review list, and it is kept as the tag's definition so a tag with no
   * members is not reduced to a bare name when the model is asked about it.
   * Optional, unlike a collection's — a proposer that omits it still yields a
   * usable tag, just one asked about by name alone.
   */
  tags: Array<{ name: string; why?: string }>;
}

// -- constants --

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_MODEL = "jev-latest";

/**
 * `model` in the response is what the client records in `ai.model`, but a call
 * that never happened has no model. "unavailable" keeps the attribution honest
 * and the run counters correct: nothing was filed, so nothing is claimed.
 */
export const UNAVAILABLE_MODEL = "unavailable";

/**
 * Reserved `Choice` option meaning "no listed collection fits". It is an
 * implementation detail of the question builder and never crosses the wire as a
 * collection id (docs/ai.md, Contract).
 */
export const NO_COLLECTION_OPTION = "__none__";

/** Namespace for the per-tag question ids, so a tag that happens to be named
 *  "collection" cannot collide with the single collection question. */
export const TAG_QUESTION_PREFIX = "tag::";

/** Applied when the client omits a threshold, so an older client keeps the
 *  documented default instead of getting zero. These are measured numbers, not
 *  round choices — the sweep is in docs/ai-calibration.md.
 *
 *  0.75 rather than the 0.85 this originally shipped with: on 57 hand-labelled
 *  real bookmarks, 0.75 files 22 (20 correct) against 0.85's 15 (13 correct) at
 *  the *same* count of 2 wrong assignments. The extra 0.10 of "caution" bought
 *  no safety at all, only 17 correct answers the model had already gotten right.
 *  Everything below 0.7 is close to a coin flip; 0.75 sits in the gap. */
export const DEFAULT_COLLECTION_MIN_CONFIDENCE = 0.75;
/** 0.80 keeps tag precision at 92% while recall stays above 80%. The `maxTags: 3`
 *  cap bound on none of the measured items, so it is not doing the work. */
export const DEFAULT_TAG_MIN_NOUL = 0.8;
export const DEFAULT_MAX_TAGS = 3;

/** Below this many characters of state text there is nothing to classify.
 *
 *  Not a language guard and not a quality heuristic: media-only bookmarks reduce
 *  to a bare title, an emoji, or just the author's handle once the state filter
 *  runs, and 39 of a real 1,061-bookmark library fall under 40 characters (15
 *  under 20). Spending a request on those returns a coin flip at full price. */
const MIN_CLASSIFIABLE_CHARS = 40;

/** The doc's "top 20 by frequency" cap on tag questions: past this the Nouls cost
 *  context and dilute each other without changing the top of the ranking. */
export const DEFAULT_MAX_TAGS_CONSIDERED = 20;

/** TypeSafe allows 255 options per Choice, and `__none__` takes one of them. */
const MAX_COLLECTION_OPTIONS = 254;

/** Sample titles quoted back into a question are evidence, not the library: a
 *  handful is enough for the model to recognise a theme, and every extra title
 *  costs context the question itself needs. */
const MAX_SAMPLES_KEPT = 20;
const SAMPLES_JOINED = 5;
const SAMPLE_CHARS = 90;

/** Per-field caps on what we keep. The contract only carries `summary`, never a
 *  full `description`, but a client bug that sends a whole article as `summary`
 *  would blow the 32k state budget (422) and the per-bookmark cost, so each
 *  field is clipped at a length that cannot plausibly lose the signal. */
const STATE_FIELD_LIMITS = {
  title: 500,
  summary: 4000,
  note: 4000,
  site: 200,
  author: 300,
} as const;

/** A title or a sample title is a label, not a body of text, so the sample
 *  digests and the proposal sample never need more than this. */
const MAX_TITLE_CHARS = 300;

/** A heavy library can carry thousands of tags, and only the most-used ones can
 *  ever be asked about, so keep the top slice rather than rejecting a request the
 *  client was right to send. */
const MAX_TAGS_ACCEPTED = 500;
const MAX_SAMPLE_ITEMS = 200;

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_JITTER_MS = 250;
/** A handler that honoured a 60s Retry-After would stall the client's whole
 *  classification queue, and backing off for longer than this buys nothing: the
 *  client simply sees a no-op and retries the bookmark on its next run. */
const MAX_RETRY_AFTER_MS = 5_000;

// -- jev question types --

/** `instructions` and `criteria` values accept a string or a structured
 *  object/array; state fields are referenced by name in backticks. */
export type Instruction = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
  type: "noul";
  instructions: Instruction;
  criteria?: { true: Instruction; false: Instruction };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: Instruction;
  criteria: Record<string, string | null>;
}

export type Question = NoulQuestion | ChoiceQuestion;
export type Questions = Record<string, Question>;

export interface SystemOneRequest {
  state: unknown;
  model: string;
  questions: Questions;
}

/** Raw answers mapped onto our own shapes, with every field filled in even when
 *  the response was incomplete, so nothing downstream has to null-check. */
export interface ParsedSystemOne {
  model: string;
  collection: { choice: string; confidence: number; probabilities: Record<string, number> };
  /** tag name -> noul, already stripped of the question-id prefix */
  tagNouls: Record<string, number>;
  usage?: { inputTokens: number; outputTokens: number };
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Injectable so the unit tests never touch the network. */
export interface AiDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export interface AiAvailability {
  /** Jev is callable (TYPESAFE_API_KEY is present). */
  classify: boolean;
  /** Configured taxonomy proposer id, or null when unset or unknown. */
  proposer: "openai" | "gemini" | null;
  /** Whether the proposer named above actually has an API key. */
  proposeTaxonomy: boolean;
}

// -- small helpers --

function clamp01(value: unknown): number {
  const num = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return num < 0 ? 0 : num > 1 ? 1 : num;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Collapses interior whitespace and trims. Deliberately does NOT change case:
 *  this feeds the *displayed* name, and a collection called "Tasarım ve Arayüz"
 *  must not be shown as "tasarım ve arayüz". Comparison keys fold separately. */
function collapseName(value: unknown): string {
  const text = cleanText(value);
  return text ? text.replace(/\s+/g, " ") : "";
}

function cleanSamples(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const samples: string[] = [];
  for (const entry of value) {
    const text = cleanText(entry);
    if (text) samples.push(text.slice(0, MAX_TITLE_CHARS));
    if (samples.length >= MAX_SAMPLES_KEPT) break;
  }
  return samples;
}

/** The same normalisation the client applies when it looks a tag up
 *  (apps/extension/src/app/dashboard/bookmark-utils.ts, getTags), so the names
 *  we return are names the client can match against a bookmark's own tags. */
/**
 * Folds a tag name for comparison. MUST stay identical to `normalizeTagName` in
 * apps/extension/lib/ai-classify.ts, which is where the reasoning lives: the
 * server normalises what it returns and the client normalises what it looks up,
 * and a disagreement writes tags the library can never find again.
 *
 * Turkish-aware because `toLowerCase()` maps "İ" to "i" plus a combining dot,
 * which is how a real run produced a tag called "i̇ş yönetimi ve crm" — a name
 * that cannot be typed back. `toLocaleLowerCase("tr")` would fix that and break
 * "AI", so the locale is picked by looking for a Turkish-specific letter.
 */
export function normalizeTagName(name: string): string {
  return foldCase(name.trim().replace(/^#/, "").trim());
}

/** Any letter that marks a word as Turkish. Note the absence of "i" and "I":
 *  they are the whole problem — see the note above. */
const TURKISH_LETTER = /[ıİğĞşŞçÇöÖüÜ]/;

/**
 * Lowercases one word in the locale that word is written in.
 *
 * Per word, not per string, and that is the part that matters. A single string
 * in this library mixes both: "UI Tasarımları" is an English initialism next to
 * a Turkish noun. Under the Turkish locale "UI" becomes "uı"; under the default
 * locale "Tasarımları" becomes "tasarımlar" is fine but "İş" becomes "i̇ş" with
 * a combining dot. Folding word by word gets both right.
 */
function foldWord(word: string): string {
  return TURKISH_LETTER.test(word) ? word.toLocaleLowerCase("tr") : word.toLowerCase();
}

function foldCase(value: string): string {
  return value.split(" ").map(foldWord).join(" ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// -- request validation --

/**
 * Structural validation only, in the style of `parseSyncRequest`: a thrown
 * Error becomes a 400 and its message is safe to hand back to the client.
 * Malformed individual entries are dropped rather than rejected, because one
 * unusable tag must not cost the whole bookmark its classification; a bookmark
 * that is not classifiable at all still fails loudly.
 */
export function parseClassifyRequest(value: unknown): ClassifyRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  const body = value as Record<string, unknown>;

  if (!body.bookmark || typeof body.bookmark !== "object" || Array.isArray(body.bookmark)) {
    throw new Error("Invalid bookmark");
  }
  const source = body.bookmark as Record<string, unknown>;
  if (!cleanText(source.id)) throw new Error("Invalid bookmark id");
  const bookmark: ClassifyRequestBookmark = { id: source.id as string };
  for (const field of ["title", "summary", "note", "site", "author"] as const) {
    const text = cleanText(source[field]);
    if (text) bookmark[field] = text;
  }

  return {
    bookmark,
    collections: parseCollections(body.collections),
    tags: parseTags(body.tags),
    settings: parseClassifySettings(body.settings),
  };
}

function parseCollections(value: unknown): ClassifyCollection[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid collections array");
  // Otherwise this is a 422 from TypeSafe, caused by a library that merely got big.
  if (value.length > MAX_COLLECTION_OPTIONS) throw new Error("Too many collections");
  const collections: ClassifyCollection[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = cleanText(record.id);
    const name = cleanText(record.name);
    if (!id || !name) continue;
    collections.push({ id, name, samples: cleanSamples(record.samples) });
  }
  return collections;
}

function parseTags(value: unknown): ClassifyTag[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid tags array");
  const tags: ClassifyTag[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const name = cleanText(record.name);
    if (!name) continue;
    // `definition` is optional on purpose: a client on an older build sends no
    // `why`, and that tag is still perfectly usable, just asked about by name.
    const definition = cleanText(record.definition);
    tags.push({
      name,
      samples: cleanSamples(record.samples),
      ...(definition ? { definition } : {}),
    });
  }
  // Rank before capping, so the cap keeps the tags docs/ai.md says matter.
  return tags
    .sort((left, right) => right.samples.length - left.samples.length)
    .slice(0, MAX_TAGS_ACCEPTED);
}

function parseClassifySettings(value: unknown): ClassifySettings {
  if (value === undefined) {
    return {
      collectionMinConfidence: DEFAULT_COLLECTION_MIN_CONFIDENCE,
      tagMinNoul: DEFAULT_TAG_MIN_NOUL,
      maxTags: DEFAULT_MAX_TAGS,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid settings");
  const record = value as Record<string, unknown>;
  return {
    collectionMinConfidence: parseThreshold(record.collectionMinConfidence, DEFAULT_COLLECTION_MIN_CONFIDENCE),
    tagMinNoul: parseThreshold(record.tagMinNoul, DEFAULT_TAG_MIN_NOUL),
    maxTags: parseCount(record.maxTags, DEFAULT_MAX_TAGS),
  };
}

function parseThreshold(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid threshold");
  return Math.min(1, Math.max(0, value));
}

function parseCount(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid count");
  return Math.max(0, Math.floor(value));
}

export function parseProposeTaxonomyRequest(value: unknown): ProposeTaxonomyRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  const body = value as Record<string, unknown>;

  if (!Array.isArray(body.sample)) throw new Error("Invalid sample array");
  const sample: ProposeTaxonomyRequest["sample"] = [];
  for (const entry of body.sample) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const title = cleanText(record.title);
      if (title) {
        sample.push({ title: title.slice(0, MAX_TITLE_CHARS), site: cleanText(record.site) ?? "" });
      }
    }
    if (sample.length >= MAX_SAMPLE_ITEMS) break;
  }

  const existingCollections: string[] = [];
  if (body.existingCollections !== undefined) {
    if (!Array.isArray(body.existingCollections)) throw new Error("Invalid existingCollections array");
    for (const entry of body.existingCollections) {
      const name = cleanText(entry);
      if (name) existingCollections.push(name.slice(0, MAX_TITLE_CHARS));
    }
  }

  return {
    sample,
    existingCollections,
    maxCollections: parseCount(body.maxCollections, 8),
    maxTags: parseCount(body.maxTags, 20),
    language: parseLanguage(body.language),
  };
}

/** Unknown values fall back to `auto` rather than throwing: it is a preference,
 *  not a precondition, and a client on a newer build asking for a language this
 *  server has not heard of should still get suggestions. */
const TAXONOMY_LANGUAGES: TaxonomyLanguage[] = ["auto", "en", "tr", "de", "fr", "es"];

function parseLanguage(value: unknown): TaxonomyLanguage {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (TAXONOMY_LANGUAGES as string[]).includes(text) ? (text as TaxonomyLanguage) : "auto";
}

// -- classification: state and questions --

/**
 * State is FILTERED, not the record. Jev loses accuracy on state full of
 * material the question does not need — the full `description` (which the request
 * contract does not even carry), urls, media, tags, counters — so only these
 * five text fields are sent, and only when they have content.
 */
export function buildClassificationState(bookmark: ClassifyRequestBookmark): {
  item: Partial<Record<keyof ClassifyRequestBookmark, string>>;
} {
  const item: Partial<Record<keyof ClassifyRequestBookmark, string>> = {};
  for (const field of ["title", "summary", "note", "site", "author"] as const) {
    const text = cleanText(bookmark[field]);
    if (text) item[field] = truncate(text, STATE_FIELD_LIMITS[field]);
  }
  return { item };
}

/** "name — sample, sample": for the collection `Choice` only. The actual member
 *  titles are what let one call suffice, so the evidence matters more than the
 *  label — measured worth 8.7 points of top-1 over names alone. Do not add this
 *  to the tag `Noul`s; see the note in `buildClassificationQuestions`. */
function sampleDigest(samples: string[]): string {
  return samples
    .slice(0, SAMPLES_JOINED)
    .map((sample) => truncate(sample, SAMPLE_CHARS))
    .join(" | ");
}

/**
 * One request, two kinds of question. The `collection` Choice settles *which*
 * collection; the `tag::<name>` Nouls settle whether to say anything at all.
 * That split is deliberate: the model is reliable on the relative "which of
 * these" question and the relative "is this about it" question, and neither of
 * those is the absolute judgement we should be asking it for.
 */
export function buildClassificationQuestions(
  collections: ClassifyCollection[],
  tags: ClassifyTag[],
  maxTagsConsidered: number = DEFAULT_MAX_TAGS_CONSIDERED,
): Questions {
  const criteria = new Map<string, string>();
  for (const collection of collections) {
    const digest = sampleDigest(collection.samples);
    criteria.set(collection.id, digest ? `${collection.name} — contains: ${digest}` : collection.name);
  }
  // Set unconditionally, and last: a (pathological) collection whose id is
  // literally `__none__` must not be able to steal the reserved key, because the
  // option that means "decline" is the only escape hatch from a bad filing. That
  // collection simply becomes unreachable, which costs nothing —
  // `decideClassification` returns before looking up a name for `__none__`.
  criteria.set(
    NO_COLLECTION_OPTION,
    "None of the listed collections fits. Choose this when the item is not clearly about any of them.",
  );

  const questions: Questions = {
    collection: {
      type: "choice",
      instructions:
        "Which of the listed collections should this saved item be filed under? " +
        `If none of them fits well, answer \`${NO_COLLECTION_OPTION}\` instead — ` +
        "answering that no collection fits is a valid and often correct answer.",
      criteria: Object.fromEntries(criteria),
    },
  };

  const considered = [...tags]
    .sort((left, right) => right.samples.length - left.samples.length)
    .slice(0, Math.max(0, maxTagsConsidered));
  for (const tag of considered) {
    // NO member-title digest here, which reads like an oversight next to the
    // Choice above. It is a measured decision — see docs/ai-calibration.md.
    // Adding the tag's member titles to this question cost 58% of the request's
    // tokens and *halved* tag recall (81.7% -> 47.9% at the same threshold,
    // `türkçe` recall 97% -> 27%). A Noul is an absolute question; evidence
    // about *other bookmarks* inside the question turns it into a similarity
    // comparison against those neighbours, which is the wrong comparison. A
    // Choice is relative, and the same digest is worth 8.7 points of top-1
    // there.
    //
    // What this Noul does carry is a definition, when one exists: the line the
    // user agreed to when accepting a proposed tag. That is evidence about the
    // tag itself rather than about its neighbours, which is the thing a tag with
    // no members otherwise has nothing but a bare name for.
    const definition = cleanText(tag.definition);
    questions[`${TAG_QUESTION_PREFIX}${tag.name}`] = {
      type: "noul",
      instructions: `Does this saved item belong under the tag "${tag.name}"?`,
      criteria: {
        true: definition
          ? `The item is the kind of thing this tag is for: ${definition}`
          : "The item is the kind of thing this tag is for.",
        false: "The item is about something else that this tag does not cover.",
      },
    };
  }
  return questions;
}

export function collectionNamesById(collections: ClassifyCollection[]): Record<string, string> {
  return Object.fromEntries(collections.map((collection) => [collection.id, collection.name]));
}

// -- classification: response parsing --

/**
 * Defensive on purpose. A truncated or partially failed response must still
 * produce a decision, and the safe direction for every field is the empty one: a
 * missing answer means "no evidence", which `decideClassification` reads as "do
 * nothing". Throwing here would turn a blip into a failed save.
 */
export function parseSystemOneResponse(body: unknown, request: SystemOneRequest): ParsedSystemOne {
  const envelope = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const answers = (
    envelope.answers && typeof envelope.answers === "object" ? envelope.answers : {}
  ) as Record<string, unknown>;

  const collectionAnswer = (
    answers.collection && typeof answers.collection === "object" ? answers.collection : {}
  ) as Record<string, unknown>;
  const rawProbabilities = (
    collectionAnswer.probabilities && typeof collectionAnswer.probabilities === "object"
      ? collectionAnswer.probabilities
      : {}
  ) as Record<string, unknown>;
  const probabilities: Record<string, number> = {};
  for (const [option, probability] of Object.entries(rawProbabilities)) {
    probabilities[option] = clamp01(probability);
  }

  // Iterate the questions we asked rather than the answers we received, so a tag
  // the model skipped is reported as 0 instead of silently disappearing, and an
  // unexpected key can never be read as a tag.
  const tagNouls: Record<string, number> = {};
  for (const id of Object.keys(request.questions)) {
    if (!id.startsWith(TAG_QUESTION_PREFIX)) continue;
    const answer = answers[id];
    tagNouls[id.slice(TAG_QUESTION_PREFIX.length)] = clamp01(
      answer && typeof answer === "object" && !Array.isArray(answer)
        ? (answer as Record<string, unknown>).noul
        : undefined,
    );
  }

  const rawUsage = (envelope.usage && typeof envelope.usage === "object" ? envelope.usage : {}) as Record<
    string,
    unknown
  >;
  return {
    model: cleanText(envelope.model) ?? TYPESAFE_MODEL,
    collection: {
      choice: cleanText(collectionAnswer.choice) ?? "",
      confidence: clamp01(collectionAnswer.confidence),
      probabilities,
    },
    tagNouls,
    usage: {
      inputTokens: Math.max(0, Math.trunc(Number(rawUsage.input_tokens) || 0)),
      outputTokens: Math.max(0, Math.trunc(Number(rawUsage.output_tokens) || 0)),
    },
  };
}

// -- classification: the decision --

function neutralCollection(): ClassifyResponse["collection"] {
  return { assign: false, id: null, name: null, confidence: 0, probabilities: {} };
}

/** Nothing is filed and nothing is claimed. Used when AI is unconfigured or the
 *  call failed: the bookmark keeps `ai == null` and stays eligible, so a
 *  transient outage costs a no-op rather than a wrong filing. */
export function neutralClassification(): ClassifyResponse {
  return { model: UNAVAILABLE_MODEL, collection: neutralCollection(), tags: [] };
}

/**
 * The thresholds live here, in one place, in code, because they are calibrated
 * numbers and not model output.
 *
 * `collectionMinConfidence` and `tagMinNoul` are tuned SEPARATELY and must never
 * be interchanged or shared. The model answers a relative question in one case
 * (a Choice: which of these options, scored against each other) and an absolute
 * one in the other (a Noul: does this item belong under this tag). A confidence
 * derived from a distribution over N options and a single yes-probability are
 * not on the same scale, so a threshold that works on one under- or over-fires
 * on the other. Read docs/ai-calibration.md before changing either.
 *
 * Nothing is ever chosen for the user below the threshold — doing nothing is the
 * safe failure. A skipped decision still reports its confidence and
 * probabilities so the client can log it and the histogram stays honest.
 */
export function decideClassification(
  parsed: ParsedSystemOne,
  settings: ClassifySettings,
  collectionNameById: Record<string, string>,
): ClassifyResponse {
  const { choice, confidence, probabilities } = parsed.collection;
  const decided = decideTags(parsed.tagNouls, settings);
  const usage = parsed.usage ? { usage: parsed.usage } : {};
  const collection = { confidence, probabilities };

  if (choice === NO_COLLECTION_OPTION) {
    return {
      model: parsed.model,
      collection: { ...collection, assign: false, id: null, name: null },
      tags: decided,
      skipped: "none-fit",
      ...usage,
    };
  }

  // An id we never offered means the response does not describe a decision we can
  // act on, so it is a skip rather than an assignment we cannot name.
  const name = choice ? collectionNameById[choice] : undefined;
  if (choice && name && confidence >= settings.collectionMinConfidence) {
    return {
      model: parsed.model,
      collection: { ...collection, assign: true, id: choice, name },
      tags: decided,
      ...usage,
    };
  }

  return {
    model: parsed.model,
    collection: { ...collection, assign: false, id: null, name: null },
    tags: decided,
    skipped: "low-confidence",
    ...usage,
  };
}

function decideTags(
  tagNouls: Record<string, number>,
  settings: ClassifySettings,
): ClassifyResponse["tags"] {
  const best = new Map<string, number>();
  for (const [rawName, rawNoul] of Object.entries(tagNouls)) {
    const name = normalizeTagName(rawName);
    if (!name) continue;
    const noul = clamp01(rawNoul);
    // >= is deliberate: a tag exactly at the threshold is a yes.
    if (noul < settings.tagMinNoul) continue;
    // Two spellings of one tag ("AI" and "#ai") normalise to the same key; keep
    // the strongest, because the client would otherwise write the same tag twice.
    const previous = best.get(name);
    if (previous === undefined || noul > previous) best.set(name, noul);
  }
  // Name as the tiebreak so the same input always yields the same response.
  return [...best.entries()]
    .map(([name, noul]) => ({ name, noul }))
    .sort((left, right) => right.noul - left.noul || left.name.localeCompare(right.name))
    .slice(0, Math.max(0, settings.maxTags));
}

// -- the call --

export function jevAvailable(): boolean {
  return Boolean(cleanText(process.env.TYPESAFE_API_KEY));
}

export function aiAvailability(): AiAvailability {
  const proposer = resolveProposer();
  return {
    classify: jevAvailable(),
    proposer: proposer ? proposer.provider : null,
    proposeTaxonomy: Boolean(proposer),
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter, honouring a short `retry-after`. The jitter
 *  keeps a batch of bookmarks that all hit the same 429 from retrying in
 *  lockstep and hitting it again. */
function backoffDelay(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  const base = Number.isFinite(seconds)
    ? Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_AFTER_MS)
    : BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return Math.min(base + Math.random() * BACKOFF_JITTER_MS, MAX_RETRY_AFTER_MS);
}

const RETRY_STATUSES = new Set([429, 529]);

async function requestJson(
  url: string,
  init: RequestInit,
  label: string,
  deps: AiDeps,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string; throttled?: boolean }> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await doFetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      // Network-level failure: worth one more try, then give up quietly.
      if (attempt === MAX_ATTEMPTS) return { ok: false, error: `${label} request failed: ${errorMessage(error)}` };
      await sleep(backoffDelay(attempt, null));
      continue;
    }
    if (response.ok) {
      try {
        return { ok: true, body: await response.json() };
      } catch (error) {
        return { ok: false, error: `${label} returned malformed JSON: ${errorMessage(error)}` };
      }
    }
    // 401 and 422 are our bug or our configuration, not a blip; retrying them
    // only delays the same failure by two more round trips.
    if (!RETRY_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS) {
      // Throttling that survived MAX_ATTEMPTS is reported as throttling, not as
      // a generic failure. It is the one condition where the caller must back
      // off rather than simply retry later, and it has to survive the hop to the
      // client: swallowed into a neutral 200, a throttled key looked like a model
      // that had decided nothing, which silently retired those bookmarks.
      return RETRY_STATUSES.has(response.status)
        ? { ok: false, error: `${label} request failed: ${response.status}`, throttled: true }
        : { ok: false, error: `${label} request failed: ${response.status}` };
    }
    await sleep(backoffDelay(attempt, response.headers.get("retry-after")));
  }
  return { ok: false, error: `${label} request failed` };
}

/** The raw TypeSafe call, kept separate from the decision so the retry policy can
 *  be exercised on its own. */
export async function callSystemOne(
  request: SystemOneRequest,
  apiKey: string,
  deps: AiDeps = {},
): Promise<{ ok: true; body: unknown } | { ok: false; error: string; throttled?: boolean }> {
  return requestJson(
    TYPESAFE_ENDPOINT,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
    "TypeSafe",
    deps,
  );
}

/** A classification plus the one thing the caller cannot read off it: whether the
 *  upstream was throttling us. A neutral response is deliberately indistinguishable
 *  from "the model had nothing to say", so without this a throttled key returns a
 *  confident-looking 200 and the client retires the bookmark for good. */
export interface ClassifyOutcome {
  response: ClassifyResponse;
  throttled: boolean;
}

/**
 * The whole classification pass. Never throws: a missing key, a timeout, a 5xx
 * and a garbled body all degrade to a neutral decision, because classification is
 * a background pass that must never block saving a bookmark (docs/ai.md).
 */
export async function classifyBookmarkOutcome(
  request: ClassifyRequest,
  deps: AiDeps = {},
): Promise<ClassifyOutcome> {
  const apiKey = cleanText(process.env.TYPESAFE_API_KEY);
  if (!apiKey) {
    console.warn("[ai] TYPESAFE_API_KEY is not configured; skipping classification");
    return { response: neutralClassification(), throttled: false };
  }

  const state = buildClassificationState(request.bookmark);
  const textLength = Object.values(state.item).reduce((sum, text) => sum + (text?.length ?? 0), 0);
  if (textLength < MIN_CLASSIFIABLE_CHARS) {
    // Not "no text" but "not enough to mean anything": a bare emoji, two-word
    // title, or an author handle with no body. The model answers these at full
    // price and returns a coin flip, so the floor is a cost guard as much as a
    // quality one. See MIN_CLASSIFIABLE_CHARS.
    console.warn(
      `[ai] bookmark ${request.bookmark.id} has ${textLength} chars of text; skipping`,
    );
    return { response: neutralClassification(), throttled: false };
  }

  const jevRequest: SystemOneRequest = {
    state,
    model: TYPESAFE_MODEL,
    questions: buildClassificationQuestions(request.collections, request.tags),
  };
  const result = await callSystemOne(jevRequest, apiKey, deps);
  if (!result.ok) {
    console.warn(`[ai] classification failed for ${request.bookmark.id}: ${result.error}`);
    // A throttled upstream is the one failure the client must hear about, so it
    // can back off instead of quietly retiring the bookmark.
    return { response: neutralClassification(), throttled: result.throttled === true };
  }
  return {
    response: decideClassification(
      parseSystemOneResponse(result.body, jevRequest),
      request.settings,
      collectionNamesById(request.collections),
    ),
    throttled: false,
  };
}

/** The response alone, for callers that do not act on throttling. Prefer
 *  `classifyBookmarkOutcome` in the route — this wrapper is why a throttled key
 *  is easy to hide again. */
export async function classifyBookmark(
  request: ClassifyRequest,
  deps: AiDeps = {},
): Promise<ClassifyResponse> {
  return (await classifyBookmarkOutcome(request, deps)).response;
}

// -- taxonomy proposals --

/** Small cheap models only: this endpoint handles a handful of calls a year. */
/**
 * `gpt-4o-mini`, with `gpt-5-nano` available through `NOOK_AI_MODEL`.
 *
 * Measured on this library, with the prompt as it now stands, both produce clean
 * Turkish and neither is meaningfully faster (6-8s each). 4o-mini is the default
 * because its output was clean on every run: gpt-5-nano was clean on `auto` but
 * produced a broken token (`agtanıtım`) and an untranslated `open source dizin`
 * when the language was pinned to Turkish.
 *
 * An earlier version of this comment blamed nano for far more than it deserved.
 * Most of that came from the prompt, not the model: over-constraining the wording
 * degraded both, and once the constraints were relaxed nano was fine. That is
 * why the model is an environment variable and not a decision frozen into the
 * source — the evidence can move again.
 */
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

function openaiModel(): string {
  return cleanText(process.env.NOOK_AI_MODEL) || DEFAULT_OPENAI_MODEL;
}

/**
 * Token budget and reasoning effort are family-specific, and guessing wrong is
 * a hard 400 rather than a warning. Measured against this endpoint:
 *
 * - `reasoning_effort` is rejected outright by gpt-4o-mini
 *   ("Unrecognized request argument supplied").
 * - `max_tokens` is rejected by gpt-5-nano
 *   ("Unsupported parameter: 'max_tokens' is not supported with this model").
 * - `max_completion_tokens` is accepted by both.
 *
 * `reasoning_effort` also matters: the gpt-5 family spends that budget on hidden
 * reasoning before writing anything. Unset, it burned 768 tokens reasoning on a
 * two-line answer and returned an *empty message* at a small budget; `"minimal"`
 * spends none and is ~5x faster.
 *
 * Generous, because the real prompt carries 200 titles and the answer is eight
 * collections plus twenty tags with a reason each.
 */
const OPENAI_REASONING_EFFORT = "minimal";
const OPENAI_MAX_COMPLETION_TOKENS = 2000;

/** gpt-5 and the o-series reason before they answer; the gpt-4 family does not
 *  take the parameter at all. */
function usesReasoning(model: string): boolean {
  return /^gpt-5|^o[1-9]/.test(model);
}
const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

type ProposerId = "openai" | "gemini";

interface ResolvedProposer {
  provider: ProposerId;
  apiKey: string;
}

function resolveProposer(): ResolvedProposer | null {
  const selected = (process.env.NOOK_AI_PROPOSER ?? "").trim().toLowerCase();
  const provider: ProposerId | null = selected === "openai" || selected === "gemini" ? selected : null;
  if (!provider) return null;
  const apiKey = cleanText(provider === "openai" ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY);
  return apiKey ? { provider, apiKey } : null;
}

export interface ProposalMessages {
  system: string;
  user: string;
}

/** Jev cannot invent a category name, so the proposal step needs a generative
 *  model. The prompt demands strict JSON, short names, and — importantly — names
 *  in the same language as the library, because a Turkish library with English
 *  collection names is not a taxonomy anyone would use. */
export function buildProposalMessages(
  sample: ProposeTaxonomyRequest["sample"],
  existingCollections: string[],
  maxCollections: number,
  maxTags: number,
  language: TaxonomyLanguage = "auto",
): ProposalMessages {
  const system = [
    "You organise a personal bookmark library into collections and tags.",
    "You are given a sample of saved items and propose new collections and a small tag vocabulary.",
    "",
    "Rules:",
    `- Propose at most ${maxCollections} collections and at most ${maxTags} tags.`,
    languageInstruction(language),
    "Each name must be 2 to 3 words, specific, and describe a theme rather than a bucket like \"misc\".",
    "Do not duplicate a name you also propose.",
    "Do not propose a name that already exists among the library's collections.",
    "Every collection needs a one-sentence `why` naming the theme it would hold.",
    "Every tag needs a one-sentence `why` too, in the same language, saying what that",
    "tag is for. It is not decoration: it is shown to the user, and it becomes the tag's",
    "definition when Nook later asks the model whether an item belongs under it.",
    "Spell tag names with the letters the language actually uses: keep every diacritic",
    "(`ç ğ ı İ ö ş ü Ç Ğ Ş Ü`). Do not ASCII-fold, transliterate or slugify them -",
    "\"acik kaynak\" is wrong, \"açık kaynak\" is right.",
    "Separate the words of a tag name with spaces, never hyphens or underscores.",
    "Keep tag names short and idiomatic - ordinary words, not phrases or sentences.",
    "",
    "Reply with JSON only: no prose, no code fences, exactly this shape:",
    '{"collections":[{"name":"...","why":"..."}],"tags":[{"name":"...","why":"..."}]}',
  ].join("\n");

  const lines = sample.map((item) => (item.site ? `- ${item.title} (${item.site})` : `- ${item.title}`));
  const existing = existingCollections.length ? existingCollections.join(", ") : "(none)";
  const user = [
    `Sample of ${sample.length} saved items:`,
    ...lines,
    "",
    `Existing collections (do not re-propose these): ${existing}`,
  ].join("\n");

  return { system, user };
}

/** Naming language. `auto` follows the sample, which is right for a mixed
 *  library and is the default; an explicit choice is how a user whose library is
 *  all one language stops the model guessing. */
function languageInstruction(language: TaxonomyLanguage): string {
  if (language === "auto") return "Write every name in the same language as the sample items.";
  const named = TAXONOMY_LANGUAGE_NAMES[language];
  return `Write every name in ${named}, whatever language the sample items are in.`;
}

/** Spelled out rather than upper-cased: a model reads "German" better than
 *  "DE", and the code gains nothing from the abbreviation. */
const TAXONOMY_LANGUAGE_NAMES: Record<Exclude<TaxonomyLanguage, "auto">, string> = {
  en: "English",
  tr: "Turkish",
  de: "German",
  fr: "French",
  es: "Spanish",
};

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

/**
 * Models wrap JSON in prose and fences no matter what the prompt says, and this
 * output is a preview a user is about to act on. So: peel the fence, fall back
 * to the outermost braces, parse inside a try/catch, and drop every entry that is
 * not usable. A garbage proposal yields empty arrays, never an error — the user
 * simply sees no suggestions.
 */
export function parseTaxonomyProposal(
  text: string,
  maxCollections = 8,
  maxTags = 20,
): ProposeTaxonomyResponse {
  const empty: ProposeTaxonomyResponse = { collections: [], tags: [] };
  if (typeof text !== "string") return empty;
  const unfenced = stripCodeFence(text);
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  const json = start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
  const body = parsed as Record<string, unknown>;

  const collections: ProposeTaxonomyResponse["collections"] = [];
  const seenCollections = new Set<string>();
  for (const entry of Array.isArray(body.collections) ? body.collections : []) {
    if (collections.length >= Math.max(0, maxCollections)) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const name = collapseName(record.name);
    // A missing `why` is a malformed entry for our purposes: the review UI has
    // nowhere to show a proposal without one.
    const why = collapseName(record.why);
    if (!name || !why) continue;
    // Folded for the key only, so two proposals differing by Turkish casing
    // collapse into one without the displayed name being lowercased.
    const key = foldCase(name);
    if (seenCollections.has(key)) continue;
    seenCollections.add(key);
    collections.push({ name, why });
  }

  const tags: ProposeTaxonomyResponse["tags"] = [];
  const seenTags = new Set<string>();
  for (const entry of Array.isArray(body.tags) ? body.tags : []) {
    if (tags.length >= Math.max(0, maxTags)) break;
    // A bare string is accepted as well as `{ name }`, since it is the obvious
    // shape; tag names are normalised the same way the client normalises them.
    const record = (entry && typeof entry === "object" ? entry : {}) as { name?: unknown; why?: unknown };
    const raw = typeof entry === "string" ? entry : record.name;
    const name = typeof raw === "string" ? normalizeTagName(raw) : "";
    if (!name || seenTags.has(name)) continue;
    seenTags.add(name);
    // A missing `why` is kept rather than dropped, unlike a collection. A tag
    // without a definition is still worth offering — it just gets asked about
    // by name alone, which is what the first version of this feature did to
    // every tag.
    const why = collapseName(record.why);
    tags.push(why ? { name, why } : { name });
  }

  return { collections, tags };
}

async function generate(
  messages: ProposalMessages,
  proposer: ResolvedProposer,
  deps: AiDeps,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (proposer.provider === "openai") {
    // Read once: the reasoning branch and the body must not be able to disagree
    // about which model they are configuring.
    const model = openaiModel();
    const result = await requestJson(
      OPENAI_ENDPOINT,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${proposer.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          // Only the reasoning families; the gpt-4 family answers 400.
          ...(usesReasoning(model) ? { reasoning_effort: OPENAI_REASONING_EFFORT } : {}),
          max_completion_tokens: OPENAI_MAX_COMPLETION_TOKENS,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: messages.system },
            { role: "user", content: messages.user },
          ],
        }),
      },
      "OpenAI",
      deps,
    );
    if (!result.ok) return result;
    const body = result.body as { choices?: Array<{ message?: { content?: unknown } }> };
    const text = cleanText(body.choices?.[0]?.message?.content);
    return text ? { ok: true, text } : { ok: false, error: "OpenAI returned no content" };
  }

  const result = await requestJson(
    `${GEMINI_ENDPOINT}/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(proposer.apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: messages.system }] },
        contents: [{ role: "user", parts: [{ text: messages.user }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    },
    "Gemini",
    deps,
  );
  if (!result.ok) return result;
  const body = result.body as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
  };
  const text = cleanText(body.candidates?.[0]?.content?.parts?.[0]?.text);
  return text ? { ok: true, text } : { ok: false, error: "Gemini returned no content" };
}

/**
 * Taxonomy growth, behind one dispatch so the provider is swappable
 * (`NOOK_AI_PROPOSER`). Returns empty arrays rather than throwing when the
 * provider is unset or unknown, the key is missing, or the call fails: an
 * unconfigured optional feature must not become a red error on the Settings
 * screen, and a failed proposal is simply no proposal.
 */
export async function proposeTaxonomy(
  input: ProposeTaxonomyRequest,
  deps: AiDeps = {},
): Promise<ProposeTaxonomyResponse> {
  const proposer = resolveProposer();
  if (!proposer) {
    console.warn("[ai] no taxonomy proposer configured; set NOOK_AI_PROPOSER and its API key");
    return { collections: [], tags: [] };
  }
  const messages = buildProposalMessages(
    input.sample,
    input.existingCollections,
    input.maxCollections,
    input.maxTags,
    input.language,
  );
  const generated = await generate(messages, proposer, deps);
  if (!generated.ok) {
    console.warn(`[ai] taxonomy proposal failed: ${generated.error}`);
    return { collections: [], tags: [] };
  }
  return parseTaxonomyProposal(generated.text, input.maxCollections, input.maxTags);
}
