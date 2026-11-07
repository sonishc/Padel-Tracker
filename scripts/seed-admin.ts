import "dotenv/config";
import crypto from "node:crypto";
import argon2 from "argon2";
import { Pool } from "pg";

const { DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
const displayName = process.env.ADMIN_NAME?.trim() || "Padel Admin";
if (!DATABASE_URL || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  throw new Error("Set DATABASE_URL, ADMIN_EMAIL and ADMIN_PASSWORD in .env before running seed:admin.");
}
if (Buffer.byteLength(ADMIN_PASSWORD, "utf8") < 12) {
  throw new Error("ADMIN_PASSWORD must contain at least 12 characters.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "disable"
    ? false
    : { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" },
});

try {
  const email = ADMIN_EMAIL.trim().toLowerCase();
  const passwordHash = await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id });
  const existing = await pool.query("SELECT id FROM players WHERE lower(email) = $1 LIMIT 1", [email]);

  if (existing.rowCount) {
    await pool.query(
      `UPDATE players SET password_hash = $2, role = 'admin', is_active = true, updated_at = NOW()
       WHERE id = $1`,
      [existing.rows[0].id, passwordHash],
    );
    console.log(`✅ Existing player ${email} is now an admin account.`);
  } else {
    await pool.query(
      `INSERT INTO players (id, display_name, email, password_hash, role, is_active, elo_rating, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'admin', true, 1000, NOW(), NOW())`,
      [crypto.randomUUID(), displayName, email, passwordHash],
    );
    console.log(`✅ Admin account ${email} created.`);
  }
} catch (error) {
  console.error("❌ Could not create admin:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
