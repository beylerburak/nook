import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
const secret = process.env.BETTER_AUTH_SECRET;
const baseURL = process.env.BETTER_AUTH_URL;

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!secret || secret.length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
if (!baseURL) throw new Error("BETTER_AUTH_URL is required");

export const pool = new Pool({ connectionString: databaseUrl });
export const allowSignUp = process.env.NOOK_ALLOW_SIGNUP === "true";
export const allowedOrigins = new Set(
  [new URL(baseURL).origin, ...(process.env.NOOK_ALLOWED_ORIGINS ?? "").split(",")]
    .map((origin) => origin.trim())
    .filter(Boolean),
);

export const auth = betterAuth({
  baseURL,
  secret,
  database: pool,
  emailAndPassword: { enabled: true, disableSignUp: !allowSignUp },
  // Account deletion (web Settings → Data → Delete account) removes the
  // Better Auth user row; nook_records.user_id has ON DELETE CASCADE
  // (schema.sql), so that user's bookmarks and lists go with it.
  user: { deleteUser: { enabled: true } },
  trustedOrigins: [...allowedOrigins],
  plugins: [bearer()],
});
