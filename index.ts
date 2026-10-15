
import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import type { Context } from "telegraf";
import { Pool } from "pg";

const token = process.env.BOT_TOKEN;
const databaseUrl = process.env.DATABASE_URL;

if (!token || !databaseUrl) {
  throw new Error("Set BOT_TOKEN and DATABASE_URL in .env");
}

const bot = new Telegraf(token);

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
});

//

type ScoreSet = {
    a: number;
    b: number;
    kind: "set" | "tb";
  };

  type ScoreState = {
    sets: ScoreSet[];
    mode: "set" | "tb" | null;
    pendingA: number | null;
    pendingB: number | null;
    step: "mode" | "a" | "b" | "confirm";
  };

  const emptyScoreState = (): ScoreState => ({
    sets: [],
    mode: null,
    pendingA: null,
    pendingB: null,
    step: "mode",
  });

  function parseScoreState(value: unknown): ScoreState {
    if (!value || typeof value !== "object") return emptyScoreState();

    const state = value as Partial<ScoreState>;

    return {
      ...emptyScoreState(),
      ...state,
      sets: Array.isArray(state.sets) ? state.sets : [],
    };
  }

  function getSetWinner(sets: ScoreSet[]): "A" | "B" | null {
    const a = sets.filter((s) => s.a > s.b).length;
    const b = sets.filter((s) => s.b > s.a).length;

    if (a >= 2 && b < 2) return "A";
    if (b >= 2 && a < 2) return "B";

    return null;
  }

  function validScoreSet(score: ScoreSet): boolean {
    const { a, b, kind } = score;

    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
      return false;
    }

    if (kind === "tb") {
      return Math.max(a, b) >= 10 && Math.abs(a - b) >= 2;
    }

    return (
      (a === 6 && b <= 4) ||
      (b === 6 && a <= 4) ||
      (a === 7 && (b === 5 || b === 6)) ||
      (b === 7 && (a === 5 || a === 6))
    );
  }

  async function getScoreMatch(matchId: string, userId: string) {
    const result = await pool.query(
      `SELECT
         m.id::text,
         m.status,
         m.created_by::text,
         m.score_state,
         EXISTS (
           SELECT 1 FROM match_players mp
           WHERE mp.match_id = m.id AND mp.player_id = $2
         ) AS is_player
       FROM matches m
       WHERE m.id = $1`,
      [matchId, userId]
    );

    return result.rows[0] ?? null;
  }

  async function changeScoreState(
    matchId: string,
    userId: string,
    change: (state: ScoreState) => ScoreState
  ): Promise<ScoreState> {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `SELECT
           m.id::text,
           m.status,
           m.created_by::text,
           m.score_state,
           EXISTS (
             SELECT 1 FROM match_players mp
             WHERE mp.match_id = m.id AND mp.player_id = $2
           ) AS is_player
         FROM matches m
         WHERE m.id = $1
         FOR UPDATE`,
        [matchId, userId]
      );

      const match = result.rows[0];

      if (!match || match.status !== "in_progress") {
        throw new Error("Матч не знайдено або його вже завершено.");
      }

      if (
        match.created_by !== userId &&
        !match.is_player
      ) {
        throw new Error("Ти не є учасником цього матчу.");
      }

      const state = change(parseScoreState(match.score_state));

      await client.query(
        `UPDATE matches SET score_state = $2::jsonb WHERE id = $1`,
        [matchId, JSON.stringify(state)]
      );

      await client.query("COMMIT");
      return state;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function showScoreUI(
    ctx: Context,
    matchId: string,
    state: ScoreState,
    edit = true
  ) {
    const lines = state.sets.map(
      (s, i) =>
        `${i + 1}. ${s.a}-${s.b}${s.kind === "tb" ? " (супер тай-брейк)" : ""}`
    );

    let text = `🎾 Матч #${matchId}\n\n`;

    text += lines.length
      ? `Збережені сети:\n${lines.join("\n")}\n\n`
      : "Ще немає введених сетів.\n\n";

    const buttons: ReturnType<typeof Markup.button.callback>[][] = [];

    if (state.step === "mode") {
      text += "Обери тип наступного сету.";

      buttons.push([
        Markup.button.callback("Звичайний сет", `sm:${matchId}:set`),
        Markup.button.callback("Супер тай-брейк", `sm:${matchId}:tb`),
      ]);

      if (state.sets.length > 0) {
        buttons.push([
          Markup.button.callback("↩️ Видалити останній сет", `su:${matchId}`),
        ]);
      }

      if (getSetWinner(state.sets)) {
        buttons.push([
          Markup.button.callback("🏁 Завершити матч", `sf:${matchId}`),
        ]);
      }
    } else if (state.step === "a" || state.step === "b") {
      const choosingA = state.step === "a";
      const max = state.mode === "tb" ? 12 : 7;
      const chosen = choosingA ? null : state.pendingA;

      text += state.mode === "tb"
        ? "Введення супер тай-брейку: перемога від 10 очок із перевагою щонайменше 2."
        : "Введення звичайного сету.";

      text += choosingA
        ? "\n\nОбери кількість геймів команди A."
        : `\n\nКоманда A: ${chosen}\nОбери кількість геймів/очок команди B.`;

      const callbackPrefix = choosingA ? "sa" : "sb";

      for (let start = 0; start <= max; start += 4) {
        const row = [];

        for (let n = start; n <= Math.min(start + 3, max); n++) {
          row.push(
            Markup.button.callback(
              String(n),
              `${callbackPrefix}:${matchId}:${n}`
            )
          );
        }

        buttons.push(row);
      }

      buttons.push([
        Markup.button.callback("⬅️ Назад", `sr:${matchId}`),
      ]);
    } else {
      text += `Поточний рахунок: ${state.pendingA}-${state.pendingB}\n\nПідтвердити цей сет?`;

      buttons.push([
        Markup.button.callback("✅ Зберегти сет", `ss:${matchId}`),
        Markup.button.callback("✏️ Змінити", `sr:${matchId}`),
      ]);
    }

    buttons.push([
      Markup.button.callback("⬅️ Меню", "menu"),
    ]);

    const keyboard = Markup.inlineKeyboard(buttons);

    if (edit && ctx.callbackQuery && "message" in ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, keyboard);
        return;
      } catch {
        // Наприклад, повідомлення не змінилося — надсилаємо нове.
      }
    }

    await ctx.reply(text, keyboard);
  }

  async function handleScoreError(ctx: Context, error: unknown) {
    console.error(error);

    const message =
      error instanceof Error ? error.message : "Невідома помилка";

    await ctx.reply(`⚠️ ${message}`);
  }


async function showAmericanoUI(
    ctx: Context,
    matchId: string,
    scoreA: number,
    scoreB: number,
    target: number,
    edit = true
  ) {
    const total = scoreA + scoreB;
    const remaining = target - total;

    let progressText: string;

    if (remaining > 0) {
      progressText = `До цілі ${target}: ще ${remaining} очок`;
    } else if (remaining === 0) {
      progressText = `🎯 Ціль ${target} очок досягнута`;
    } else {
      progressText = `Ціль перевищено на ${Math.abs(remaining)} оч.`;
    }

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback("−5", `ama:${matchId}:a:-5`),
        Markup.button.callback("−1", `ama:${matchId}:a:-1`),
        Markup.button.callback("+1", `ama:${matchId}:a:1`),
        Markup.button.callback("+5", `ama:${matchId}:a:5`),
      ],
      [
        Markup.button.callback("−5", `ama:${matchId}:b:-5`),
        Markup.button.callback("−1", `ama:${matchId}:b:-1`),
        Markup.button.callback("+1", `ama:${matchId}:b:1`),
        Markup.button.callback("+5", `ama:${matchId}:b:5`),
      ],
      [
        Markup.button.callback("↩️ Скинути рахунок", `amar:${matchId}`),
      ],
      [
        Markup.button.callback("🏁 Завершити матч", `amf:${matchId}`),
      ],
      [
        Markup.button.callback("⬅️ Меню", "menu"),
      ],
    ]);

    const text =
      `⚡ Americano — матч #${matchId}\n\n` +
      `🅰️ Команда A: ${scoreA}\n` +
      `🅱️ Команда B: ${scoreB}\n\n` +
      `Разом: ${total}\n` +
      `${progressText}\n\n` +
      `Ціль — орієнтир, а не обов'язкова умова завершення.\n` +
      `Кнопки першого рядка змінюють A, другого — B.`;

    if (edit && ctx.callbackQuery && "message" in ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, keyboard);
        return;
      } catch {
        // Якщо повідомлення не вдалося відредагувати — надішлемо нове.
      }
    }

    await ctx.reply(text, keyboard);
  }

//

type Player = {
  telegram_id: string;
  display_name: string;
  username: string | null;
};

type Draft =
  | { step: "select"; selected: string[] }
  | { step: "teamA"; selected: string[]; teamA: string[] }
  | { step: "score"; matchId: string };

const drafts = new Map<number, Draft>();

function mainMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🎾 Новий матч", "new_match"),
      Markup.button.callback("👥 Гравці", "players"),
    ],
    [
      Markup.button.callback("📊 Моя статистика", "stats"),
      Markup.button.callback("🏆 Рейтинг", "ranking"),
    ],
    [Markup.button.callback("✍️ Ввести рахунок", "enter_result")],
  ]);
}

async function registerPlayer(ctx: Context) {
  if (!ctx.from) return;

  const displayName = [
    ctx.from.first_name,
    ctx.from.last_name,
  ].filter(Boolean).join(" ");

  await pool.query(
    `INSERT INTO players (telegram_id, username, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id)
     DO UPDATE SET
       username = EXCLUDED.username,
       display_name = EXCLUDED.display_name`,
    [String(ctx.from.id), ctx.from.username ?? null, displayName || "Player"]
  );
}

async function getPlayers(): Promise<Player[]> {
  const result = await pool.query(
    `SELECT telegram_id::text, display_name, username
     FROM players
     ORDER BY LOWER(display_name)`
  );

  return result.rows;
}

async function showMenu(ctx: Context, edit = false) {
  const text = "🎾 Padel Tracker\n\nЩо хочеш зробити?";

  if (edit && ctx.callbackQuery && "message" in ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, mainMenu());
      return;
    } catch {
      // Якщо повідомлення не можна редагувати — надішлемо нове.
    }
  }

  await ctx.reply(text, mainMenu());
}

bot.start(async (ctx) => {
  await registerPlayer(ctx);
  drafts.delete(ctx.from.id);

  await ctx.reply(
    "Вітаю в Padel Tracker! 🎾\n\nОбирай дію в меню.",
    mainMenu()
  );
});

bot.command("menu", async (ctx) => {
  await registerPlayer(ctx);
  await showMenu(ctx);
});

bot.command("ping", async (ctx) => {
  const result = await pool.query("SELECT NOW() AS time");
  await ctx.reply(`✅ База даних працює.\n${result.rows[0].time}`);
});

// Головне меню
bot.action("menu", async (ctx) => {
  await ctx.answerCbQuery();
  drafts.delete(ctx.from.id);
  await showMenu(ctx, true);
});

// Почати створення матчу
bot.action("new_match", async (ctx) => {
  await ctx.answerCbQuery();

  const players = await getPlayers();

  if (players.length < 4) {
    await ctx.reply(
      "Потрібно щонайменше 4 зареєстровані гравці.\n\n" +
      "Нехай кожен друг надішле боту /start."
    );
    return;
  }

  drafts.set(ctx.from.id, { step: "select", selected: [] });
  await showPlayerSelection(ctx, players, []);
});

async function showPlayerSelection(
  ctx: Context,
  players: Player[],
  selected: string[]
) {
  const buttons = players.map((p) => {
    const checked = selected.includes(p.telegram_id) ? "✅ " : "";
    return [
      Markup.button.callback(
        checked + p.display_name,
        `pick:${p.telegram_id}`
      ),
    ];
  });

  buttons.push([
    Markup.button.callback(
      `Продовжити (${selected.length}/4)`,
      "players_next"
    ),
  ]);

  buttons.push([Markup.button.callback("⬅️ Меню", "menu")]);

  const text =
    "🎾 Новий матч\n\n" +
    "Обери рівно 4 гравців.\n" +
    "Натискай на ім'я, щоб вибрати або прибрати гравця.\n\n" +
    `Вибрано: ${selected.length}/4`;

  if (ctx.callbackQuery && "message" in ctx.callbackQuery) {
    try {
      await ctx.editMessageText(
        text,
        Markup.inlineKeyboard(buttons)
      );
      return;
    } catch {
      // Переходимо до нового повідомлення.
    }
  }

  await ctx.reply(text, Markup.inlineKeyboard(buttons));
}

bot.action(/^pick:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const draft = drafts.get(ctx.from.id);
  if (!draft || draft.step !== "select") {
    await ctx.reply("Почни створення матчу через меню.");
    return;
  }

  const id = ctx.match[1];
  let selected = [...draft.selected];

  if (selected.includes(id)) {
    selected = selected.filter((item) => item !== id);
  } else if (selected.length < 4) {
    selected.push(id);
  } else {
    await ctx.answerCbQuery("Можна вибрати лише 4 гравців.", {
      show_alert: true,
    });
    return;
  }

  drafts.set(ctx.from.id, { step: "select", selected });

  await showPlayerSelection(ctx, await getPlayers(), selected);
});

// Після вибору 4 гравців — вибираємо двох у команду A
bot.action("players_next", async (ctx) => {
  await ctx.answerCbQuery();

  const draft = drafts.get(ctx.from.id);

  if (!draft || draft.step !== "select" || draft.selected.length !== 4) {
    await ctx.answerCbQuery("Спочатку вибери рівно 4 гравців.", {
      show_alert: true,
    });
    return;
  }

  drafts.set(ctx.from.id, {
    step: "teamA",
    selected: draft.selected,
    teamA: [],
  });

  await showTeamASelection(ctx, draft.selected, []);
});

async function showTeamASelection(
  ctx: Context,
  selected: string[],
  teamA: string[]
) {
  const players = await getPlayers();
  const byId = new Map(players.map((p) => [p.telegram_id, p]));

  const buttons = selected.map((id) => {
    const player = byId.get(id);
    const checked = teamA.includes(id) ? "🅰️ " : "";
    return [
      Markup.button.callback(
        checked + (player?.display_name ?? id),
        `teamA:${id}`
      ),
    ];
  });

  buttons.push([
    Markup.button.callback(`Підтвердити команду A (${teamA.length}/2)`, "confirm_teams"),
  ]);
  buttons.push([Markup.button.callback("⬅️ Меню", "menu")]);

  const text =
    "👥 Розподіл команд\n\n" +
    "Вибери двох гравців у команду A.\n" +
    "Двоє інших автоматично потраплять у команду B.\n\n" +
    `Команда A: ${teamA.length}/2`;

  try {
    await ctx.editMessageText(text, Markup.inlineKeyboard(buttons));
  } catch {
    await ctx.reply(text, Markup.inlineKeyboard(buttons));
  }
}

bot.action(/^teamA:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const draft = drafts.get(ctx.from.id);
  if (!draft || draft.step !== "teamA") return;

  const id = ctx.match[1];
  let teamA = [...draft.teamA];

  if (teamA.includes(id)) {
    teamA = teamA.filter((item) => item !== id);
  } else if (teamA.length < 2) {
    teamA.push(id);
  } else {
    await ctx.answerCbQuery("У команді A має бути двоє гравців.", {
      show_alert: true,
    });
    return;
  }

  drafts.set(ctx.from.id, {
    step: "teamA",
    selected: draft.selected,
    teamA,
  });

  await showTeamASelection(ctx, draft.selected, teamA);
});

bot.action("confirm_teams", async (ctx) => {
  await ctx.answerCbQuery();

  const draft = drafts.get(ctx.from.id);

  if (!draft || draft.step !== "teamA" || draft.teamA.length !== 2) {
    await ctx.answerCbQuery("Вибери рівно двох гравців у команду A.", {
      show_alert: true,
    });
    return;
  }

  const teamB = draft.selected.filter((id) => !draft.teamA.includes(id));
  const players = await getPlayers();
  const byId = new Map(players.map((p) => [p.telegram_id, p]));

  const teamAText = draft.teamA
    .map((id) => byId.get(id)?.display_name ?? id)
    .join(" та ");

  const teamBText = teamB
    .map((id) => byId.get(id)?.display_name ?? id)
    .join(" та ");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const matchResult = await client.query(
      `INSERT INTO matches (created_by, status)
       VALUES ($1, 'in_progress')
       RETURNING id::text`,
      [String(ctx.from.id)]
    );

    const matchId = matchResult.rows[0].id;

    for (const id of draft.selected) {
      await client.query(
        `INSERT INTO match_players (match_id, player_id, team)
         VALUES ($1, $2, $3)`,
        [
          matchId,
          id,
          draft.teamA.includes(id) ? "A" : "B",
        ]
      );
    }

    await client.query("COMMIT");

    await ctx.editMessageText(
      `✅ Матч #${matchId} створено!\n\n` +
      `🅰️ Команда A\n${teamAText}\n\n` +
      `🅱️ Команда B\n${teamBText}\n\n` +
      "Коли завершите гру, натисни «Ввести рахунок» у меню."
    );
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    await ctx.reply("Не вдалося створити матч. Спробуй ще раз.");
  } finally {
    client.release();
  }
});

// Список матчів, для яких ще не внесений результат
  bot.action("enter_result", async (ctx) => {
    await ctx.answerCbQuery();

    try {
      const userId = ctx.from.id;

      const result = await pool.query(
        `
        SELECT DISTINCT
          m.id,
          m.played_at,
          m.created_by,
          (
            SELECT COUNT(*)
            FROM match_players mp
            WHERE mp.match_id = m.id
          ) AS players_count
        FROM matches m
        WHERE m.status = 'in_progress'
          AND (
            m.created_by = $1
            OR EXISTS (
              SELECT 1
              FROM match_players mp
              WHERE mp.match_id = m.id
                AND mp.player_id = $1
            )
          )
        ORDER BY m.played_at DESC
        LIMIT 20
        `,
        [userId]
      );

      console.log(
        "[enter_result]",
        "userId:", userId,
        "matches:", result.rows.length
      );

      if (result.rows.length === 0) {
        await ctx.reply(
          "Немає незавершених матчів, доступних для введення рахунку. 🎾\n\n" +
          "Спочатку створи матч і перевір, що він має статус in_progress."
        );
        return;
      }

      const buttons = result.rows.flatMap((match) => [
        [
          Markup.button.callback(
            `🎾 Сети — матч #${match.id}`,
            `score:${match.id}`
          ),
          Markup.button.callback(
            `⚡ Americano — матч #${match.id}`,
            `americano:${match.id}`
          ),
        ],
      ]);

      await ctx.reply(
        "Оберіть матч, для якого потрібно ввести рахунок:",
        Markup.inlineKeyboard(buttons)
      );
    } catch (error) {
      console.error("[enter_result] Error:", error);

      await ctx.reply(
        "Не вдалося завантажити матчі. Перевір термінал — там має бути причина."
      );
    }
  });


  bot.action(/^score:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    try {
      const matchId = ctx.match[1];
      const match = await getScoreMatch(matchId, String(ctx.from.id));

      if (!match || match.status !== "in_progress") {
        await ctx.reply("Матч не знайдено або вже завершено.");
        return;
      }

      if (
        match.created_by !== String(ctx.from.id) &&
        !match.is_player
      ) {
        await ctx.reply("Ти не є учасником цього матчу.");
        return;
      }

      await pool.query(
        `UPDATE matches
         SET match_format = 'sets'
         WHERE id = $1 AND status = 'in_progress'`,
        [matchId]
      );

      await showScoreUI(
        ctx,
        matchId,
        parseScoreState(match.score_state),
        false
      );
    } catch (error) {
      await handleScoreError(ctx, error);
    }
  });

  // Вибір типу сету
  bot.action(/^sm:(\d+):(set|tb)$/, async (ctx) => {
    await ctx.answerCbQuery();

    try {
      const [, matchId, mode] = ctx.match;

      const state = await changeScoreState(
        matchId,
        String(ctx.from.id),
        (old) => ({
          ...old,
          mode: mode as "set" | "tb",
          pendingA: null,
          pendingB: null,
          step: "a",
        })
      );

      await showScoreUI(ctx, matchId, state);
    } catch (error) {
      await handleScoreError(ctx, error);
    }
  });

  // Вибір рахунку команди A
  bot.action(/^sa:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    try {
      const [, matchId, rawScore] = ctx.match;
      const score = Number(rawScore);

      const state = await changeScoreState(
        matchId,
        String(ctx.from.id),
        (old) => {
          if (old.step !== "a" || !old.mode) {
            throw new Error("Спочатку обери тип сету.");
          }

          const max = old.mode === "tb" ? 12 : 7;

          if (score < 0 || score > max) {
            throw new Error("Недопустимий рахунок.");
          }

          return {
            ...old,
            pendingA: score,
            pendingB: null,
            step: "b",
          };
        }
      );

      await showScoreUI(ctx, matchId, state);
    } catch (error) {
      await handleScoreError(ctx, error);
    }
  });

  // Вибір рахунку команди B
  bot.action(/^sb:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    try {
      const [, matchId, rawScore] = ctx.match;
      const score = Number(rawScore);

      const state = await changeScoreState(
        matchId,
        String(ctx.from.id),
        (old) => {
          if (old.step !== "b" || old.pendingA === null || !old.mode) {
            throw new Error("Спочатку обери рахунок команди A.");
          }

          const max = old.mode === "tb" ? 12 : 7;

          if (score < 0 || score > max) {
            throw new Error("Недопустимий рахунок.");
          }

          return {
            ...old,
            pendingB: score,
            step: "confirm",
          };
        }
      );

      await showScoreUI(ctx, matchId, state);
    } catch (error) {
      await handleScoreError(ctx, error);
    }
  });

  // Зберегти поточний сет у незавершеному стані матчу
  bot.action(/^ss:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    try {
      const matchId = ctx.match[1];

      const state = await changeScoreState(
        matchId,
        String(ctx.from.id),
        (old) => {
          if (
            old.step !== "confirm" ||
            old.pendingA === null ||
            old.pendingB === null ||
            !old.mode
          ) {
            throw new Error("Спочатку введи рахунок обох команд.");
          }

          const newSet: ScoreSet = {
            a: old.pendingA,
            b: old.pendingB,
            kind: old.mode,
          };

          if (!validScoreSet(newSet)) {
            throw new Error(
              newSet.kind === "set"
                ? "Невірний рахунок сету. Приклади: 6-4, 7-5, 7-6."
                : "Для супер тай-брейку потрібна перемога від 10 очок із різницею щонайменше 2."
            );
          }

          if (getSetWinner([...old.sets, newSet])) {
            throw new Error(
              "Одна команда вже виграла два сети. Заверши матч."
            );
          }

          return {
            ...old,
            sets: [...old.sets, newSet],
            mode: null,
            pendingA: null,
            pendingB: null,
            step: "mode",
          };
        }
      );

      await showScoreUI(ctx, matchId, state);
    } catch (error) {
      await handleScoreError(ctx, error);
    }
  });

  // Назад до вибору типу сету
  bot.action(/^sr:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    try {
      const matchId = ctx.match[1];

      const state = await changeScoreState(
        matchId,
        String(ctx.from.id),
        (old) => ({
          ...old,
          mode: null,
          pendingA: null,
          pendingB: null,
          step: "mode",
        })
      );

      await showScoreUI(ctx, matchId, state);
    } catch (error) {
      await handleScoreError(ctx, error);
    }
  });

  // Видалити останній збережений сет
  bot.action(/^su:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    try {
      const matchId = ctx.match[1];

      const state = await changeScoreState(
        matchId,
        String(ctx.from.id),
        (old) => ({
          ...old,
          sets: old.sets.slice(0, -1),
          mode: null,
          pendingA: null,
          pendingB: null,
          step: "mode",
        })
      );

      await showScoreUI(ctx, matchId, state);
    } catch (error) {
      await handleScoreError(ctx, error);
    }
  });

  // Завершити матч і перенести сети в match_sets
  bot.action(/^sf:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    const matchId = ctx.match[1];
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `SELECT
           m.id::text,
           m.status,
           m.created_by::text,
           m.score_state,
           EXISTS (
             SELECT 1 FROM match_players mp
             WHERE mp.match_id = m.id
               AND mp.player_id = $2
           ) AS is_player
         FROM matches m
         WHERE m.id = $1
         FOR UPDATE`,
        [matchId, String(ctx.from.id)]
      );

      const match = result.rows[0];

      if (!match || match.status !== "in_progress") {
        throw new Error("Матч не знайдено або вже завершено.");
      }

      if (
        match.created_by !== String(ctx.from.id) &&
        !match.is_player
      ) {
        throw new Error("Ти не є учасником цього матчу.");
      }

      const state = parseScoreState(match.score_state);
      const winner = getSetWinner(state.sets);

      if (!winner) {
        throw new Error(
          "Матч можна завершити, коли одна команда виграла два сети."
        );
      }

      if (state.step !== "mode") {
        throw new Error("Спочатку збережи або скасуй введення поточного сету.");
      }

      for (let i = 0; i < state.sets.length; i++) {
        const set = state.sets[i];

        await client.query(
          `INSERT INTO match_sets (match_id, set_number, score_a, score_b)
           VALUES ($1, $2, $3, $4)`,
          [matchId, i + 1, set.a, set.b]
        );
      }

      await client.query(
        `UPDATE matches
         SET status = 'completed', winner_team = $2
         WHERE id = $1`,
        [matchId, winner]
      );

      await client.query("COMMIT");

      await ctx.reply(
        `🏆 Матч #${matchId} завершено!\n\n` +
        state.sets
          .map((s, i) => `${i + 1}. ${s.a}-${s.b}`)
          .join("\n") +
        `\n\nПеремогла команда ${winner}.`,
        mainMenu()
      );
    } catch (error) {
      await client.query("ROLLBACK");
      await handleScoreError(ctx, error);
    } finally {
      client.release();
    }
  });


async function getAuthorizedAmericanoMatch(
    matchId: string,
    userId: string
  ) {
    const result = await pool.query(
      `SELECT
         m.id::text,
         m.status,
         m.created_by::text,
         COALESCE(m.americano_score_a, 0)::int AS score_a,
         COALESCE(m.americano_score_b, 0)::int AS score_b,
         m.americano_target::int AS target,
         EXISTS (
           SELECT 1 FROM match_players mp
           WHERE mp.match_id = m.id AND mp.player_id = $2
         ) AS is_player
       FROM matches m
       WHERE m.id = $1 AND m.match_format = 'americano'`,
      [matchId, userId]
    );

    const match = result.rows[0];

    if (!match || match.status !== "in_progress") {
      throw new Error("Матч Americano не знайдено або його вже завершено.");
    }

    if (match.created_by !== userId && !match.is_player) {
      throw new Error("Ти не є учасником цього матчу.");
    }

    return match;
  }

  // Обрати формат Americano для незавершеного матчу
  bot.action(/^americano:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    try {
      const matchId = ctx.match[1];
      const userId = String(ctx.from.id);

      const result = await pool.query(
        `UPDATE matches m
         SET match_format = 'americano',
             americano_score_a = COALESCE(americano_score_a, 0),
             americano_score_b = COALESCE(americano_score_b, 0),
             americano_target = COALESCE(americano_target, 24)
         WHERE m.id = $1
           AND m.status = 'in_progress'
           AND (
             m.created_by = $2
             OR EXISTS (
               SELECT 1 FROM match_players mp
               WHERE mp.match_id = m.id AND mp.player_id = $2
             )
           )
         RETURNING
           m.americano_score_a AS score_a,
           m.americano_score_b AS score_b,
           m.americano_target AS target`,
        [matchId, userId]
      );

      if (!result.rowCount) {
        throw new Error("Матч не знайдено або в тебе немає доступу.");
      }

      const match = result.rows[0];

      await showAmericanoUI(
        ctx,
        matchId,
        match.score_a,
        match.score_b,
        match.target,
        false
      );
    } catch (error) {
      await handleScoreError(ctx, error);
    }
  });

  // Змінити рахунок команди A або B
  bot.action(/^ama:(\d+):(a|b):(-?5|-?1|1|5)$/, async (ctx) => {
    await ctx.answerCbQuery();

    try {
      const [, matchId, team, rawDelta] = ctx.match;
      const delta = Number(rawDelta);
      const userId = String(ctx.from.id);

      const match = await getAuthorizedAmericanoMatch(matchId, userId);

      const column =
        team === "a" ? "americano_score_a" : "americano_score_b";

      const current = team === "a" ? match.score_a : match.score_b;
      const next = Math.max(0, current + delta);

      await pool.query(
        `UPDATE matches
         SET ${column} = $2
         WHERE id = $1 AND status = 'in_progress'
           AND match_format = 'americano'`,
        [matchId, next]
      );

      const updated = await getAuthorizedAmericanoMatch(matchId, userId);

      await showAmericanoUI(
        ctx,
        matchId,
        updated.score_a,
        updated.score_b,
        updated.target
      );
    } catch (error) {
      await handleScoreError(ctx, error);
    }
  });

  // Скинути рахунок, якщо потрібно почати введення заново
  bot.action(/^amar:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    try {
      const matchId = ctx.match[1];
      const userId = String(ctx.from.id);

      await getAuthorizedAmericanoMatch(matchId, userId);

      await pool.query(
        `UPDATE matches
         SET americano_score_a = 0, americano_score_b = 0
         WHERE id = $1 AND status = 'in_progress'
           AND match_format = 'americano'`,
        [matchId]
      );

      await showAmericanoUI(ctx, matchId, 0, 0, 24);
    } catch (error) {
      await handleScoreError(ctx, error);
    }
  });

  // Завершити Americano з фактичним рахунком
  bot.action(/^amf:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();

    const matchId = ctx.match[1];
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `SELECT
           m.id::text,
           m.status,
           m.created_by::text,
           COALESCE(m.americano_score_a, 0)::int AS score_a,
           COALESCE(m.americano_score_b, 0)::int AS score_b,
           EXISTS (
             SELECT 1 FROM match_players mp
             WHERE mp.match_id = m.id AND mp.player_id = $2
           ) AS is_player
         FROM matches m
         WHERE m.id = $1 AND m.match_format = 'americano'
         FOR UPDATE`,
        [matchId, String(ctx.from.id)]
      );

      const match = result.rows[0];

      if (!match || match.status !== "in_progress") {
        throw new Error("Матч не знайдено або його вже завершено.");
      }

      if (
        match.created_by !== String(ctx.from.id) &&
        !match.is_player
      ) {
        throw new Error("Ти не є учасником цього матчу.");
      }

      const { score_a: a, score_b: b } = match;
      const winner = a > b ? "A" : b > a ? "B" : null;

      await client.query(
        `UPDATE matches
         SET status = 'completed',
             winner_team = $2,
             played_at = NOW()
         WHERE id = $1`,
        [matchId, winner]
      );

      await client.query("COMMIT");

      const outcome =
        winner === null
          ? "🤝 Нічия!"
          : `🏆 Перемогла команда ${winner}.`;

      await ctx.reply(
        `✅ Americano — матч #${matchId} завершено!\n\n` +
        `🅰️ Команда A: ${a} очок\n` +
        `🅱️ Команда B: ${b} очок\n` +
        `Разом: ${a + b}\n\n` +
        `${outcome}\n\n` +
        `Кожен гравець команди A отримує ${a} очок, ` +
        `кожен гравець команди B — ${b} очок.`,
        mainMenu()
      );
    } catch (error) {
      await client.query("ROLLBACK");
      await handleScoreError(ctx, error);
    } finally {
      client.release();
    }
  });


// Список зареєстрованих гравців
bot.action("players", async (ctx) => {
  await ctx.answerCbQuery();
  const players = await getPlayers();

  const text = players.length
    ? "👥 Зареєстровані гравці:\n\n" +
      players.map((p, i) => `${i + 1}. ${p.display_name}`).join("\n")
    : "Поки немає зареєстрованих гравців.";

  await ctx.reply(text, mainMenu());
});

// Особиста статистика

  bot.action("stats", async (ctx) => {
    await ctx.answerCbQuery();

    const result = await pool.query(
      `SELECT
         COUNT(*)::int AS played,
         COUNT(*) FILTER (
           WHERE m.winner_team = mp.team
         )::int AS wins,
         COUNT(*) FILTER (
           WHERE m.winner_team IS NULL
         )::int AS draws,
         COALESCE(SUM(
           CASE
             WHEN m.match_format = 'americano'
               AND mp.team = 'A'
               THEN m.americano_score_a
             WHEN m.match_format = 'americano'
               AND mp.team = 'B'
               THEN m.americano_score_b
             ELSE 0
           END
         ), 0)::int AS americano_points
       FROM match_players mp
       JOIN matches m ON m.id = mp.match_id
       WHERE mp.player_id = $1
         AND m.status = 'completed'`,
      [String(ctx.from.id)]
    );

    const { played, wins, draws, americano_points } = result.rows[0];
    const losses = played - wins - draws;
    const rate = played ? Math.round((wins / played) * 100) : 0;

    await ctx.reply(
      `📊 Твоя статистика\n\n` +
      `Матчів: ${played}\n` +
      `Перемог: ${wins}\n` +
      `Нічиїх: ${draws}\n` +
      `Поразок: ${losses}\n` +
      `Відсоток перемог: ${rate}%\n` +
      `Очки Americano: ${americano_points}`,
      mainMenu()
    );
  });

// Рейтинг гравців

  bot.action("ranking", async (ctx) => {
    await ctx.answerCbQuery();

    const result = await pool.query(
      `SELECT
         p.display_name,
         COUNT(*)::int AS played,
         COUNT(*) FILTER (
           WHERE m.winner_team = mp.team
         )::int AS wins,
         COUNT(*) FILTER (
           WHERE m.winner_team IS NULL
         )::int AS draws,
         COALESCE(SUM(
           CASE
             WHEN m.match_format = 'americano'
               AND mp.team = 'A'
               THEN m.americano_score_a
             WHEN m.match_format = 'americano'
               AND mp.team = 'B'
               THEN m.americano_score_b
             ELSE 0
           END
         ), 0)::int AS americano_points
       FROM players p
       JOIN match_players mp ON mp.player_id = p.telegram_id
       JOIN matches m ON m.id = mp.match_id
       WHERE m.status = 'completed'
       GROUP BY p.telegram_id, p.display_name
       ORDER BY wins DESC,
         americano_points DESC,
         played DESC,
         p.display_name ASC
       LIMIT 30`
    );

    const text = result.rows.length
      ? "🏆 Рейтинг гравців\n\n" +
        result.rows.map((p, i) => {
          const rate = p.played
            ? Math.round((p.wins / p.played) * 100)
            : 0;

          return (
            `${i + 1}. ${p.display_name}\n` +
            `   🏆 ${p.wins} перемог / ${p.played} матчів\n` +
            `   🤝 Нічиїх: ${p.draws}\n` +
            `   ⚡ Очки Americano: ${p.americano_points}\n` +
            `   📈 Перемог: ${rate}%`
          );
        }).join("\n\n")
      : "Поки немає завершених матчів.";

    await ctx.reply(text, mainMenu());
  });


bot.catch((error) => {
  console.error("Telegram bot error:", error);
});

async function main() {
  await pool.query("SELECT 1");
  await bot.launch();
  console.log("🎾 Padel Tracker is running");
}

main().catch((error) => {
  console.error("Failed to start bot:", error);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
