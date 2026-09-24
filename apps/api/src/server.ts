import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth, allowedOrigins, allowSignUp, pool } from "./auth.js";
import { parseSyncRequest, syncRecords } from "./sync.js";

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

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: "Internal server error" }, 500);
});

const port = Number(process.env.PORT || 3000);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
console.log(`Nook API listening on ${port}`);
