import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_AI_USER_SETTINGS, getAiUserSettings, saveAiUserSettingsPatch } from "../src/ai-settings.js";

// Same convention as sync.integration.test.ts: self-skips unless a throwaway
// Postgres is provided, and never touches the real `nook` database.
const DB_URL = process.env.NOOK_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("ai user settings (integration)", () => {
  const pool = new Pool({ connectionString: DB_URL });

  beforeAll(async () => {
    await pool.query('CREATE TABLE IF NOT EXISTS "user"(id text PRIMARY KEY)');
    const schema = await readFile(new URL("../src/schema.sql", import.meta.url), "utf8");
    await pool.query(schema);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createUser(): Promise<string> {
    const id = randomUUID();
    await pool.query('INSERT INTO "user"(id) VALUES ($1)', [id]);
    return id;
  }

  it("returns the documented defaults for an account that never wrote a row", async () => {
    const userId = await createUser();
    expect(await getAiUserSettings(pool, userId)).toEqual(DEFAULT_AI_USER_SETTINGS);
  });

  it("a patch on a fresh account only sets the fields it touched", async () => {
    const userId = await createUser();
    const saved = await saveAiUserSettingsPatch(pool, userId, { autoClassify: true, maxTags: 5 });
    expect(saved).toEqual({ ...DEFAULT_AI_USER_SETTINGS, autoClassify: true, maxTags: 5 });
    expect(await getAiUserSettings(pool, userId)).toEqual(saved);
  });

  it("a later patch merges onto what is stored, leaving untouched fields alone", async () => {
    const userId = await createUser();
    await saveAiUserSettingsPatch(pool, userId, { autoClassify: true, collectionMinConfidence: 0.9 });
    const second = await saveAiUserSettingsPatch(pool, userId, { autoTaxonomy: true });

    expect(second.autoClassify).toBe(true);
    expect(second.collectionMinConfidence).toBe(0.9);
    expect(second.autoTaxonomy).toBe(true);
  });

  it("one account's settings never leak into another's", async () => {
    const userA = await createUser();
    const userB = await createUser();
    await saveAiUserSettingsPatch(pool, userA, { autoClassify: true });

    expect((await getAiUserSettings(pool, userB)).autoClassify).toBe(false);
  });

  it("deleting the user cascades to their settings row", async () => {
    const userId = await createUser();
    await saveAiUserSettingsPatch(pool, userId, { autoClassify: true });
    await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);

    const result = await pool.query("SELECT 1 FROM nook_ai_settings WHERE user_id = $1", [userId]);
    expect(result.rows).toHaveLength(0);
  });
});
