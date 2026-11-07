import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "disable"
    ? false
    : { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" },
});

try {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = await fs.readFile(path.resolve(here, "../migrations/001_web_app.sql"), "utf8");
  await pool.query(sql);
  console.log("✅ Padel Tracker Web migration applied.");
} catch (error) {
  console.error("❌ Migration failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
