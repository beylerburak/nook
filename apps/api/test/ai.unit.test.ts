import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_TAGS_CONSIDERED,
  NO_COLLECTION_OPTION,
  aiAvailability,
  buildClassificationQuestions,
  buildClassificationState,
  buildProposalMessages,
  classifyBookmark,
  classifyBookmarkOutcome,
  decideClassification,
  neutralClassification,
  normalizeTagName,
  parseClassifyRequest,
  parseProposeTaxonomyRequest,
  parseSystemOneResponse,
  parseTaxonomyProposal,
  proposeTaxonomy,
  type ClassifyCollection,
  type ClassifyRequest,
  type ClassifySettings,
  type ClassifyTag,
  type ParsedSystemOne,
  type SystemOneRequest,
} from "../src/ai.js";

const SETTINGS: ClassifySettings = { collectionMinConfidence: 0.85, tagMinNoul: 0.8, maxTags: 3 };
const NAMES = { c1: "Recipes", c2: "Databases" };

function collections(): ClassifyCollection[] {
  return [
    { id: "c1", name: "Recipes", samples: ["Sourdough starter", "Weeknight pasta", "Cold brew"] },
    { id: "c2", name: "Databases", samples: ["Postgres locking", "SQLite WAL"] },
  ];
}

function tags(): ClassifyTag[] {
  return [
    { name: "postgres", samples: ["Indexes", "EXPLAIN", "Vacuum", "WAL"] },
    { name: "bread", samples: ["Sourdough starter"] },
    { name: "unused", samples: [] },
  ];
}

function parsed(overrides: Partial<ParsedSystemOne> = {}): ParsedSystemOne {
  return {
    model: "jev-1.13.0",
    collection: { choice: "c1", confidence: 0.9, probabilities: { c1: 0.9, c2: 0.1 } },
    tagNouls: {},
    ...overrides,
  };
}

function jevRequest(questions: SystemOneRequest["questions"]): SystemOneRequest {
  return { state: { item: { title: "x" } }, model: "jev-latest", questions };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.NOOK_AI_PROPOSER;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

describe("buildClassificationState", () => {
  it("keeps only the five text fields, under `item`", () => {
    const state = buildClassificationState({
      id: "b1",
      title: "Postgres index selection",
      summary: "A long read",
      note: "read twice",
      site: "example.com",
      author: "Someone",
    });
    expect(state).toEqual({
      item: {
        title: "Postgres index selection",
        summary: "A long read",
        note: "read twice",
        site: "example.com",
        author: "Someone",
      },
    });
  });

  it("omits empty and whitespace-only fields rather than sending nulls", () => {
    const state = buildClassificationState({ id: "b1", title: "only a title", note: "   ", author: "" });
    expect(state.item).toEqual({ title: "only a title" });
    expect(JSON.stringify(state)).not.toContain("null");
  });

  it("never carries a description, even if the object has one", () => {
    const state = buildClassificationState({
      id: "b1",
      title: "Title",
      summary: "Truncated summary",
      ...({ description: "x".repeat(5000) } as Record<string, unknown>),
    } as ClassifyRequest["bookmark"]);
    expect(Object.keys(state.item)).toEqual(["title", "summary"]);
    expect(JSON.stringify(state)).not.toContain("xxxx");
  });

  it("clips a runaway field rather than blowing the state budget", () => {
    const state = buildClassificationState({ id: "b1", title: "y".repeat(5000) });
    expect(state.item.title).toHaveLength(500);
  });
});

describe("buildClassificationQuestions", () => {
  it("asks one choice question with a key per collection id plus the reserved option", () => {
    const questions = buildClassificationQuestions(collections(), tags());
    const choice = questions.collection as { type: string; criteria: Record<string, string | null> };
    expect(choice.type).toBe("choice");
    expect(Object.keys(choice.criteria).sort()).toEqual([NO_COLLECTION_OPTION, "c1", "c2"].sort());
    expect(choice.criteria.c1).toContain("Recipes");
    expect(choice.criteria.c1).toContain("Sourdough starter");
    expect(choice.criteria[NO_COLLECTION_OPTION]).toMatch(/none of the listed collections/i);
  });

  it("explicitly permits declining in the collection instructions", () => {
    const question = buildClassificationQuestions(collections(), tags()).collection as { instructions: string };
    expect(question.instructions).toContain(NO_COLLECTION_OPTION);
    expect(question.instructions).toMatch(/none of them fits/i);
  });

  it("gives a collection with no samples a bare-name criterion", () => {
    const questions = buildClassificationQuestions([{ id: "c9", name: "Unsorted", samples: [] }], []);
    const choice = questions.collection as { criteria: Record<string, string | null> };
    expect(choice.criteria.c9).toBe("Unsorted");
  });

  it("truncates a long sample digest instead of quoting the whole library", () => {
    const long = "z".repeat(300);
    const questions = buildClassificationQuestions([{ id: "c1", name: "Long", samples: [long] }], []);
    const choice = questions.collection as { criteria: Record<string, string | null> };
    expect(choice.criteria.c1).toHaveLength("Long — contains: ".length + 90);
  });

  it("adds one plain noul question per tag, keyed tag::<name>, with true/false criteria", () => {
    const questions = buildClassificationQuestions(collections(), tags());
    const noul = questions["tag::postgres"] as {
      type: string;
      instructions: string;
      criteria: { true: string; false: string };
    };
    expect(noul.type).toBe("noul");
    expect(noul.instructions).toContain("postgres");
    expect(noul.criteria.true).toBeTruthy();
    expect(noul.criteria.false).toMatch(/something else/i);
  });

  // docs/ai-calibration.md. The tag nouls deliberately carry NO member-title
  // digest, unlike the collection Choice next to them. Measured: adding it cost
  // 58% of the request's tokens and dropped tag recall from 81.7% to 47.9% at
  // the same threshold. A Noul is an absolute question, and evidence inside it
  // turns it into a similarity comparison against the wrong thing. This test
  // exists so nobody "fixes" the asymmetry without reading that first.
  it("keeps the sample digest off the tag nouls and on the collection Choice", () => {
    const questions = buildClassificationQuestions(collections(), tags());
    const noul = questions["tag::postgres"] as { instructions: string; criteria: Record<string, string> };
    const choice = questions.collection as { criteria: Record<string, string> };
    // "Indexes" is a sample of the `postgres` tag, so it is the digest's tell.
    expect(noul.instructions).not.toContain("Indexes");
    expect(noul.criteria.true).not.toContain("Indexes");
    // The digest earns its keep on the Choice: 8.7 points of top-1.
    expect(choice.criteria.c1).toContain("Sourdough starter");
  });

  it("caps tag questions at 20 by default, keeping the most-used tags", () => {
    const many: ClassifyTag[] = Array.from({ length: 30 }, (_, i) => ({
      name: `tag${i}`,
      samples: Array.from({ length: i }, (_, s) => `sample ${s}`),
    }));
    const questions = buildClassificationQuestions(collections(), many);
    const asked = Object.keys(questions).filter((id) => id.startsWith("tag::"));
    expect(asked).toHaveLength(DEFAULT_MAX_TAGS_CONSIDERED);
    expect(asked).toContain("tag::tag29");
    expect(asked).not.toContain("tag::tag0");
  });

  it("sorts tags by sample count desc, not by the order they arrived in", () => {
    const questions = buildClassificationQuestions(collections(), [
      { name: "rare", samples: ["one"] },
      { name: "common", samples: ["a", "b", "c", "d"] },
    ]);
    expect(Object.keys(questions).filter((id) => id.startsWith("tag::"))).toEqual([
      "tag::common",
      "tag::rare",
    ]);
  });

  it("honours an explicit cap of zero", () => {
    const questions = buildClassificationQuestions(collections(), tags(), 0);
    expect(Object.keys(questions)).toEqual(["collection"]);
  });

  it("keeps the reserved key even if a collection is literally named __none__", () => {
    const questions = buildClassificationQuestions([{ id: NO_COLLECTION_OPTION, name: "Odd", samples: [] }], []);
    const choice = questions.collection as { criteria: Record<string, string | null> };
    expect(choice.criteria[NO_COLLECTION_OPTION]).toMatch(/None of the listed collections/i);
  });
});

describe("decideClassification: collection", () => {
  it("assigns at exactly the threshold (>=)", () => {
    const response = decideClassification(
      parsed({ collection: { choice: "c1", confidence: 0.85, probabilities: { c1: 0.85 } } }),
      SETTINGS,
      NAMES,
    );
    expect(response.collection).toEqual({
      assign: true,
      id: "c1",
      name: "Recipes",
      confidence: 0.85,
      probabilities: { c1: 0.85 },
    });
    expect(response.skipped).toBeUndefined();
  });

  it("does not assign just below the threshold", () => {
    const response = decideClassification(
      parsed({ collection: { choice: "c1", confidence: 0.8499, probabilities: { c1: 0.8499 } } }),
      SETTINGS,
      NAMES,
    );
    expect(response.collection.assign).toBe(false);
    expect(response.collection.id).toBeNull();
    expect(response.collection.name).toBeNull();
    expect(response.skipped).toBe("low-confidence");
  });

  it("never assigns when the model declined, whatever the confidence", () => {
    const response = decideClassification(
      parsed({
        collection: { choice: NO_COLLECTION_OPTION, confidence: 0.99, probabilities: { [NO_COLLECTION_OPTION]: 0.99 } },
      }),
      SETTINGS,
      NAMES,
    );
    expect(response.collection.assign).toBe(false);
    expect(response.collection.id).toBeNull();
    expect(response.skipped).toBe("none-fit");
  });

  it("keeps confidence and probabilities on a low-confidence skip so it stays loggable", () => {
    const response = decideClassification(
      parsed({ collection: { choice: "c2", confidence: 0.61, probabilities: { c1: 0.39, c2: 0.61 } } }),
      SETTINGS,
      NAMES,
    );
    expect(response.collection.assign).toBe(false);
    expect(response.collection.confidence).toBe(0.61);
    expect(response.collection.probabilities).toEqual({ c1: 0.39, c2: 0.61 });
    expect(response.skipped).toBe("low-confidence");
  });

  it("treats a choice we never offered as a skip, not an assignment", () => {
    const response = decideClassification(
      parsed({ collection: { choice: "c-invented", confidence: 1, probabilities: {} } }),
      SETTINGS,
      NAMES,
    );
    expect(response.collection.assign).toBe(false);
    expect(response.skipped).toBe("low-confidence");
  });

  it("passes usage through and the model name", () => {
    const response = decideClassification(parsed({ usage: { inputTokens: 800, outputTokens: 20 } }), SETTINGS, NAMES);
    expect(response.model).toBe("jev-1.13.0");
    expect(response.usage).toEqual({ inputTokens: 800, outputTokens: 20 });
  });
});

describe("decideClassification: tags", () => {
  it("keeps a tag exactly at the threshold (>=)", () => {
    const response = decideClassification(
      parsed({ tagNouls: { postgres: 0.8 } }),
      SETTINGS,
      NAMES,
    );
    expect(response.tags).toEqual([{ name: "postgres", noul: 0.8 }]);
  });

  it("drops a tag just below the threshold", () => {
    const response = decideClassification(parsed({ tagNouls: { postgres: 0.7999 } }), SETTINGS, NAMES);
    expect(response.tags).toEqual([]);
  });

  it("sorts desc, caps at maxTags, and applies the threshold", () => {
    const response = decideClassification(
      parsed({
        tagNouls: { a: 0.9, b: 0.85, c: 0.83, d: 0.82, e: 0.1 },
      }),
      SETTINGS,
      NAMES,
    );
    expect(response.tags).toEqual([
      { name: "a", noul: 0.9 },
      { name: "b", noul: 0.85 },
      { name: "c", noul: 0.83 },
    ]);
  });

  it("normalises names the way the client does before returning them", () => {
    const response = decideClassification(parsed({ tagNouls: { "  #Postgres ": 0.9 } }), SETTINGS, NAMES);
    expect(response.tags).toEqual([{ name: "postgres", noul: 0.9 }]);
  });

  it("collapses two spellings of one tag into the strongest", () => {
    const response = decideClassification(parsed({ tagNouls: { Postgres: 0.9, "#postgres": 0.95 } }), SETTINGS, NAMES);
    expect(response.tags).toEqual([{ name: "postgres", noul: 0.95 }]);
  });

  it("clamps an out-of-range noul and a negative maxTags to nothing", () => {
    const clamped = decideClassification(parsed({ tagNouls: { a: 5 } }), { ...SETTINGS, tagMinNoul: 0.5 }, NAMES);
    expect(clamped.tags).toEqual([{ name: "a", noul: 1 }]);
    const none = decideClassification(parsed({ tagNouls: { a: 1 } }), { ...SETTINGS, maxTags: 0 }, NAMES);
    expect(none.tags).toEqual([]);
  });

  it("returns tags even when the collection was skipped", () => {
    const response = decideClassification(
      parsed({
        collection: { choice: NO_COLLECTION_OPTION, confidence: 0.5, probabilities: {} },
        tagNouls: { postgres: 0.95 },
      }),
      SETTINGS,
      NAMES,
    );
    expect(response.collection.assign).toBe(false);
    expect(response.tags).toEqual([{ name: "postgres", noul: 0.95 }]);
  });
});

describe("parseSystemOneResponse", () => {
  const request = jevRequest(buildClassificationQuestions(collections(), tags()));

  it("maps a well-formed response", () => {
    const parsedResponse = parseSystemOneResponse(
      {
        model: "jev-1.13.0",
        answers: {
          collection: { type: "choice", choice: "c1", confidence: 0.91, probabilities: { c1: 0.91, c2: 0.09 } },
          "tag::postgres": { type: "noul", noul: 0.88 },
        },
        usage: { input_tokens: 812, output_tokens: 20 },
      },
      request,
    );
    expect(parsedResponse.model).toBe("jev-1.13.0");
    expect(parsedResponse.collection).toEqual({
      choice: "c1",
      confidence: 0.91,
      probabilities: { c1: 0.91, c2: 0.09 },
    });
    expect(parsedResponse.tagNouls).toEqual({ postgres: 0.88, bread: 0, unused: 0 });
    expect(parsedResponse.usage).toEqual({ inputTokens: 812, outputTokens: 20 });
  });

  it("survives a body that is not an object at all", () => {
    const parsedResponse = parseSystemOneResponse("nope", request);
    expect(parsedResponse.collection).toEqual({ choice: "", confidence: 0, probabilities: {} });
    expect(parsedResponse.tagNouls).toEqual({ postgres: 0, bread: 0, unused: 0 });
  });

  it("survives a missing answer for a question we asked", () => {
    const parsedResponse = parseSystemOneResponse({ answers: {} }, request);
    expect(parsedResponse.collection.choice).toBe("");
    expect(parsedResponse.tagNouls.postgres).toBe(0);
  });

  it("survives a missing probability entry and a non-numeric one", () => {
    const parsedResponse = parseSystemOneResponse(
      { answers: { collection: { choice: "c1", confidence: 0.9, probabilities: { c1: 0.9, c2: "high" } } } },
      request,
    );
    expect(parsedResponse.collection.probabilities).toEqual({ c1: 0.9, c2: 0 });
  });

  it("clamps out-of-range confidence and nouls", () => {
    const parsedResponse = parseSystemOneResponse(
      {
        answers: {
          collection: { choice: "c1", confidence: 4, probabilities: { c1: -3 } },
          "tag::postgres": { type: "noul", noul: 12 },
        },
      },
      request,
    );
    expect(parsedResponse.collection.confidence).toBe(1);
    expect(parsedResponse.collection.probabilities.c1).toBe(0);
    expect(parsedResponse.tagNouls.postgres).toBe(1);
  });

  it("ignores an answer key we never asked about", () => {
    const parsedResponse = parseSystemOneResponse(
      { answers: { collection: { choice: "c1", confidence: 1, probabilities: {} }, "tag::invented": { noul: 1 } } },
      request,
    );
    expect(Object.keys(parsedResponse.tagNouls)).toEqual(["postgres", "bread", "unused"]);
  });

  it("reports zero usage rather than NaN when usage is missing", () => {
    expect(parseSystemOneResponse({ answers: {} }, request).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("parseTaxonomyProposal", () => {
  it("parses a clean proposal", () => {
    const result = parseTaxonomyProposal(
      JSON.stringify({
        collections: [{ name: "Sourdough Baking", why: "Starter maintenance and bread science." }],
        tags: [{ name: "yeast" }, { name: "kneading" }],
      }),
    );
    expect(result).toEqual({
      collections: [{ name: "Sourdough Baking", why: "Starter maintenance and bread science." }],
      tags: [{ name: "yeast" }, { name: "kneading" }],
    });
  });

  it("strips a code fence", () => {
    const result = parseTaxonomyProposal(
      '```json\n{"collections":[{"name":"Türkiye Mutfağı","why":"Yemek tarifleri."}],"tags":[{"name":"tarif"}]}\n```',
    );
    expect(result.collections).toEqual([{ name: "Türkiye Mutfağı", why: "Yemek tarifleri." }]);
    expect(result.tags).toEqual([{ name: "tarif" }]);
  });

  it("recovers a fence with prose around it", () => {
    const result = parseTaxonomyProposal('Sure! {"tags":[{"name":"ai"}]} Hope that helps.');
    expect(result.tags).toEqual([{ name: "ai" }]);
  });

  it("returns empty arrays on junk instead of throwing", () => {
    expect(parseTaxonomyProposal("I cannot help with that")).toEqual({ collections: [], tags: [] });
    expect(parseTaxonomyProposal("{not json}")).toEqual({ collections: [], tags: [] });
    expect(parseTaxonomyProposal("")).toEqual({ collections: [], tags: [] });
  });

  it("drops malformed entries", () => {
    const result = parseTaxonomyProposal(
      JSON.stringify({
        collections: [null, "nope", { why: "no name" }, { name: "  " }, { name: "Valid One", why: "Because." }],
        tags: [null, 3, { name: "" }, "  ", { name: "good" }],
      }),
    );
    expect(result.collections).toEqual([{ name: "Valid One", why: "Because." }]);
    expect(result.tags).toEqual([{ name: "good" }]);
  });

  it("dedupes case-insensitively and normalises tag names", () => {
    const result = parseTaxonomyProposal(
      JSON.stringify({
        collections: [
          { name: "Coffee", why: "Brewing." },
          { name: "coffee", why: "Duplicate." },
        ],
        tags: [{ name: "Brew" }, { name: "#brew" }, " BREW "],
      }),
    );
    expect(result.collections).toEqual([{ name: "Coffee", why: "Brewing." }]);
    expect(result.tags).toEqual([{ name: "brew" }]);
  });

  it("clamps over-long lists to the maxima", () => {
    const result = parseTaxonomyProposal(
      JSON.stringify({
        collections: Array.from({ length: 12 }, (_, i) => ({ name: `Collection ${i}`, why: "why" })),
        tags: Array.from({ length: 30 }, (_, i) => ({ name: `tag${i}` })),
      }),
      8,
      20,
    );
    expect(result.collections).toHaveLength(8);
    expect(result.tags).toHaveLength(20);
  });

  it("defaults the maxima to the contract's 8 / 20", () => {
    const result = parseTaxonomyProposal(
      JSON.stringify({
        collections: Array.from({ length: 10 }, (_, i) => ({ name: `C ${i}`, why: "why" })),
        tags: Array.from({ length: 25 }, (_, i) => ({ name: `t${i}` })),
      }),
    );
    expect(result.collections).toHaveLength(8);
    expect(result.tags).toHaveLength(20);
  });
});

describe("buildProposalMessages", () => {
  it("demands strict JSON and caps the list sizes", () => {
    const { system } = buildProposalMessages([{ title: "a", site: "b" }], [], 4, 9);
    expect(system).toContain("at most 4 collections");
    expect(system).toContain("at most 9 tags");
    expect(system).toMatch(/JSON only/i);
    expect(system).toMatch(/same language/i);
  });

  it("lists the sample and the collections not to re-propose", () => {
    const { user } = buildProposalMessages(
      [
        { title: "Sourdough starter", site: "example.com" },
        { title: "No site", site: "" },
      ],
      ["Recipes"],
      8,
      20,
    );
    expect(user).toContain("Sourdough starter (example.com)");
    expect(user).toContain("- No site");
    expect(user).toContain("Recipes");
  });
});

describe("aiAvailability", () => {
  it("reports nothing configured when the environment is empty", () => {
    expect(aiAvailability()).toEqual({ classify: false, proposer: null, proposeTaxonomy: false });
  });

  it("reports the proposer only when its key is present", () => {
    process.env.NOOK_AI_PROPOSER = "gemini";
    expect(aiAvailability().proposeTaxonomy).toBe(false);
    process.env.GEMINI_API_KEY = "k";
    expect(aiAvailability()).toEqual({ classify: false, proposer: "gemini", proposeTaxonomy: true });
  });

  it("ignores an unknown proposer", () => {
    process.env.NOOK_AI_PROPOSER = "llama";
    process.env.OPENAI_API_KEY = "k";
    expect(aiAvailability()).toEqual({ classify: false, proposer: null, proposeTaxonomy: false });
  });
});

describe("proposeTaxonomy", () => {
  const input = parseProposeTaxonomyRequest({ sample: [{ title: "Sourdough", site: "x.com" }] });

  it("returns empty arrays when no provider is configured, without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(proposeTaxonomy(input)).resolves.toEqual({ collections: [], tags: [] });
    expect(warn).toHaveBeenCalled();
  });

  it("returns empty arrays when the provider is set but its key is missing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.NOOK_AI_PROPOSER = "openai";
    await expect(proposeTaxonomy(input)).resolves.toEqual({ collections: [], tags: [] });
  });

  it("calls the injected stub and parses its content", async () => {
    const fetchStub = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({
        choices: [{ message: { content: '```json\n{"collections":[{"name":"Baking","why":"Flour."}],"tags":[{"name":"yeast"}]}\n```' } }],
      }),
    );
    process.env.NOOK_AI_PROPOSER = "openai";
    process.env.OPENAI_API_KEY = "test-key";

    const result = await proposeTaxonomy(input, { fetch: fetchStub });
    expect(result).toEqual({ collections: [{ name: "Baking", why: "Flour." }], tags: [{ name: "yeast" }] });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key" });
    const body = JSON.parse(String(init.body));
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].content).toContain("Sourdough");
  });

  it("clamps the stub's over-long proposal to the request's maxima", async () => {
    const fetchStub = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                collections: Array.from({ length: 20 }, (_, i) => ({ name: `C ${i}`, why: "why" })),
                tags: Array.from({ length: 50 }, (_, i) => ({ name: `t${i}` })),
              }),
            },
          },
        ],
      }),
    );
    process.env.NOOK_AI_PROPOSER = "openai";
    process.env.OPENAI_API_KEY = "test-key";

    const result = await proposeTaxonomy({ ...input, maxCollections: 2, maxTags: 3 }, { fetch: fetchStub });
    expect(result.collections).toHaveLength(2);
    expect(result.tags).toHaveLength(3);
  });

  it("degrades to empty arrays when the provider errors", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchStub = vi.fn(async () => new Response("nope", { status: 401 }));
    process.env.NOOK_AI_PROPOSER = "gemini";
    process.env.GEMINI_API_KEY = "test-key";

    await expect(proposeTaxonomy(input, { fetch: fetchStub, sleep: async () => {} })).resolves.toEqual({
      collections: [],
      tags: [],
    });
    // 401 is a configuration error, so it must not be retried.
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("reads Gemini's content shape", async () => {
    const fetchStub = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: '{"collections":[],"tags":[{"name":"k"}]}' }] } }] }),
    );
    process.env.NOOK_AI_PROPOSER = "gemini";
    process.env.GEMINI_API_KEY = "test-key";

    const result = await proposeTaxonomy(input, { fetch: fetchStub });
    expect(result.tags).toEqual([{ name: "k" }]);
    const [url, init] = fetchStub.mock.calls[0];
    expect(String(url)).toContain("key=test-key");
    expect(JSON.parse(String(init.body)).systemInstruction).toBeDefined();
  });
});

describe("classifyBookmark", () => {
  // Comfortably over MIN_CLASSIFIABLE_CHARS: the bare-title case is its own test
  // below, because the floor is a cost guard this fixture would otherwise trip.
  const request: ClassifyRequest = parseClassifyRequest({
    bookmark: {
      id: "b1",
      title: "Postgres index selection",
      summary: "Why a sequential scan beat the composite index on a 40M row table",
    },
    collections: collections(),
    tags: tags(),
    settings: SETTINGS,
  });

  it("degrades to a neutral decision when no key is configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchStub = vi.fn();
    await expect(classifyBookmark(request, { fetch: fetchStub })).resolves.toEqual(neutralClassification());
    expect(fetchStub).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("sends the filtered state and the built questions, then decides", async () => {
    const fetchStub = vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(String(init.body));
      expect(sent.model).toBe("jev-latest");
      expect(sent.state).toEqual({
        item: {
          title: "Postgres index selection",
          summary: "Why a sequential scan beat the composite index on a 40M row table",
        },
      });
      expect(Object.keys(sent.questions)).toContain("tag::postgres");
      return jsonResponse({
        model: "jev-1.13.0",
        answers: {
          collection: { type: "choice", choice: "c2", confidence: 0.93, probabilities: { c1: 0.07, c2: 0.93 } },
          "tag::postgres": { type: "noul", noul: 0.94 },
        },
        usage: { input_tokens: 800, output_tokens: 20 },
      });
    });
    process.env.TYPESAFE_API_KEY = "test-key";

    const response = await classifyBookmark(request, { fetch: fetchStub });
    expect(response.collection).toEqual({
      assign: true,
      id: "c2",
      name: "Databases",
      confidence: 0.93,
      probabilities: { c1: 0.07, c2: 0.93 },
    });
    expect(response.tags).toEqual([{ name: "postgres", noul: 0.94 }]);
    expect(response.usage).toEqual({ inputTokens: 800, outputTokens: 20 });
    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key" });
  });

  it("degrades to a neutral decision on a 500 rather than throwing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchStub = vi.fn(async () => new Response("boom", { status: 500 }));
    process.env.TYPESAFE_API_KEY = "test-key";
    await expect(classifyBookmark(request, { fetch: fetchStub, sleep: async () => {} })).resolves.toEqual(
      neutralClassification(),
    );
  });

  it("retries a 429 with backoff and succeeds on the second attempt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const slept: number[] = [];
    const fetchStub = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
      }
      return jsonResponse({
        model: "jev-1.13.0",
        answers: { collection: { type: "choice", choice: "c1", confidence: 0.99, probabilities: { c1: 0.99 } } },
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    process.env.TYPESAFE_API_KEY = "test-key";

    const response = await classifyBookmark(request, {
      fetch: fetchStub,
      sleep: async (ms) => void slept.push(ms),
    });
    expect(calls).toBe(2);
    expect(slept[0]).toBeGreaterThanOrEqual(1000);
    expect(response.collection.assign).toBe(true);
  });

  it("gives up after three attempts on a persistent 529", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchStub = vi.fn(async () => new Response("overloaded", { status: 529 }));
    process.env.TYPESAFE_API_KEY = "test-key";
    const response = await classifyBookmark(request, { fetch: fetchStub, sleep: async () => {} });
    expect(fetchStub).toHaveBeenCalledTimes(3);
    expect(response).toEqual(neutralClassification());
  });

  // docs/ai-calibration.md: 39 of a real 1,061-bookmark library carry under 40
  // characters of state text and 15 carry under 20 — a bare emoji, two words, or
  // just the author's handle. The model answers those at full price and returns a
  // coin flip, so they are skipped before the request rather than after it.
  it("skips the call for a bookmark whose text is too short to mean anything", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchStub = vi.fn();
    process.env.TYPESAFE_API_KEY = "test-key";
    const response = await classifyBookmark(
      { ...request, bookmark: { id: "b3", title: "🙃 Based" } },
      { fetch: fetchStub },
    );
    expect(fetchStub).not.toHaveBeenCalled();
    expect(response).toEqual(neutralClassification());
    expect(warn).toHaveBeenCalled();
  });

  // A throttled key must be distinguishable from "the model had nothing to
  // say", or the client reads a neutral 200 as a decision and retires the
  // bookmark for good without ever having been classified.
  it("reports throttling separately from a neutral decision", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.TYPESAFE_API_KEY = "test-key";
    const throttled = vi.fn(async () => new Response("slow down", { status: 429 }));
    const outcome = await classifyBookmarkOutcome(request, { fetch: throttled, sleep: async () => {} });
    expect(outcome.throttled).toBe(true);
    expect(outcome.response).toEqual(neutralClassification());

    // A 401 will never fix itself, so it is a plain failure, not throttling.
    const denied = vi.fn(async () => new Response("nope", { status: 401 }));
    const deniedOutcome = await classifyBookmarkOutcome(request, { fetch: denied, sleep: async () => {} });
    expect(deniedOutcome.throttled).toBe(false);
  });

  it("skips the call for a bookmark with no text at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchStub = vi.fn();
    process.env.TYPESAFE_API_KEY = "test-key";
    const response = await classifyBookmark({ ...request, bookmark: { id: "b2" } }, { fetch: fetchStub });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(response).toEqual(neutralClassification());
    expect(warn).toHaveBeenCalled();
  });
});

describe("parseClassifyRequest", () => {
  it("fills in the measured defaults when settings are absent", () => {
    const parsedRequest = parseClassifyRequest({ bookmark: { id: "b1", title: "t" } });
    // 0.75, not the 0.85 this started at: measured on 57 hand-labelled real
    // bookmarks, 0.75 files 22 (20 correct) against 0.85's 15 (13 correct) for
    // the same count of 2 wrong. See docs/ai-calibration.md.
    expect(parsedRequest.settings).toEqual({ collectionMinConfidence: 0.75, tagMinNoul: 0.8, maxTags: 3 });
    expect(parsedRequest.collections).toEqual([]);
    expect(parsedRequest.tags).toEqual([]);
  });

  it("rejects a malformed body", () => {
    expect(() => parseClassifyRequest(null)).toThrow("Invalid request");
    expect(() => parseClassifyRequest({})).toThrow("Invalid bookmark");
    expect(() => parseClassifyRequest({ bookmark: { id: "  " } })).toThrow("Invalid bookmark id");
    expect(() => parseClassifyRequest({ bookmark: { id: "b1" }, collections: {} })).toThrow("Invalid collections array");
    expect(() => parseClassifyRequest({ bookmark: { id: "b1" }, tags: "x" })).toThrow("Invalid tags array");
    expect(() => parseClassifyRequest({ bookmark: { id: "b1" }, settings: 3 })).toThrow("Invalid settings");
  });

  it("rejects more collections than a Choice can hold", () => {
    const many = Array.from({ length: 255 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, samples: [] }));
    expect(() => parseClassifyRequest({ bookmark: { id: "b1" }, collections: many })).toThrow("Too many collections");
  });

  it("drops unusable collection and tag entries instead of failing the request", () => {
    const parsedRequest = parseClassifyRequest({
      bookmark: { id: "b1", title: "t" },
      collections: [null, { name: "no id" }, { id: "c1" }, { id: "c2", name: "Good" }],
      tags: [{ samples: [] }, { name: "  " }, { name: "keep", samples: ["a", 3, ""] }],
    });
    expect(parsedRequest.collections).toEqual([{ id: "c2", name: "Good", samples: [] }]);
    expect(parsedRequest.tags).toEqual([{ name: "keep", samples: ["a"] }]);
  });

  it("clamps a threshold into 0..1 and floors a count", () => {
    const parsedRequest = parseClassifyRequest({
      bookmark: { id: "b1" },
      settings: { collectionMinConfidence: 5, tagMinNoul: -1, maxTags: 2.7 },
    });
    expect(parsedRequest.settings).toEqual({ collectionMinConfidence: 1, tagMinNoul: 0, maxTags: 2 });
  });

  it("rejects a non-numeric threshold rather than defaulting it", () => {
    expect(() =>
      parseClassifyRequest({ bookmark: { id: "b1" }, settings: { tagMinNoul: "high" } }),
    ).toThrow("Invalid threshold");
  });
});

describe("parseProposeTaxonomyRequest", () => {
  it("defaults the maxima to the contract's 8 and 20, and the language to auto", () => {
    const parsedRequest = parseProposeTaxonomyRequest({ sample: [{ title: "a", site: "b" }] });
    expect(parsedRequest).toEqual({
      sample: [{ title: "a", site: "b" }],
      existingCollections: [],
      maxCollections: 8,
      maxTags: 20,
      language: "auto",
    });
  });

  it("keeps a language it knows and falls back to auto for one it does not", () => {
    // A preference, not a precondition: a client on a newer build asking for a
    // language this server has not heard of should still get suggestions.
    expect(parseProposeTaxonomyRequest({ sample: [], language: "tr" }).language).toBe("tr");
    expect(parseProposeTaxonomyRequest({ sample: [], language: "TR" }).language).toBe("tr");
    expect(parseProposeTaxonomyRequest({ sample: [], language: "klingon" }).language).toBe("auto");
    expect(parseProposeTaxonomyRequest({ sample: [], language: 7 }).language).toBe("auto");
  });

  it("rejects a malformed body", () => {
    expect(() => parseProposeTaxonomyRequest(null)).toThrow("Invalid request");
    expect(() => parseProposeTaxonomyRequest({})).toThrow("Invalid sample array");
    expect(() => parseProposeTaxonomyRequest({ sample: [], existingCollections: "x" })).toThrow(
      "Invalid existingCollections array",
    );
  });
});

describe("tag definitions and proposal language", () => {
  it("puts a tag's definition in the noul's true criteria", () => {
    const questions = buildClassificationQuestions(
      [],
      [{ name: "yazılım geliştirme", samples: [], definition: "Kod yazan, bir uygulama ya da kütüphane üreten içerik." }],
    );
    const noul = questions["tag::yazılım geliştirme"] as { criteria: { true: string } };
    expect(noul.criteria.true).toContain("Kod yazan");
  });

  it("asks a definition-less tag by name alone, and still keeps the member digest out", () => {
    // Both halves matter. A tag with members and no definition must not fall
    // back to quoting those members: that digest halved tag recall when it was
    // on every tag (docs/ai-calibration.md).
    const questions = buildClassificationQuestions(
      [],
      [{ name: "web", samples: ["Bir CSS grid rehberi", "Postgres index seçimi"] }],
    );
    const noul = questions["tag::web"] as { instructions: string; criteria: { true: string } };
    expect(noul.criteria.true).toBe("The item is the kind of thing this tag is for.");
    expect(noul.criteria.true).not.toContain("CSS grid");
    expect(noul.instructions).not.toContain("Postgres");
  });

  it("parses a tag's why out of the proposal and keeps one without it", () => {
    const parsed = parseTaxonomyProposal(
      '{"collections":[],"tags":[{"name":"Web","why":"Front-end work."},{"name":"rust"}]}',
    );
    expect(parsed.tags).toEqual([{ name: "web", why: "Front-end work." }, { name: "rust" }]);
  });

  it("keeps the definition on the way to a question", () => {
    // The whole point of the `why`: it survives parsing, survives the wire, and
    // lands in the question the model is asked.
    const parsedRequest = parseClassifyRequest({
      bookmark: { id: "b1", title: "t" },
      tags: [{ name: "web", definition: "Front-end work." }],
    });
    const questions = buildClassificationQuestions([], parsedRequest.tags);
    const noul = questions["tag::web"] as { criteria: { true: string } };
    expect(noul.criteria.true).toContain("Front-end work.");
  });

  it("names the language the user chose, and follows the sample when they did not", () => {
    const sample = [{ title: "CSS grid rehberi", site: "" }];
    expect(buildProposalMessages(sample, [], 8, 20, "tr").system).toContain("Turkish");
    expect(buildProposalMessages(sample, [], 8, 20, "en").system).toContain("English");
    expect(buildProposalMessages(sample, [], 8, 20, "auto").system).toContain("same language as the sample");
    // Default parameter, for a caller that never passes one.
    expect(buildProposalMessages(sample, [], 8, 20).system).toContain("same language as the sample");
  });

  it("asks the proposer for a why on every tag, not just every collection", () => {
    const system = buildProposalMessages([{ title: "a", site: "" }], [], 8, 20).system;
    expect(system).toContain('"tags":[{"name":"...","why":"..."}]');
    expect(system).toMatch(/every tag needs a one-sentence `why`/i);
  });
});

describe("Turkish-aware name folding", () => {
  // Found by running the proposer against the real library, not by reading the
  // code. Both halves have bitten: "İş" became "i̇ş" with a combining dot under
  // a plain toLowerCase, and "UI" became "uı" under a whole-string Turkish
  // locale. The per-word fold in apps/extension/lib/ai-classify.ts is the fix
  // and MUST be mirrored here.
  it("folds a Turkish dotted I without leaving a combining mark", () => {
    expect(normalizeTagName("İş Akışları")).toBe("iş akışları");
    expect(normalizeTagName("Eğitim İçeriği")).toBe("eğitim içeriği");
  });

  it("keeps an English initialism intact inside a Turkish name", () => {
    expect(normalizeTagName("UI Tasarımları")).toBe("ui tasarımları");
    expect(normalizeTagName("AI")).toBe("ai");
  });

  it("folds two spellings of one Turkish word onto the same key", () => {
    // The silent version of the same bug: under a whole-string locale these two
    // produced "çağri" and "çağrı", which never match each other.
    expect(normalizeTagName("ÇAĞRI")).toBe(normalizeTagName("çağrı"));
  });

  it("strips a leading hash and lowercases, still Turkish-aware", () => {
    expect(normalizeTagName("  #İlk Adım  ")).toBe("ilk adım");
  });
});

describe("proposer model selection", () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it("defaults to the model that measured best on a Turkish library", async () => {
    delete process.env.NOOK_AI_MODEL;
    process.env.NOOK_AI_PROPOSER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    const fetchStub = vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(String(init.body)) as { model: string; reasoning_effort?: string };
      expect(sent.model).toBe("gpt-4o-mini");
      // gpt-4 answers 400 on an unrecognised argument, so this must not be sent.
      expect(sent.reasoning_effort).toBeUndefined();
      return jsonResponse({ choices: [{ message: { content: '{"collections":[],"tags":[]}' } }] });
    });
    await proposeTaxonomy(
      { sample: [{ title: "a", site: "" }], existingCollections: [], maxCollections: 8, maxTags: 20 },
      { fetch: fetchStub },
    );
    expect(fetchStub).toHaveBeenCalled();
  });

  it("honours NOOK_AI_MODEL, and adds reasoning_effort only for a family that takes it", async () => {
    process.env.NOOK_AI_PROPOSER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    const seen: Array<{ model: string; reasoning_effort?: string }> = [];
    const fetchStub = vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(String(init.body)) as { model: string; reasoning_effort?: string };
      seen.push(sent);
      return jsonResponse({ choices: [{ message: { content: '{"collections":[],"tags":[]}' } }] });
    });
    const call = () =>
      proposeTaxonomy(
        { sample: [{ title: "a", site: "" }], existingCollections: [], maxCollections: 8, maxTags: 20 },
        { fetch: fetchStub },
      );

    process.env.NOOK_AI_MODEL = "gpt-5-nano";
    await call();
    // The gpt-5 family reasons before it answers, and at a small budget will use
    // the whole allowance and return nothing.
    expect(seen.at(-1)).toMatchObject({ model: "gpt-5-nano", reasoning_effort: "minimal" });

    process.env.NOOK_AI_MODEL = "gpt-4o-mini";
    await call();
    expect(seen.at(-1)?.reasoning_effort).toBeUndefined();
  });
});
