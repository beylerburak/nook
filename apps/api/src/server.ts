import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth, allowedOrigins, allowSignUp, pool } from "./auth.js";
import { parseSyncRequest, syncRecords } from "./sync.js";
import {
  aiAvailability,
  classifyBookmarkOutcome,
  jevAvailable,
  parseClassifyRequest,
  parseProposeTaxonomyRequest,
  proposeTaxonomy,
} from "./ai.js";
import { getAiUserSettings, parseAiUserSettingsPatch, saveAiUserSettingsPatch } from "./ai-settings.js";
import { readAiStatus } from "./ai-store.js";
import {
  ProposerUnavailableError,
  acceptTaxonomyForUser,
  parseTaxonomyAcceptance,
  parseTaxonomyProposeBody,
  proposeTaxonomyForUser,
  requestClassificationRun,
  startAiWorker,
} from "./ai-jobs.js";
import { embedTexts, reconcileIndex } from "./embeddings.js";
import { parseSearchRequest, searchBookmarks } from "./retrieval.js";
import { requestSummaryRun } from "./ai-summary.js";

const app = new Hono();

app.use("/api/*", cors({
  origin: (origin) => allowedOrigins.has(origin) ? origin : "",
  allowHeaders: ["Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
  exposeHeaders: ["set-auth-token"],
  credentials: true,
}));

app.get("/health", async (c) => {
  await pool.query("SELECT 1");
  return c.json({ ok: true });
});

app.get("/api/config", (c) => c.json({ allowSignUp }));

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.post("/api/sync", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  let request;
  try {
    request = parseSyncRequest(await c.req.json());
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
  }
  return c.json(await syncRecords(pool, session.user.id, request));
});

// Both AI routes are authenticated server calls, so a signed-out extension in
// local-only mode gets a 401 and the client shows "sign in to use AI" instead of
// silently doing nothing (docs/ai.md, Settings surface).

app.post("/api/ai/classify", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  let request;
  try {
    request = parseClassifyRequest(await c.req.json());
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
  }
  // 503 rather than a neutral 200: the client must be able to tell "not
  // configured on this server" from "the model had nothing to say", otherwise
  // the feature looks broken instead of unavailable.
  if (!jevAvailable()) return c.json({ error: "AI classification is not configured" }, 503);
  const outcome = await classifyBookmarkOutcome(request);
  // Upstream throttling is the client's problem to solve — it owns the backoff —
  // and hiding it behind a neutral 200 made a throttled key look like a model
  // with nothing to say, permanently retiring those bookmarks.
  if (outcome.throttled) return c.json({ error: "Upstream model is throttling" }, 429);
  return c.json(outcome.response);
});

app.post("/api/ai/propose-taxonomy", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  let request;
  try {
    request = parseProposeTaxonomyRequest(await c.req.json());
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
  }
  return c.json(await proposeTaxonomy(request));
});

// The toggles and thresholds themselves — see apps/api/src/ai-settings.ts.
// Account-wide, not per-browser: this is the fix for the gap docs/ai.md used
// to describe under "AI settings scoped to the extension" — a toggle flipped
// in the web app now writes the same row the extension's runner reads before
// every pass, instead of a per-origin IndexedDB key nothing else could see.
app.get("/api/ai/settings", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  return c.json(await getAiUserSettings(pool, session.user.id));
});

app.put("/api/ai/settings", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  let patch;
  try {
    patch = parseAiUserSettingsPatch(await c.req.json());
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
  }
  return c.json(await saveAiUserSettingsPatch(pool, session.user.id, patch));
});

// The four routes the classification pass moved in on (docs/ai-cloud-contract.md).
// They are the whole remaining client surface of the feature: the settings routes
// above are the toggles, these are the state and the actions, and there is no
// longer a per-browser runner for either host to have to agree with.
//
// Same session guard as every other AI route, and it is a real guard rather than
// ceremony: the queue, the run history and the accepted taxonomy are all
// account-wide, so an unauthenticated read of any of them is a read of somebody
// else's library.

// One read for the whole Settings → AI status surface, so the panel cannot render
// a half-updated state stitched from three endpoints — and `available` in it is the
// same `aiAvailability().classify` the classify route's 503 is built from, so the
// panel's dot and the route can never disagree.
app.get("/api/ai/status", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  return c.json(await readAiStatus(pool, session.user.id));
});

// Enqueues and wakes the worker; it does not run a pass inline. 25 classify calls
// take tens of seconds, and so do 25 summarisation calls, which is not something
// to hold an HTTP request open for — so the response carries both queue depths
// and a status the client re-reads as the work drains.
//
// One route for both features, because the work is the same shape and two buttons
// would be two nearly identical controls. Each half is gated on its own toggle
// *inside its own enqueue*, which is why an account with only one of them on gets
// a real number for that one and a zero for the other rather than a lie.
app.post("/api/ai/run", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const { queued } = await requestClassificationRun(pool, session.user.id);
  const { queued: summariesQueued } = await requestSummaryRun(pool, session.user.id);
  return c.json({ queued, summariesQueued, status: await readAiStatus(pool, session.user.id) });
});

app.post("/api/ai/taxonomy/propose", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  let body;
  try {
    body = parseTaxonomyProposeBody(await c.req.json());
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
  }
  // 503 for the same reason the classify route has one, and checked the same way:
  // the client has to be able to tell "this server cannot do that" from "the model
  // had nothing to say", or an unconfigured deployment renders as a broken
  // feature. The typed error is caught as well, which is what keeps the invariant
  // if the key is unset between this check and the call.
  if (!aiAvailability().proposeTaxonomy) {
    return c.json({ error: "AI taxonomy proposal is not configured" }, 503);
  }
  try {
    return c.json(await proposeTaxonomyForUser(pool, session.user.id, body.language));
  } catch (error) {
    if (error instanceof ProposerUnavailableError) {
      return c.json({ error: "AI taxonomy proposal is not configured" }, 503);
    }
    throw error;
  }
});

app.put("/api/ai/taxonomy", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  let body;
  try {
    body = parseTaxonomyAcceptance(await c.req.json());
  } catch (error) {
    // 400 for a name that is not a name. The review list tells the user exactly
    // what is about to be created, so quietly dropping one of the names they
    // ticked would be the worst available answer.
    return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
  }
  return c.json(await acceptTaxonomyForUser(pool, session.user.id, body.collections, body.tags));
});

app.post("/api/search", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  let request;
  try {
    request = parseSearchRequest(await c.req.json());
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
  }
  // Never a 503 for a missing index, unlike the classify route. An unconfigured
  // index is a 200 carrying `{ results: [], reason: "unconfigured" }`, because
  // that is the one thing the client can act on: it keeps its local substring
  // pass. A 503 would throw away a well-formed response to say what a 200 with
  // an empty array already said.
  return c.json(
    await searchBookmarks(pool, session.user.id, request, {
      // One embedding per search, and a failure here is not the search's
      // failure: searchBookmarks degrades to lexical-only with `reason:
      // "no-vector"`, which is a better answer than an error.
      embedQuery: async (text: string) => (await embedTexts([text])).vectors[0]?.vector ?? null,
    }),
  );
});

// `POST /api/summarize` was removed with the pass that made it pointless. It
// computed summaries and returned them for a caller that had to write them itself,
// and its documented contract was "the server does not write `summary` anywhere,
// and that is the design" — which is false now that `ai-summary.ts` writes it
// through the shared conflict-safe path. A route that computes a summary and
// silently discards it is a trap for the next reader, and there was no caller in
// either host to preserve. `summarizeRecords` stays; the worker calls it.
// (docs/ai-summarize-contract.md, "POST /api/summarize — removed".)

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: "Internal server error" }, 500);
});

const port = Number(process.env.PORT || 3000);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
console.log(`Nook API listening on ${port}`);

// -- embedding index upkeep -----------------------------------------------

/**
 * The sync hook is a queue, and a queue loses work: a service worker restart, a
 * deploy, or a model change all leave rows that nothing will ever revisit. This
 * is the backstop that makes the index eventually correct rather than eventually
 * stale, and it is why the client needed no code to get an index at all — the
 * server already sees every bookmark through `/api/sync`.
 *
 * Reconciling needs a user id, so it selects them. A signed-out account with no
 * bookmarks costs one indexed scan and finds nothing, which is the cheap case.
 */
const RECONCILE_INTERVAL_MS = 15 * 60_000;

async function reconcileEveryUser(): Promise<void> {
  try {
    const users = await pool.query<{ id: string }>(`SELECT id FROM "user"`);
    for (const user of users.rows) {
      await reconcileIndex(pool, user.id);
    }
  } catch (error) {
    // Never crash the process over a background pass. The next tick retries, and
    // a permanently broken reconcile is visible in the logs, not in a dead API.
    console.error("[ai] index reconciliation failed:", error);
  }
}

// Not immediately: the container may still be applying schema.sql, and a
// reconcile that reads before `nook_embeddings` exists just logs a failure.
setTimeout(() => void reconcileEveryUser(), 30_000);
setInterval(() => void reconcileEveryUser(), RECONCILE_INTERVAL_MS);

// -- AI upkeep ------------------------------------------------------------

// The AI worker's clock, and it is the same relationship the reconcile timer above
// has with the index: a queue with no clock is a queue that only ever drains when
// something else happens to wake it. Once a minute, because a pass is 25 requests
// at concurrency 4 and the extension's 5-minute alarm was twelve times slower for
// no reason other than an MV3 service worker's sleep schedule.
//
// The tick is per-minute where the reconciler is per-15-minutes because they are
// different jobs: the reconciler only has to make an index eventually correct, while
// the queue is what a user is watching drain. `startAiWorker` owns the
// scheduling, and it never throws out of a tick — see apps/api/src/ai-jobs.ts.
startAiWorker(pool);

