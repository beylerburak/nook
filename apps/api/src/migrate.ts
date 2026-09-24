import { readFile } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import { auth, pool } from "./auth.js";

const { runMigrations } = await getMigrations(auth.options);
await runMigrations();
const schema = await readFile(new URL("../src/schema.sql", import.meta.url), "utf8");
await pool.query(schema);
await pool.end();
console.log("Nook database is ready");
