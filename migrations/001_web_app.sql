-- Padel Tracker Web: additive migration from the Telegram-backed schema.
-- IMPORTANT: take a PostgreSQL backup before running this migration.
-- Existing Telegram IDs are preserved as text player IDs; new web players use UUID strings.

BEGIN;

DO $$
DECLARE
  constraint_row RECORD;
BEGIN
  IF to_regclass('public.players') IS NULL
     OR to_regclass('public.matches') IS NULL
     OR to_regclass('public.match_players') IS NULL
     OR to_regclass('public.match_sets') IS NULL THEN
    RAISE EXCEPTION 'Expected legacy tables players, matches, match_players and match_sets. Create the original Padel Tracker schema first.';
  END IF;

  -- Drop foreign keys that depend on the legacy Telegram identifier before
  -- changing its type. They are recreated against the renamed text ID below.
  FOR constraint_row IN
    SELECT conrelid::regclass AS table_name, conname
    FROM pg_constraint
    WHERE contype = 'f'
      AND confrelid = 'public.players'::regclass
      AND conrelid IN ('public.match_players'::regclass, 'public.matches'::regclass)
  LOOP
    EXECUTE format(
      'ALTER TABLE %s DROP CONSTRAINT %I',
      constraint_row.table_name,
      constraint_row.conname
    );
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'players' AND column_name = 'telegram_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'players' AND column_name = 'id'
  ) THEN
    ALTER TABLE public.players RENAME COLUMN telegram_id TO id;
  END IF;
END $$;

-- Keep legacy numeric IDs as text, while allowing UUID IDs for newly created web players.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'players' AND column_name = 'id') <> 'text' THEN
    ALTER TABLE public.players ALTER COLUMN id DROP DEFAULT;
    ALTER TABLE public.players ALTER COLUMN id TYPE text USING id::text;
  END IF;
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'match_players' AND column_name = 'player_id') <> 'text' THEN
    ALTER TABLE public.match_players ALTER COLUMN player_id DROP DEFAULT;
    ALTER TABLE public.match_players ALTER COLUMN player_id TYPE text USING player_id::text;
  END IF;
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'matches' AND column_name = 'created_by') <> 'text' THEN
    ALTER TABLE public.matches ALTER COLUMN created_by DROP DEFAULT;
    ALTER TABLE public.matches ALTER COLUMN created_by TYPE text USING created_by::text;
  END IF;
END $$;

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS password_hash text,
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'player',
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS elo_rating integer NOT NULL DEFAULT 1000;

UPDATE public.players SET role = 'player' WHERE role IS NULL;
UPDATE public.players SET is_active = true WHERE is_active IS NULL;
UPDATE public.players SET elo_rating = 1000 WHERE elo_rating IS NULL;
UPDATE public.players SET display_name = 'Player' WHERE display_name IS NULL OR btrim(display_name) = '';

ALTER TABLE public.players
  ALTER COLUMN role SET DEFAULT 'player',
  ALTER COLUMN role SET NOT NULL,
  ALTER COLUMN is_active SET DEFAULT true,
  ALTER COLUMN is_active SET NOT NULL,
  ALTER COLUMN elo_rating SET DEFAULT 1000,
  ALTER COLUMN elo_rating SET NOT NULL;

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS match_format text NOT NULL DEFAULT 'sets',
  ADD COLUMN IF NOT EXISTS score_state jsonb NOT NULL DEFAULT '{"sets":[],"mode":null,"pendingA":null,"pendingB":null,"step":"mode"}'::jsonb,
  ADD COLUMN IF NOT EXISTS americano_score_a integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS americano_score_b integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS americano_target integer NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS winner_team text,
  ADD COLUMN IF NOT EXISTS played_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

UPDATE public.matches SET match_format = 'sets' WHERE match_format IS NULL;
UPDATE public.matches SET status = 'in_progress' WHERE status IS NULL;
UPDATE public.matches SET created_at = COALESCE(played_at, created_at, now());

ALTER TABLE public.matches
  ALTER COLUMN match_format SET DEFAULT 'sets',
  ALTER COLUMN match_format SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'in_progress',
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN americano_score_a SET DEFAULT 0,
  ALTER COLUMN americano_score_a SET NOT NULL,
  ALTER COLUMN americano_score_b SET DEFAULT 0,
  ALTER COLUMN americano_score_b SET NOT NULL,
  ALTER COLUMN americano_target SET DEFAULT 24,
  ALTER COLUMN americano_target SET NOT NULL;

ALTER TABLE public.match_players
  ADD COLUMN IF NOT EXISTS elo_before integer,
  ADD COLUMN IF NOT EXISTS elo_change integer;

ALTER TABLE public.match_sets
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'set';

-- The Telegram version did not persist the set kind in match_sets. Older
-- super tie-breaks can be reliably identified by a score of at least 10.
UPDATE public.match_sets SET kind = 'tb'
WHERE kind = 'set' AND (score_a >= 10 OR score_b >= 10);

-- Backfill in-progress sets that were previously kept only in matches.score_state.
-- Already-persisted match_sets are left untouched.
INSERT INTO public.match_sets (match_id, set_number, score_a, score_b, kind)
SELECT
  m.id,
  item.ordinality::integer,
  (item.value ->> 'a')::integer,
  (item.value ->> 'b')::integer,
  COALESCE(item.value ->> 'kind', 'set')
FROM public.matches m
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof(m.score_state -> 'sets') = 'array' THEN m.score_state -> 'sets'
    ELSE '[]'::jsonb
  END
) WITH ORDINALITY AS item(value, ordinality)
WHERE NOT EXISTS (
  SELECT 1 FROM public.match_sets existing WHERE existing.match_id = m.id
)
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS players_id_web_unique ON public.players(id);

-- Ensure the new FK relationships exist. NOT VALID preserves historical orphaned
-- records if any exist, while enforcing the relationship for all new writes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'match_players_player_id_web_fk'
  ) THEN
    ALTER TABLE public.match_players
      ADD CONSTRAINT match_players_player_id_web_fk
      FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'matches_created_by_web_fk'
  ) THEN
    ALTER TABLE public.matches
      ADD CONSTRAINT matches_created_by_web_fk
      FOREIGN KEY (created_by) REFERENCES public.players(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;

-- Defense-in-depth checks for new writes. NOT VALID keeps legacy rows intact;
-- new and changed rows must satisfy these constraints.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'players_role_web_check' AND conrelid = 'public.players'::regclass) THEN
    ALTER TABLE public.players ADD CONSTRAINT players_role_web_check
      CHECK (role IN ('admin', 'player')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matches_status_web_check' AND conrelid = 'public.matches'::regclass) THEN
    ALTER TABLE public.matches ADD CONSTRAINT matches_status_web_check
      CHECK (status IN ('in_progress', 'completed')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matches_format_web_check' AND conrelid = 'public.matches'::regclass) THEN
    ALTER TABLE public.matches ADD CONSTRAINT matches_format_web_check
      CHECK (match_format IN ('sets', 'americano')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matches_winner_web_check' AND conrelid = 'public.matches'::regclass) THEN
    ALTER TABLE public.matches ADD CONSTRAINT matches_winner_web_check
      CHECK (winner_team IS NULL OR winner_team IN ('A', 'B')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'match_players_team_web_check' AND conrelid = 'public.match_players'::regclass) THEN
    ALTER TABLE public.match_players ADD CONSTRAINT match_players_team_web_check
      CHECK (team IN ('A', 'B')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'match_sets_kind_web_check' AND conrelid = 'public.match_sets'::regclass) THEN
    ALTER TABLE public.match_sets ADD CONSTRAINT match_sets_kind_web_check
      CHECK (kind IN ('set', 'tb')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matches_americano_nonnegative_web_check' AND conrelid = 'public.matches'::regclass) THEN
    ALTER TABLE public.matches ADD CONSTRAINT matches_americano_nonnegative_web_check
      CHECK (americano_score_a >= 0 AND americano_score_b >= 0 AND americano_target > 0) NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS players_email_lower_unique
  ON public.players (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS match_players_match_player_unique
  ON public.match_players(match_id, player_id);
CREATE UNIQUE INDEX IF NOT EXISTS match_sets_match_set_unique
  ON public.match_sets(match_id, set_number);
CREATE INDEX IF NOT EXISTS matches_status_created_at_idx
  ON public.matches(status, created_at DESC);
CREATE INDEX IF NOT EXISTS match_players_player_idx
  ON public.match_players(player_id);
CREATE INDEX IF NOT EXISTS match_players_match_team_idx
  ON public.match_players(match_id, team);

CREATE TABLE IF NOT EXISTS public.web_sessions (
  session_hash text PRIMARY KEY,
  player_id text REFERENCES public.players(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS web_sessions_expires_at_idx ON public.web_sessions(expires_at);
CREATE INDEX IF NOT EXISTS web_sessions_player_id_idx ON public.web_sessions(player_id);

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.schema_migrations(name) VALUES ('001_web_app.sql') ON CONFLICT DO NOTHING;

COMMIT;
