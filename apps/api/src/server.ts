import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth, allowedOrigins, allowSignUp, pool } from "./auth.js";
import { parseSyncRequest, syncRecords } from "./sync.js";
import {
  classifyBookmarkOutcome,
  jevAvailable,
  parseClassifyRequest,
  parseProposeTaxonomyRequest,
  proposeTaxonomy,
} from "./ai.js";
import { embedTexts, reconcileIndex } from "./embeddings.js";
import { parseSearchRequest, searchBookmarks } from "./retrieval.js";
import { parseSummarizeRequest, summarizeAvailability, summarizeRecords } from "./summarize.js";

const app = new Hono();

app.use("/api/*", cors({
  origin: (origin) => allowedOrigins.has(origin) ? origin : "",
  allowHeaders: ["Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "OPTIONS"],
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

app.post("/api/summarize", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  let request;
  try {
    request = parseSummarizeRequest(await c.req.json());
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
  }
  // 503, matching the classify route: the panel has to tell "this server has no
  // summariser" from "there was nothing to summarise".
  if (!summarizeAvailability().summarize) {
    return c.json({ error: "AI summarisation is not configured" }, 503);
  }
  return c.json(await summarizeRecords(pool, session.user.id, request.ids));
});

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

