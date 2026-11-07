import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import argon2 from "argon2";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { calculateTeamEloDeltas, getSetWinner, validScoreSet, type ScoreSet, type SetKind, type Team } from "./domain.js";

const requiredEnv = ["DATABASE_URL", "SESSION_SECRET"] as const;
for (const key of requiredEnv) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}
if (Buffer.byteLength(process.env.SESSION_SECRET!, "utf8") < 32) {
  throw new Error("SESSION_SECRET must contain at least 32 bytes. Generate it with: openssl rand -base64 48");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "disable"
    ? false
    : { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" },
  max: Number(process.env.DB_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 15_000,
});

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const SESSION_COOKIE = "padel.sid";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const SESSION_SECRET = process.env.SESSION_SECRET!;
const isProduction = process.env.NODE_ENV === "production";
if (process.env.APP_INVITE_CODE && Buffer.byteLength(process.env.APP_INVITE_CODE, "utf8") < 16) {
  throw new Error("APP_INVITE_CODE must contain at least 16 bytes.");
}

if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "data:"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      upgradeInsecureRequests: isProduction ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: "32kb", strict: true }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Забагато спроб. Спробуй ще раз через 15 хвилин." },
});
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

// -----------------------------------------------------------------------------
// Types, errors, validation
// -----------------------------------------------------------------------------

type Role = "admin" | "player";
type MatchFormat = "sets" | "americano";

type EloPlayer = {
  player_id: string;
  team: Team;
  elo_rating: number;
};

type AuthPlayer = {
  id: string;
  displayName: string;
  email: string;
  role: Role;
  eloRating: number;
};

type SessionContext = {
  sessionHash: string;
  csrfToken: string;
};

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPlayer;
      sessionContext?: SessionContext;
    }
  }
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join(". ");
    throw new HttpError(400, message || "Некоректні дані запиту.");
  }
  return parsed.data;
}

function parseParam<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "Некоректний параметр запиту.");
  return parsed.data;
}

function requireAuth(req: Request): AuthPlayer {
  if (!req.auth) throw new HttpError(401, "Потрібно увійти в акаунт.");
  return req.auth;
}

function requireAdmin(req: Request): AuthPlayer {
  const user = requireAuth(req);
  if (user.role !== "admin") throw new HttpError(403, "Ця дія доступна лише адміністратору.");
  return user;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const emailSchema = z.string().trim().toLowerCase().email("Вкажи коректну email-адресу.").max(254);
const passwordSchema = z.string()
  .min(12, "Пароль має містити щонайменше 12 символів.")
  .max(128, "Пароль не може бути довшим за 128 символів.");
const displayNameSchema = z.string().trim().min(2, "Ім'я має містити щонайменше 2 символи.").max(60);
const idSchema = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9-]+$/, "Некоректний ідентифікатор.");
const matchIdSchema = z.string().regex(/^\d+$/, "Некоректний ID матчу.");

// -----------------------------------------------------------------------------
// Opaque database-backed sessions + synchronizer CSRF token
// -----------------------------------------------------------------------------

function sha256(value: string): string {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); }
      catch { return null; }
    }
  }
  return null;
}

function setSessionCookie(res: Response, token: string): void {
  const secure = isProduction ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`,
  );
}

function clearSessionCookie(res: Response): void {
  const secure = isProduction ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

async function createSession(res: Response, playerId: string | null): Promise<SessionContext> {
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const sessionHash = sha256(rawToken);
  const csrfToken = crypto.randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO web_sessions (session_hash, player_id, csrf_token, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 second'))`,
    [sessionHash, playerId, csrfToken, SESSION_TTL_SECONDS],
  );
  setSessionCookie(res, rawToken);
  return { sessionHash, csrfToken };
}

async function sessionMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rawToken = getCookie(req, SESSION_COOKIE);
    if (rawToken && rawToken.length >= 40 && rawToken.length <= 100) {
      const sessionHash = sha256(rawToken);
      const result = await pool.query(
        `SELECT s.session_hash, s.csrf_token,
                p.id, p.display_name, p.email, p.role, p.elo_rating, p.is_active
         FROM web_sessions s
         LEFT JOIN players p ON p.id = s.player_id
         WHERE s.session_hash = $1 AND s.expires_at > NOW()`,
        [sessionHash],
      );
      const row = result.rows[0];
      if (row) {
        if (row.id && row.is_active === false) {
          await pool.query("DELETE FROM web_sessions WHERE session_hash = $1", [sessionHash]);
          clearSessionCookie(res);
        } else {
          req.sessionContext = { sessionHash: row.session_hash, csrfToken: row.csrf_token };
          if (row.id) {
            req.auth = {
              id: row.id,
              displayName: row.display_name,
              email: row.email,
              role: row.role,
              eloRating: Number(row.elo_rating),
            };
          }
          next();
          return;
        }
      }
    }

    const anonymousSession = await createSession(res, null);
    req.sessionContext = anonymousSession;
    next();
  } catch (error) {
    next(error);
  }
}

function csrfMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  const session = req.sessionContext;
  const suppliedToken = req.header("x-csrf-token") ?? "";
  if (!session || !safeEqual(suppliedToken, session.csrfToken)) {
    return next(new HttpError(403, "CSRF-перевірка не пройдена. Онови сторінку та повтори дію."));
  }

  const origin = req.header("origin");
  if (origin) {
    try {
      const suppliedOrigin = new URL(origin).origin;
      const expectedOrigin = `${req.protocol}://${req.get("host")}`;
      if (suppliedOrigin !== expectedOrigin) {
        return next(new HttpError(403, "Запит з іншого домену відхилено."));
      }
    } catch {
      return next(new HttpError(403, "Некоректний Origin заголовок."));
    }
  }
  next();
}

app.get("/api/health", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true, service: "padel-tracker-web" });
});

app.use("/api", sessionMiddleware, csrfMiddleware, writeLimiter);

// -----------------------------------------------------------------------------
// Shared business rules
// -----------------------------------------------------------------------------

async function assertMatchAccess(
  client: PoolClient,
  matchId: string,
  user: AuthPlayer,
): Promise<{ id: string; status: string; match_format: MatchFormat; created_by: string }> {
  const result = await client.query(
    `SELECT m.id::text, m.status, m.match_format, m.created_by,
            EXISTS (
              SELECT 1 FROM match_players mp
              WHERE mp.match_id = m.id AND mp.player_id = $2
            ) AS is_player
     FROM matches m
     WHERE m.id = $1
     FOR UPDATE`,
    [matchId, user.id],
  );
  const match = result.rows[0];
  if (!match) throw new HttpError(404, "Матч не знайдено.");
  if (match.status !== "in_progress") throw new HttpError(409, "Цей матч уже завершено.");
  if (user.role !== "admin" && match.created_by !== user.id && !match.is_player) {
    throw new HttpError(403, "Ти не маєш доступу до цього матчу.");
  }
  return match;
}

async function updateMatchElo(
  client: PoolClient,
  matchId: string,
  winner: Team | null,
): Promise<void> {
  const result = await client.query(
    `SELECT mp.player_id::text AS player_id, mp.team, p.elo_rating
     FROM match_players mp
     JOIN players p ON p.id = mp.player_id
     WHERE mp.match_id = $1
     ORDER BY mp.team, mp.player_id
     FOR UPDATE OF p`,
    [matchId],
  );
  const players = result.rows as EloPlayer[];
  const teamA = players.filter((player) => player.team === "A");
  const teamB = players.filter((player) => player.team === "B");
  if (teamA.length !== 2 || teamB.length !== 2 || players.length !== 4) {
    throw new HttpError(409, "Для ELO потрібні дві команди по двоє активних гравців.");
  }

  const averageA = teamA.reduce((sum, player) => sum + Number(player.elo_rating), 0) / 2;
  const averageB = teamB.reduce((sum, player) => sum + Number(player.elo_rating), 0) / 2;
  const { deltaA, deltaB } = calculateTeamEloDeltas(averageA, averageB, winner, 32);

  for (const player of players) {
    const delta = player.team === "A" ? deltaA : deltaB;
    await client.query(
      `UPDATE match_players SET elo_before = $3, elo_change = $4
       WHERE match_id = $1 AND player_id = $2`,
      [matchId, player.player_id, player.elo_rating, delta],
    );
    await client.query(
      `UPDATE players SET elo_rating = elo_rating + $2, updated_at = NOW()
       WHERE id = $1`,
      [player.player_id, delta],
    );
  }
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const matchSelect = `
  SELECT
    m.id::text AS id,
    m.status,
    m.match_format AS format,
    m.winner_team AS "winnerTeam",
    m.created_by AS "createdById",
    m.created_at AS "createdAt",
    m.played_at AS "playedAt",
    COALESCE(m.americano_score_a, 0)::int AS "scoreA",
    COALESCE(m.americano_score_b, 0)::int AS "scoreB",
    COALESCE(m.americano_target, 24)::int AS target,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id,
        'displayName', p.display_name,
        'team', mp.team,
        'eloBefore', mp.elo_before,
        'eloChange', mp.elo_change
      ) ORDER BY mp.team, p.display_name)
      FROM match_players mp JOIN players p ON p.id = mp.player_id
      WHERE mp.match_id = m.id
    ), '[]'::jsonb) AS players,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'setNumber', ms.set_number,
        'a', ms.score_a,
        'b', ms.score_b,
        'kind', COALESCE(ms.kind, 'set')
      ) ORDER BY ms.set_number)
      FROM match_sets ms WHERE ms.match_id = m.id
    ), '[]'::jsonb) AS sets
  FROM matches m
`;

type MatchRow = {
  id: string;
  status: string;
  format: MatchFormat;
  winnerTeam: Team | null;
  createdById: string;
  createdAt: Date;
  playedAt: Date | null;
  scoreA: number;
  scoreB: number;
  target: number;
  players: Array<{ id: string; displayName: string; team: Team; eloBefore: number | null; eloChange: number | null }>;
  sets: Array<{ setNumber: number; a: number; b: number; kind: SetKind }>;
};

function serializeMatch(row: MatchRow, user: AuthPlayer) {
  const isPlayer = row.players.some((player) => player.id === user.id);
  return {
    id: row.id,
    status: row.status,
    format: row.format,
    winnerTeam: row.winnerTeam,
    createdById: row.createdById,
    createdAt: row.createdAt,
    playedAt: row.playedAt,
    scoreA: Number(row.scoreA),
    scoreB: Number(row.scoreB),
    target: Number(row.target),
    players: row.players,
    teams: {
      A: row.players.filter((player) => player.team === "A"),
      B: row.players.filter((player) => player.team === "B"),
    },
    sets: row.sets,
    canManage: user.role === "admin" || row.createdById === user.id || isPlayer,
    canDelete: user.role === "admin" || row.createdById === user.id,
  };
}

async function getMatchRow(matchId: string): Promise<MatchRow | null> {
  const result = await pool.query(`${matchSelect} WHERE m.id = $1`, [matchId]);
  return (result.rows[0] as MatchRow | undefined) ?? null;
}

async function listMatchRows(status?: string): Promise<MatchRow[]> {
  const values: unknown[] = [];
  const where = status ? "WHERE m.status = $1" : "";
  if (status) values.push(status);
  const result = await pool.query(
    `${matchSelect} ${where} ORDER BY COALESCE(m.played_at, m.created_at) DESC, m.id DESC LIMIT 100`,
    values,
  );
  return result.rows as MatchRow[];
}

// -----------------------------------------------------------------------------
// Authentication and account endpoints
// -----------------------------------------------------------------------------

app.get("/api/auth/csrf", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ csrfToken: req.sessionContext?.csrfToken });
});

app.get("/api/auth/me", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ user: req.auth ?? null });
});

app.post("/api/auth/register", authLimiter, async (req, res) => {
  const inviteCode = process.env.APP_INVITE_CODE;
  if (!inviteCode) throw new HttpError(403, "Реєстрацію вимкнено. Попроси адміністратора створити акаунт.");

  const body = parseBody(z.object({
    email: emailSchema,
    password: passwordSchema,
    displayName: displayNameSchema,
    inviteCode: z.string().min(1).max(200),
  }), req.body);
  if (!safeEqual(body.inviteCode, inviteCode)) throw new HttpError(403, "Неправильний invite-код.");

  const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
  const id = crypto.randomUUID();
  const result = await pool.query(
    `INSERT INTO players (id, display_name, email, password_hash, role, is_active, elo_rating, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'player', true, 1000, NOW(), NOW())
     RETURNING id, display_name, email, role, elo_rating`,
    [id, body.displayName, body.email, passwordHash],
  );
  const row = result.rows[0];
  const oldHash = req.sessionContext?.sessionHash;
  if (oldHash) await pool.query("DELETE FROM web_sessions WHERE session_hash = $1", [oldHash]);
  await createSession(res, row.id);
  res.status(201).json({
    user: { id: row.id, displayName: row.display_name, email: row.email, role: row.role, eloRating: row.elo_rating },
  });
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const body = parseBody(z.object({ email: emailSchema, password: z.string().min(1).max(128) }), req.body);
  const result = await pool.query(
    `SELECT id, display_name, email, password_hash, role, elo_rating, is_active
     FROM players WHERE lower(email) = $1 LIMIT 1`,
    [body.email],
  );
  const row = result.rows[0];
  const valid = row?.password_hash
    ? await argon2.verify(row.password_hash, body.password).catch(() => false)
    : false;
  if (!row || !valid || !row.is_active) throw new HttpError(401, "Неправильний email або пароль.");

  const oldHash = req.sessionContext?.sessionHash;
  if (oldHash) await pool.query("DELETE FROM web_sessions WHERE session_hash = $1", [oldHash]);
  await createSession(res, row.id); // Rotate the anonymous session after authentication.
  res.json({ user: { id: row.id, displayName: row.display_name, email: row.email, role: row.role, eloRating: row.elo_rating } });
});

app.post("/api/auth/logout", async (req, res) => {
  const oldHash = req.sessionContext?.sessionHash;
  if (oldHash) await pool.query("DELETE FROM web_sessions WHERE session_hash = $1", [oldHash]);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.patch("/api/auth/profile", async (req, res) => {
  const user = requireAuth(req);
  const body = parseBody(z.object({
    displayName: displayNameSchema,
    email: emailSchema,
  }), req.body);
  const result = await pool.query(
    `UPDATE players SET display_name = $2, email = $3, updated_at = NOW()
     WHERE id = $1 AND is_active = true
     RETURNING id, display_name, email, role, elo_rating`,
    [user.id, body.displayName, body.email],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, "Профіль не знайдено.");
  res.json({ user: { id: row.id, displayName: row.display_name, email: row.email, role: row.role, eloRating: row.elo_rating } });
});

app.post("/api/auth/change-password", async (req, res) => {
  const user = requireAuth(req);
  const body = parseBody(z.object({
    currentPassword: z.string().min(1).max(128),
    newPassword: passwordSchema,
  }), req.body);
  const result = await pool.query("SELECT password_hash FROM players WHERE id = $1", [user.id]);
  const valid = result.rows[0]?.password_hash
    ? await argon2.verify(result.rows[0].password_hash, body.currentPassword).catch(() => false)
    : false;
  if (!valid) throw new HttpError(401, "Поточний пароль неправильний.");
  const hash = await argon2.hash(body.newPassword, { type: argon2.argon2id });
  await pool.query("UPDATE players SET password_hash = $2, updated_at = NOW() WHERE id = $1", [user.id, hash]);
  await pool.query("DELETE FROM web_sessions WHERE player_id = $1", [user.id]);
  await createSession(res, user.id);
  res.json({ ok: true });
});

// -----------------------------------------------------------------------------
// Players, admin tools, ranking and statistics
// -----------------------------------------------------------------------------

app.get("/api/players", async (req, res) => {
  requireAuth(req);
  const result = await pool.query(
    `SELECT id, display_name AS "displayName", elo_rating AS "eloRating",
            role, is_active AS "isActive",
            (email IS NOT NULL AND password_hash IS NOT NULL) AS "hasAccount"
     FROM players WHERE is_active = true
     ORDER BY lower(display_name), id`,
  );
  res.json({ players: result.rows });
});

app.post("/api/players", async (req, res) => {
  requireAdmin(req);
  const body = parseBody(z.object({ displayName: displayNameSchema }), req.body);
  const id = crypto.randomUUID();
  const result = await pool.query(
    `INSERT INTO players (id, display_name, role, is_active, elo_rating, created_at, updated_at)
     VALUES ($1, $2, 'player', true, 1000, NOW(), NOW())
     RETURNING id, display_name AS "displayName", elo_rating AS "eloRating", role`,
    [id, body.displayName],
  );
  res.status(201).json({ player: result.rows[0] });
});

app.post("/api/players/:id/account", async (req, res) => {
  requireAdmin(req);
  const id = parseParam(idSchema, req.params.id);
  const body = parseBody(z.object({ email: emailSchema, password: passwordSchema }), req.body);
  const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
  const result = await pool.query(
    `UPDATE players SET email = $2, password_hash = $3, updated_at = NOW()
     WHERE id = $1 AND is_active = true
     RETURNING id, display_name AS "displayName", email`,
    [id, body.email, passwordHash],
  );
  if (!result.rowCount) throw new HttpError(404, "Гравця не знайдено.");
  await pool.query("DELETE FROM web_sessions WHERE player_id = $1", [id]);
  res.json({ player: result.rows[0] });
});

app.post("/api/players/:id/deactivate", async (req, res) => {
  requireAdmin(req);
  const id = parseParam(idSchema, req.params.id);
  if (id === req.auth!.id) throw new HttpError(400, "Не можна деактивувати власний акаунт.");
  const result = await pool.query(
    `UPDATE players SET is_active = false, updated_at = NOW()
     WHERE id = $1 AND role = 'player' RETURNING id`,
    [id],
  );
  if (!result.rowCount) throw new HttpError(404, "Гравця не знайдено або адміністраторський акаунт не можна деактивувати через цей екран.");
  await pool.query("DELETE FROM web_sessions WHERE player_id = $1", [id]);
  res.json({ ok: true });
});

const rankingSql = `
  SELECT
    p.id AS "playerId",
    p.display_name AS "displayName",
    p.elo_rating AS "eloRating",
    COUNT(m.id)::int AS played,
    COUNT(*) FILTER (WHERE m.id IS NOT NULL AND m.winner_team = mp.team)::int AS wins,
    COUNT(*) FILTER (WHERE m.id IS NOT NULL AND m.winner_team IS NULL)::int AS draws,
    COUNT(*) FILTER (WHERE m.id IS NOT NULL AND m.winner_team IS NOT NULL AND m.winner_team <> mp.team)::int AS losses,
    COALESCE(SUM(CASE
      WHEN m.match_format = 'americano' AND mp.team = 'A' THEN m.americano_score_a
      WHEN m.match_format = 'americano' AND mp.team = 'B' THEN m.americano_score_b
      ELSE 0 END), 0)::int AS "americanoPoints"
  FROM players p
  LEFT JOIN match_players mp ON mp.player_id = p.id
  LEFT JOIN matches m ON m.id = mp.match_id AND m.status = 'completed'
  WHERE p.is_active = true
  GROUP BY p.id, p.display_name, p.elo_rating
  ORDER BY p.elo_rating DESC, wins DESC, "americanoPoints" DESC, p.display_name ASC
  LIMIT 100
`;

app.get("/api/ranking", async (req, res) => {
  requireAuth(req);
  const result = await pool.query(rankingSql);
  res.json({ ranking: result.rows.map((row, index) => ({ ...row, position: index + 1 })) });
});

async function getPlayerStats(playerId: string) {
  const result = await pool.query(
    `SELECT
       COUNT(*)::int AS played,
       COUNT(*) FILTER (WHERE m.winner_team = mp.team)::int AS wins,
       COUNT(*) FILTER (WHERE m.winner_team IS NULL)::int AS draws,
       COUNT(*) FILTER (WHERE m.winner_team IS NOT NULL AND m.winner_team <> mp.team)::int AS losses,
       COALESCE(SUM(CASE
         WHEN m.match_format = 'americano' AND mp.team = 'A' THEN m.americano_score_a
         WHEN m.match_format = 'americano' AND mp.team = 'B' THEN m.americano_score_b
         ELSE 0 END), 0)::int AS americano_points,
       COALESCE(SUM(mp.elo_change), 0)::int AS elo_change
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     WHERE mp.player_id = $1 AND m.status = 'completed'`,
    [playerId],
  );
  const row = result.rows[0];
  const played = Number(row.played);
  const wins = Number(row.wins);
  return {
    played,
    wins,
    draws: Number(row.draws),
    losses: Number(row.losses),
    winRate: played ? Math.round((wins / played) * 100) : 0,
    americanoPoints: Number(row.americano_points),
    eloChange: Number(row.elo_change),
  };
}

app.get("/api/stats/me", async (req, res) => {
  const user = requireAuth(req);
  const stats = await getPlayerStats(user.id);
  res.json({ stats });
});

app.get("/api/players/:id/stats", async (req, res) => {
  requireAuth(req);
  const id = parseParam(idSchema, req.params.id);
  const playerResult = await pool.query(
    "SELECT id, display_name AS \"displayName\", elo_rating AS \"eloRating\" FROM players WHERE id = $1 AND is_active = true",
    [id],
  );
  if (!playerResult.rowCount) throw new HttpError(404, "Гравця не знайдено.");
  res.json({ player: playerResult.rows[0], stats: await getPlayerStats(id) });
});

// -----------------------------------------------------------------------------
// Matches and score entry
// -----------------------------------------------------------------------------

app.get("/api/matches", async (req, res) => {
  const user = requireAuth(req);
  const statusParam = req.query.status;
  const status = typeof statusParam === "string" ? statusParam : undefined;
  if (status && !["in_progress", "completed"].includes(status)) {
    throw new HttpError(400, "Неправильний фільтр статусу.");
  }
  const rows = await listMatchRows(status);
  res.json({ matches: rows.map((row) => serializeMatch(row, user)) });
});

app.get("/api/matches/:id", async (req, res) => {
  const user = requireAuth(req);
  const id = parseParam(matchIdSchema, req.params.id);
  const row = await getMatchRow(id);
  if (!row) throw new HttpError(404, "Матч не знайдено.");
  res.json({ match: serializeMatch(row, user) });
});

app.post("/api/matches", async (req, res) => {
  const user = requireAuth(req);
  const body = parseBody(z.object({
    playerIds: z.array(idSchema).length(4),
    teamAIds: z.array(idSchema).length(2),
    format: z.enum(["sets", "americano"]).default("sets"),
  }), req.body);

  if (new Set(body.playerIds).size !== 4 || new Set(body.teamAIds).size !== 2) {
    throw new HttpError(400, "Гравці не можуть повторюватися.");
  }
  if (!body.teamAIds.every((id) => body.playerIds.includes(id))) {
    throw new HttpError(400, "Команда A може містити лише вибраних гравців.");
  }

  const createdId = await inTransaction(async (client) => {
    const players = await client.query(
      "SELECT id FROM players WHERE id = ANY($1::text[]) AND is_active = true FOR SHARE",
      [body.playerIds],
    );
    if (players.rowCount !== 4) throw new HttpError(400, "Один або декілька гравців не знайдені чи деактивовані.");

    const matchResult = await client.query(
      `INSERT INTO matches (created_by, status, match_format, score_state, americano_score_a, americano_score_b, americano_target, created_at)
       VALUES ($1, 'in_progress', $2, '{"sets":[],"mode":null,"pendingA":null,"pendingB":null,"step":"mode"}'::jsonb, 0, 0, 24, NOW())
       RETURNING id::text`,
      [user.id, body.format],
    );
    const matchId = matchResult.rows[0].id as string;

    for (const playerId of body.playerIds) {
      await client.query(
        `INSERT INTO match_players (match_id, player_id, team)
         VALUES ($1, $2, $3)`,
        [matchId, playerId, body.teamAIds.includes(playerId) ? "A" : "B"],
      );
    }
    return matchId;
  });
  const row = await getMatchRow(createdId);
  res.status(201).json({ match: serializeMatch(row!, user) });
});

app.post("/api/matches/:id/sets", async (req, res) => {
  const user = requireAuth(req);
  const matchId = parseParam(matchIdSchema, req.params.id);
  const body = parseBody(z.object({
    a: z.number().int().min(0).max(99),
    b: z.number().int().min(0).max(99),
    kind: z.enum(["set", "tb"]),
  }), req.body);

  await inTransaction(async (client) => {
    const match = await assertMatchAccess(client, matchId, user);
    if (match.match_format !== "sets") throw new HttpError(409, "Цей матч має формат Americano.");
    const currentResult = await client.query(
      "SELECT set_number, score_a, score_b, kind FROM match_sets WHERE match_id = $1 ORDER BY set_number",
      [matchId],
    );
    const currentSets = currentResult.rows.map((row) => ({
      setNumber: Number(row.set_number), a: Number(row.score_a), b: Number(row.score_b), kind: (row.kind ?? "set") as SetKind,
    }));
    if (currentSets.length >= 3) throw new HttpError(409, "У матчі вже внесено три сети.");
    if (getSetWinner(currentSets)) throw new HttpError(409, "Матч уже має переможця.");
    if (body.kind === "tb" && currentSets.length !== 2) {
      throw new HttpError(400, "Супер тай-брейк можна вводити лише як третій, вирішальний сет.");
    }
    if (!validScoreSet(body)) {
      throw new HttpError(400, body.kind === "set"
        ? "Невірний рахунок. Приклади звичайного сету: 6–0…6–4, 7–5 або 7–6."
        : "Супер тай-брейк: перемога від 10 очок із перевагою щонайменше 2.");
    }

    const setNumber = currentSets.length + 1;
    await client.query(
      `INSERT INTO match_sets (match_id, set_number, score_a, score_b, kind)
       VALUES ($1, $2, $3, $4, $5)`,
      [matchId, setNumber, body.a, body.b, body.kind],
    );
    const allSets: ScoreSet[] = [...currentSets, body];
    const winner = getSetWinner(allSets);
    if (winner) {
      await updateMatchElo(client, matchId, winner);
      await client.query(
        "UPDATE matches SET status = 'completed', winner_team = $2, played_at = NOW() WHERE id = $1",
        [matchId, winner],
      );
    }
  });

  const row = await getMatchRow(matchId);
  res.json({ match: serializeMatch(row!, user) });
});

app.delete("/api/matches/:id/sets/last", async (req, res) => {
  const user = requireAuth(req);
  const matchId = parseParam(matchIdSchema, req.params.id);
  await inTransaction(async (client) => {
    const match = await assertMatchAccess(client, matchId, user);
    if (match.match_format !== "sets") throw new HttpError(409, "Цей матч має формат Americano.");
    const last = await client.query(
      "SELECT set_number FROM match_sets WHERE match_id = $1 ORDER BY set_number DESC LIMIT 1",
      [matchId],
    );
    if (last.rowCount) {
      await client.query("DELETE FROM match_sets WHERE match_id = $1 AND set_number = $2", [matchId, last.rows[0].set_number]);
    }
  });
  const row = await getMatchRow(matchId);
  res.json({ match: serializeMatch(row!, user) });
});

app.post("/api/matches/:id/americano/adjust", async (req, res) => {
  const user = requireAuth(req);
  const matchId = parseParam(matchIdSchema, req.params.id);
  const body = parseBody(z.object({
    team: z.enum(["A", "B"]),
    delta: z.union([z.literal(-5), z.literal(-1), z.literal(1), z.literal(5)]),
  }), req.body);
  await inTransaction(async (client) => {
    const match = await assertMatchAccess(client, matchId, user);
    if (match.match_format !== "americano") throw new HttpError(409, "Цей матч не має формат Americano.");
    const column = body.team === "A" ? "americano_score_a" : "americano_score_b";
    await client.query(
      `UPDATE matches SET ${column} = LEAST(10000, GREATEST(0, COALESCE(${column}, 0) + $2)) WHERE id = $1`,
      [matchId, body.delta],
    );
  });
  const row = await getMatchRow(matchId);
  res.json({ match: serializeMatch(row!, user) });
});

app.post("/api/matches/:id/americano/reset", async (req, res) => {
  const user = requireAuth(req);
  const matchId = parseParam(matchIdSchema, req.params.id);
  await inTransaction(async (client) => {
    const match = await assertMatchAccess(client, matchId, user);
    if (match.match_format !== "americano") throw new HttpError(409, "Цей матч не має формат Americano.");
    await client.query("UPDATE matches SET americano_score_a = 0, americano_score_b = 0 WHERE id = $1", [matchId]);
  });
  const row = await getMatchRow(matchId);
  res.json({ match: serializeMatch(row!, user) });
});

app.post("/api/matches/:id/americano/complete", async (req, res) => {
  const user = requireAuth(req);
  const matchId = parseParam(matchIdSchema, req.params.id);
  await inTransaction(async (client) => {
    const match = await assertMatchAccess(client, matchId, user);
    if (match.match_format !== "americano") throw new HttpError(409, "Цей матч не має формат Americano.");
    const result = await client.query(
      "SELECT COALESCE(americano_score_a, 0)::int AS a, COALESCE(americano_score_b, 0)::int AS b FROM matches WHERE id = $1",
      [matchId],
    );
    const a = Number(result.rows[0].a);
    const b = Number(result.rows[0].b);
    if (a + b === 0) throw new HttpError(400, "Не можна завершити матч із рахунком 0–0.");
    const winner: Team | null = a === b ? null : a > b ? "A" : "B";
    await updateMatchElo(client, matchId, winner);
    await client.query(
      "UPDATE matches SET status = 'completed', winner_team = $2, played_at = NOW() WHERE id = $1",
      [matchId, winner],
    );
  });
  const row = await getMatchRow(matchId);
  res.json({ match: serializeMatch(row!, user) });
});

app.delete("/api/matches/:id", async (req, res) => {
  const user = requireAuth(req);
  const matchId = parseParam(matchIdSchema, req.params.id);
  await inTransaction(async (client) => {
    const result = await client.query(
      "SELECT id::text, status, created_by FROM matches WHERE id = $1 FOR UPDATE",
      [matchId],
    );
    const match = result.rows[0];
    if (!match) throw new HttpError(404, "Матч не знайдено.");
    if (match.status !== "in_progress") throw new HttpError(409, "Завершені матчі не можна видаляти.");
    if (user.role !== "admin" && match.created_by !== user.id) throw new HttpError(403, "Видалити матч може лише його автор або адміністратор.");
    await client.query("DELETE FROM match_sets WHERE match_id = $1", [matchId]);
    await client.query("DELETE FROM match_players WHERE match_id = $1", [matchId]);
    await client.query("DELETE FROM matches WHERE id = $1", [matchId]);
  });
  res.json({ ok: true });
});

// Return JSON for unknown API endpoints instead of Express' default HTML 404.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API endpoint не знайдено." });
});

// -----------------------------------------------------------------------------
// Frontend static hosting and error handling
// -----------------------------------------------------------------------------

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const clientDist = path.resolve(currentDir, "../../dist/client");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, {
    index: false,
    maxAge: isProduction ? "1h" : 0,
    etag: true,
  }));
  app.get(/^(?!\/api\/).*/, (req, res, next) => {
    if (req.method !== "GET") return next();
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  const pgError = error as { code?: string; constraint?: string; message?: string };
  if (pgError?.code === "23505") {
    res.status(409).json({ error: "Такий email або запис уже існує." });
    return;
  }
  if (pgError?.code === "23503") {
    res.status(400).json({ error: "Запис посилається на гравця або матч, якого не існує." });
    return;
  }
  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({ error: "Некоректний JSON у запиті." });
    return;
  }
  console.error("API error:", error);
  res.status(500).json({ error: "Внутрішня помилка сервера." });
});

async function main(): Promise<void> {
  await pool.query("SELECT 1");
  await pool.query("DELETE FROM web_sessions WHERE expires_at < NOW()");
  if (!fs.existsSync(clientDist)) {
    console.log("Frontend build not found; run `npm run build` to serve the website from Express.");
  }
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`🎾 Padel Tracker Web listening on port ${PORT}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`${signal}: shutting down`);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch(async (error) => {
  console.error("Failed to start Padel Tracker Web:", error);
  await pool.end();
  process.exit(1);
});
