import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

type Role = "admin" | "player";
type Team = "A" | "B";
type MatchFormat = "sets" | "americano";
type SetKind = "set" | "tb";
type User = { id: string; displayName: string; email: string; role: Role; eloRating: number };
type Player = {
  id: string;
  displayName: string;
  eloRating: number;
  role: Role;
  isActive: boolean;
  hasAccount: boolean;
};
type MatchPlayer = {
  id: string;
  displayName: string;
  team: Team;
  eloBefore: number | null;
  eloChange: number | null;
};
type MatchSet = { setNumber: number; a: number; b: number; kind: SetKind };
type Match = {
  id: string;
  status: "in_progress" | "completed";
  format: MatchFormat;
  winnerTeam: Team | null;
  createdById: string;
  createdAt: string;
  playedAt: string | null;
  scoreA: number;
  scoreB: number;
  target: number;
  players: MatchPlayer[];
  teams: { A: MatchPlayer[]; B: MatchPlayer[] };
  sets: MatchSet[];
  canManage: boolean;
  canDelete: boolean;
};
type Stats = {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  winRate: number;
  americanoPoints: number;
  eloChange: number;
};
type RankingRow = Stats & {
  playerId: string;
  displayName: string;
  eloRating: number;
  position: number;
};
type Page = "overview" | "matches" | "players" | "ranking" | "stats" | "profile";
type ApiOptions = { method?: string; body?: unknown };

async function api<T>(url: string, options: ApiOptions = {}, csrfToken?: string): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  }
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Помилка запиту (${response.status})`);
  return payload as T;
}

function formatDate(value: string | null): string {
  if (!value) return "Щойно створено";
  return new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

function rankName(elo: number): { label: string; emoji: string } {
  const ranks = [
    { min: 1700, label: "Верховний падел-боженька", emoji: "🏆" },
    { min: 1550, label: "Машина для апсетів", emoji: "⚡" },
    { min: 1400, label: "Падел-магнат", emoji: "💸" },
    { min: 1300, label: "Король чікени", emoji: "👑" },
    { min: 1200, label: "Скляний шаман", emoji: "🔮" },
    { min: 1100, label: "Баболат-бандит", emoji: "😎" },
    { min: 1000, label: "П'яний майстер кунг-фу", emoji: "🥋" },
    { min: 900, label: "Файна подача", emoji: "🎾" },
    { min: 800, label: "Падел-чікіта", emoji: "🍌" },
    { min: 0, label: "Картопля на корті", emoji: "🥔" },
  ];
  return ranks.find((rank) => elo >= rank.min) ?? { label: "Картопля на корті", emoji: "🥔" };
}

function App() {
  const [csrfToken, setCsrfToken] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<Page>("overview");
  const [players, setPlayers] = useState<Player[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [ranking, setRanking] = useState<RankingRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [selectedMatch, setSelectedMatch] = useState<Match | null>(null);
  const [matchFilter, setMatchFilter] = useState<"all" | "in_progress" | "completed">("all");
  const [toast, setToast] = useState("");

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3600);
  }, []);

  const refreshCsrf = useCallback(async () => {
    const result = await api<{ csrfToken: string }>("/api/auth/csrf");
    setCsrfToken(result.csrfToken);
    return result.csrfToken;
  }, []);

  const refreshData = useCallback(async () => {
    if (!user) return;
    const [playersResult, matchesResult, rankingResult, statsResult] = await Promise.all([
      api<{ players: Player[] }>("/api/players"),
      api<{ matches: Match[] }>("/api/matches"),
      api<{ ranking: RankingRow[] }>("/api/ranking"),
      api<{ stats: Stats }>("/api/stats/me"),
    ]);
    setPlayers(playersResult.players);
    setMatches(matchesResult.matches);
    setRanking(rankingResult.ranking);
    setStats(statsResult.stats);
    const updatedElo = rankingResult.ranking.find((row) => row.playerId === user.id)?.eloRating;
    if (typeof updatedElo === "number") {
      setUser((current) => current && current.eloRating !== updatedElo
        ? { ...current, eloRating: updatedElo }
        : current);
    }
  }, [user]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const token = await api<{ csrfToken: string }>("/api/auth/csrf");
        if (!active) return;
        setCsrfToken(token.csrfToken);
        const result = await api<{ user: User | null }>("/api/auth/me");
        if (active) setUser(result.user);
      } catch (error) {
        if (active) notify(error instanceof Error ? error.message : "Не вдалося підключитися до сервера.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [notify]);

  useEffect(() => {
    if (user) {
      refreshData().catch((error) => notify(error instanceof Error ? error.message : "Не вдалося завантажити дані."));
    } else {
      setPlayers([]);
      setMatches([]);
      setRanking([]);
      setStats(null);
    }
  }, [user, refreshData, notify]);

  const login = async (email: string, password: string) => {
    await api("/api/auth/login", { method: "POST", body: { email, password } }, csrfToken);
    await refreshCsrf();
    const result = await api<{ user: User }>("/api/auth/me");
    setUser(result.user);
    notify("Вітаємо! Ти увійшов у Padel Tracker.");
  };

  const register = async (email: string, password: string, displayName: string, inviteCode: string) => {
    await api("/api/auth/register", {
      method: "POST",
      body: { email, password, displayName, inviteCode },
    }, csrfToken);
    await refreshCsrf();
    const result = await api<{ user: User }>("/api/auth/me");
    setUser(result.user);
    notify("Акаунт створено. Гарної гри!");
  };

  const logout = async () => {
    try {
      await api("/api/auth/logout", { method: "POST" }, csrfToken);
      setUser(null);
      setSelectedMatch(null);
      setPage("overview");
      await refreshCsrf();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Не вдалося вийти.");
    }
  };

  const openMatch = async (id: string) => {
    try {
      const result = await api<{ match: Match }>(`/api/matches/${id}`);
      setSelectedMatch(result.match);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Не вдалося відкрити матч.");
    }
  };

  const acceptMatchUpdate = async (updated: Match) => {
    setSelectedMatch(updated);
    await refreshData();
    if (updated.status === "completed") notify("Матч завершено. ELO перераховано.");
  };

  if (loading) {
    return <div className="loading-screen"><div className="brand-mark">PT</div><span>Завантаження Padel Tracker…</span></div>;
  }

  if (!user) return <AuthScreen onLogin={login} onRegister={register} />;

  const navItems: Array<{ id: Page; label: string; icon: string }> = [
    { id: "overview", label: "Огляд", icon: "◫" },
    { id: "matches", label: "Матчі", icon: "🎾" },
    { id: "players", label: "Гравці", icon: "♧" },
    { id: "ranking", label: "Рейтинг", icon: "🏆" },
    { id: "stats", label: "Статистика", icon: "▥" },
  ];

  const pageTitle: Record<Page, string> = {
    overview: "Огляд",
    matches: "Матчі",
    players: "Гравці",
    ranking: "Рейтинг",
    stats: "Моя статистика",
    profile: "Мій профіль",
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">PT</div><div><strong>PADEL TRACKER</strong><span>CLUB MANAGEMENT</span></div></div>
        <div className="sidebar-label">МЕНЮ</div>
        <nav className="nav-list">
          {navItems.map((item) => (
            <button key={item.id} className={`nav-item ${page === item.id && !selectedMatch ? "active" : ""}`} onClick={() => { setPage(item.id); setSelectedMatch(null); }}>
              <span className="nav-icon">{item.icon}</span>{item.label}
              {item.id === "matches" && matches.filter((match) => match.status === "in_progress").length > 0 && <span className="nav-count">{matches.filter((match) => match.status === "in_progress").length}</span>}
            </button>
          ))}
        </nav>
        {user.role === "admin" && <div className="admin-hint"><span className="admin-dot" /> Адміністратор</div>}
        <div className="sidebar-bottom">
          <div className="sidebar-user"><div className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</div><div className="sidebar-user-info"><strong>{user.displayName}</strong><span>{user.role === "admin" ? "Адмін" : "Гравець"}</span></div><button className="icon-button subtle" title="Профіль" onClick={() => { setPage("profile"); setSelectedMatch(null); }}>⚙</button></div>
          <button className="logout-button" onClick={logout}>↪ Вийти з акаунту</button>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div><div className="eyebrow">PADEL CLUB / TRACKER</div><h1>{selectedMatch ? `Матч #${selectedMatch.id}` : pageTitle[page]}</h1></div>
          <div className="topbar-right"><span className="online-pill"><span /> Система активна</span><button className="profile-chip" onClick={() => { setPage("profile"); setSelectedMatch(null); }}><span className="avatar small">{user.displayName.slice(0, 1).toUpperCase()}</span><span>{user.displayName}</span><span className="chevron">⌄</span></button></div>
        </header>

        {selectedMatch ? (
          <MatchDetail match={selectedMatch} user={user} csrfToken={csrfToken} onBack={() => setSelectedMatch(null)} onUpdated={acceptMatchUpdate} onDeleted={async () => { setSelectedMatch(null); await refreshData(); notify("Матч видалено."); }} onError={notify} />
        ) : page === "overview" ? (
          <Overview user={user} stats={stats} ranking={ranking} matches={matches} onNewMatch={() => setPage("matches")} onOpenMatch={openMatch} />
        ) : page === "matches" ? (
          <MatchesPage matches={matches} filter={matchFilter} setFilter={setMatchFilter} players={players} user={user} csrfToken={csrfToken} onOpenMatch={openMatch} onCreated={async (match) => { await refreshData(); setSelectedMatch(match); notify("Матч створено. Можна вводити рахунок."); }} onError={notify} />
        ) : page === "players" ? (
          <PlayersPage players={players} user={user} csrfToken={csrfToken} onRefresh={refreshData} onError={notify} />
        ) : page === "ranking" ? (
          <RankingPage ranking={ranking} currentUserId={user.id} />
        ) : page === "stats" ? (
          <StatsPage stats={stats} user={user} matches={matches} onOpenMatch={openMatch} />
        ) : (
          <ProfilePage user={user} csrfToken={csrfToken} onUpdated={async () => { await refreshCsrf(); const result = await api<{ user: User }>("/api/auth/me"); setUser(result.user); notify("Профіль оновлено."); }} onError={notify} />
        )}
      </main>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function AuthScreen({
  onLogin,
  onRegister,
}: {
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (email: string, password: string, displayName: string, inviteCode: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "login") await onLogin(email, password);
      else await onRegister(email, password, displayName, inviteCode);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Щось пішло не так.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-brand-panel">
        <div className="brand auth-brand"><div className="brand-mark">PT</div><div><strong>PADEL TRACKER</strong><span>PLAY. TRACK. IMPROVE.</span></div></div>
        <div className="auth-visual"><div className="court-lines"><span /><span /><span /><span /></div><div className="ball">●</div><div className="auth-kicker">YOUR GAME, YOUR NUMBERS</div><h1>Грай сильніше.<br /><em>Рости разом.</em></h1><p>Усі матчі, рейтинги та статистика вашої падел-спільноти — в одному місці.</p></div>
        <div className="auth-panel-footer">PADEL TRACKER · PRIVATE CLUB</div>
      </div>
      <div className="auth-form-panel">
        <form className="auth-card" onSubmit={submit}>
          <div className="mobile-auth-mark"><div className="brand-mark">PT</div><strong>PADEL TRACKER</strong></div>
          <div className="eyebrow">WELCOME TO THE CLUB</div>
          <h2>{mode === "login" ? "Раді бачити знову" : "Створи акаунт"}</h2>
          <p className="muted">{mode === "login" ? "Увійди, щоб переглянути матчі та свою статистику." : "Реєстрація доступна учасникам клубу за invite-кодом."}</p>
          {mode === "register" && <label>Ім'я та прізвище<input autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required minLength={2} maxLength={60} placeholder="Наприклад, Сергій Коваленко" /></label>}
          <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} placeholder="you@example.com" /></label>
          <label>Пароль<input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={mode === "login" ? 1 : 12} maxLength={128} placeholder={mode === "login" ? "Твій пароль" : "Мінімум 12 символів"} /></label>
          {mode === "register" && <label>Invite-код<input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} required maxLength={200} placeholder="Код від адміністратора" /></label>}
          {error && <div className="form-error">{error}</div>}
          <button className="button primary full" disabled={busy}>{busy ? "Зачекай…" : mode === "login" ? "Увійти в акаунт" : "Зареєструватися"}<span>↗</span></button>
          <div className="auth-switch">{mode === "login" ? "Ще немає акаунту?" : "Вже маєш акаунт?"}<button type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? "Зареєструватися" : "Увійти"}</button></div>
        </form>
        <div className="auth-footnote">Захищена сесія · Доступ лише для учасників клубу</div>
      </div>
    </div>
  );
}

function Overview({
  user,
  stats,
  ranking,
  matches,
  onNewMatch,
  onOpenMatch,
}: {
  user: User;
  stats: Stats | null;
  ranking: RankingRow[];
  matches: Match[];
  onNewMatch: () => void;
  onOpenMatch: (id: string) => void;
}) {
  const currentRank = ranking.find((row) => row.playerId === user.id);
  const activeMatches = matches.filter((match) => match.status === "in_progress");
  const recentMatches = matches.slice(0, 5);
  return (
    <div className="page-stack">
      <section className="welcome-banner">
        <div><div className="banner-kicker">СЕЗОН 2026 / CLUB DASHBOARD</div><h2>Привіт, {user.displayName.split(" ")[0]} <span>👋</span></h2><p>Твоя гра — твій прогрес. Переглядай результати та покращуй рейтинг.</p><button className="button lime" onClick={onNewMatch}>＋ Створити матч</button></div>
        <div className="banner-graphic"><div className="banner-orbit" /><div className="banner-ball">●</div><span className="banner-mark">PADEL<br />CLUB</span></div>
      </section>

      <section className="metric-grid">
        <Metric icon="🎾" label="Зіграно матчів" value={stats?.played ?? 0} note="Завершені матчі" />
        <Metric icon="🏆" label="Перемоги" value={stats?.wins ?? 0} note={`${stats?.winRate ?? 0}% win rate`} />
        <Metric icon="📈" label="Поточний ELO" value={user.eloRating} note={currentRank ? rankName(user.eloRating).label : "Початковий рейтинг"} />
        <Metric icon="⚡" label="Очки Americano" value={stats?.americanoPoints ?? 0} note="Набрані командою очки" />
      </section>

      <section className="content-grid">
        <div className="panel recent-panel">
          <div className="section-heading"><div><div className="eyebrow">LATEST ACTIVITY</div><h3>Останні матчі</h3></div><button className="text-button" onClick={onNewMatch}>＋ Новий матч</button></div>
          {recentMatches.length ? <div className="match-list compact">{recentMatches.map((match) => <MatchListItem key={match.id} match={match} onClick={() => onOpenMatch(match.id)} />)}</div> : <EmptyState title="Матчів поки немає" description="Створи перший матч, щоб почати вести історію." />}
        </div>
        <div className="right-column">
          <div className="panel active-panel"><div className="section-heading"><div><div className="eyebrow">LIVE NOW</div><h3>Активні матчі</h3></div><span className="live-count">{activeMatches.length}</span></div>
            {activeMatches.length ? activeMatches.slice(0, 3).map((match) => <button className="active-match-row" key={match.id} onClick={() => onOpenMatch(match.id)}><span className="live-dot" /><span><strong>{teamLabel(match.teams.A)} <i>vs</i> {teamLabel(match.teams.B)}</strong><small>{match.format === "sets" ? "Звичайні сети" : "Americano"}</small></span><b>↗</b></button>) : <p className="muted small-copy">Зараз немає активних матчів.</p>}
          </div>
          <div className="panel mini-ranking"><div className="section-heading"><div><div className="eyebrow">TOP PLAYERS</div><h3>Лідери рейтингу</h3></div></div>
            {ranking.slice(0, 4).map((player) => <div className="mini-rank-row" key={player.playerId}><span className={`position position-${player.position}`}>{player.position}</span><span className="mini-rank-name">{player.displayName}</span><strong>{player.eloRating}</strong></div>)}
          </div>
        </div>
      </section>
    </div>
  );
}

function Metric({ icon, label, value, note }: { icon: string; label: string; value: number; note: string }) {
  return <div className="metric-card"><div className="metric-top"><span className="metric-icon">{icon}</span><span className="metric-trend">CLUB STATS</span></div><div className="metric-value">{value.toLocaleString("uk-UA")}</div><div className="metric-label">{label}</div><div className="metric-note">{note}</div></div>;
}

function teamLabel(team: MatchPlayer[]): string {
  return team.map((player) => player.displayName).join(" / ") || "—";
}

function MatchListItem({ match, onClick }: { match: Match; onClick: () => void }) {
  return (
    <button className="match-row" onClick={onClick}>
      <div className={`match-type-icon ${match.format}`}>{match.format === "sets" ? "🎾" : "⚡"}</div>
      <div className="match-row-main"><div className="match-row-teams"><span>{teamLabel(match.teams.A)}</span><b>vs</b><span>{teamLabel(match.teams.B)}</span></div><div className="match-row-meta">#{match.id} · {formatDate(match.playedAt ?? match.createdAt)}</div></div>
      <div className="match-row-score">{match.format === "sets" ? match.sets.map((set) => `${set.a}:${set.b}`).join(" · ") || "—" : `${match.scoreA} : ${match.scoreB}`}</div>
      <span className={`status-pill ${match.status}`}>{match.status === "completed" ? "Завершено" : "В процесі"}</span><span className="row-arrow">↗</span>
    </button>
  );
}

function MatchesPage({
  matches, filter, setFilter, players, user, csrfToken, onOpenMatch, onCreated, onError,
}: {
  matches: Match[];
  filter: "all" | "in_progress" | "completed";
  setFilter: (filter: "all" | "in_progress" | "completed") => void;
  players: Player[];
  user: User;
  csrfToken: string;
  onOpenMatch: (id: string) => void;
  onCreated: (match: Match) => void;
  onError: (message: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const filtered = useMemo(() => filter === "all" ? matches : matches.filter((match) => match.status === filter), [matches, filter]);
  return (
    <div className="page-stack">
      <div className="page-toolbar"><div><div className="eyebrow">MATCH CENTER</div><p className="muted">Усі матчі клубу, рахунки та історія результатів.</p></div><button className="button primary" onClick={() => setCreating(!creating)}>{creating ? "✕ Закрити" : "＋ Створити матч"}</button></div>
      {creating && <NewMatchForm players={players} csrfToken={csrfToken} onCreated={onCreated} onError={onError} onCancel={() => setCreating(false)} />}
      <div className="filter-tabs">
        {([{ id: "all", label: "Усі матчі" }, { id: "in_progress", label: "В процесі" }, { id: "completed", label: "Завершені" }] as const).map((item) => <button key={item.id} className={filter === item.id ? "selected" : ""} onClick={() => setFilter(item.id)}>{item.label}<span>{item.id === "all" ? matches.length : matches.filter((match) => match.status === item.id).length}</span></button>)}
      </div>
      <div className="panel match-table-panel">
        {filtered.length ? <div className="match-list">{filtered.map((match) => <MatchListItem key={match.id} match={match} onClick={() => onOpenMatch(match.id)} />)}</div> : <EmptyState title="Тут поки порожньо" description="Для цього фільтра немає матчів." />}
      </div>
    </div>
  );
}

function NewMatchForm({
  players, csrfToken, onCreated, onError, onCancel,
}: {
  players: Player[];
  csrfToken: string;
  onCreated: (match: Match) => void;
  onError: (message: string) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [teamA, setTeamA] = useState<string[]>([]);
  const [format, setFormat] = useState<MatchFormat>("sets");
  const [busy, setBusy] = useState(false);
  const togglePlayer = (id: string) => {
    if (selected.includes(id)) {
      setSelected(selected.filter((item) => item !== id));
      setTeamA(teamA.filter((item) => item !== id));
      return;
    }
    if (selected.length < 4) setSelected([...selected, id]);
  };
  const toggleTeamA = (id: string) => setTeamA((current) => {
    if (current.includes(id)) return current.filter((item) => item !== id);
    if (current.length >= 2) return current;
    return [...current, id];
  });
  const submit = async () => {
    setBusy(true);
    try {
      const result = await api<{ match: Match }>("/api/matches", {
        method: "POST", body: { playerIds: selected, teamAIds: teamA, format },
      }, csrfToken);
      onCreated(result.match);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Не вдалося створити матч.");
    } finally { setBusy(false); }
  };
  return (
    <div className="panel create-match-panel">
      <div className="section-heading"><div><div className="eyebrow">NEW MATCH</div><h3>Створити матч</h3></div><span className="step-tag">1 / 2</span></div>
      <div className="form-section"><div className="form-section-title"><strong>1. Обери чотирьох гравців</strong><span>{selected.length}/4 вибрано</span></div>
        <div className="player-select-grid">{players.map((player) => <button type="button" key={player.id} className={`select-player ${selected.includes(player.id) ? "chosen" : ""}`} onClick={() => togglePlayer(player.id)} disabled={!selected.includes(player.id) && selected.length >= 4}><span className="checkbox-look">{selected.includes(player.id) ? "✓" : ""}</span><span className="select-player-name">{player.displayName}</span><small>{player.eloRating} ELO</small></button>)}</div>
      </div>
      <div className="form-section"><div className="form-section-title"><strong>2. Вибери команду A</strong><span>{teamA.length}/2 вибрано</span></div>
        {selected.length < 4 ? <p className="muted small-copy">Спочатку вибери чотирьох гравців.</p> : <div className="team-picker">{selected.map((id) => { const player = players.find((item) => item.id === id)!; return <button key={id} className={`team-picker-item ${teamA.includes(id) ? "team-a" : "team-b"}`} onClick={() => toggleTeamA(id)}><span>{teamA.includes(id) ? "🅰️" : "🅱️"}</span>{player.displayName}<small>{teamA.includes(id) ? "Команда A" : "Команда B"}</small></button>; })}</div>}
        <p className="helper-text">Двоє гравців, яких не вибереш у команду A, автоматично стануть командою B.</p>
      </div>
      <div className="form-section"><div className="form-section-title"><strong>3. Формат матчу</strong></div><div className="format-choice"><button className={format === "sets" ? "active" : ""} onClick={() => setFormat("sets")}><span>🎾</span><strong>Звичайні сети</strong><small>Матч до двох виграних сетів</small></button><button className={format === "americano" ? "active" : ""} onClick={() => setFormat("americano")}><span>⚡</span><strong>Americano</strong><small>Набір очок командою, ціль 24</small></button></div></div>
      <div className="form-actions"><button className="button secondary" onClick={onCancel}>Скасувати</button><button className="button primary" onClick={submit} disabled={busy || selected.length !== 4 || teamA.length !== 2}>{busy ? "Створення…" : "Створити матч →"}</button></div>
    </div>
  );
}

function MatchDetail({
  match, user, csrfToken, onBack, onUpdated, onDeleted, onError,
}: {
  match: Match;
  user: User;
  csrfToken: string;
  onBack: () => void;
  onUpdated: (match: Match) => Promise<void>;
  onDeleted: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [a, setA] = useState("6");
  const [b, setB] = useState("4");
  const [kind, setKind] = useState<SetKind>("set");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const completed = match.status === "completed";
  const winnerName = match.winnerTeam ? match.winnerTeam === "A" ? teamLabel(match.teams.A) : teamLabel(match.teams.B) : null;
  const post = async (url: string, body?: unknown) => {
    setBusy(true);
    try {
      const result = await api<{ match: Match }>(url, { method: "POST", body: body ?? {} }, csrfToken);
      await onUpdated(result.match);
    } catch (error) { onError(error instanceof Error ? error.message : "Не вдалося зберегти рахунок."); }
    finally { setBusy(false); }
  };
  const adjust = (team: Team, delta: -5 | -1 | 1 | 5) => post(`/api/matches/${match.id}/americano/adjust`, { team, delta });
  const addSet = async (event: FormEvent) => {
    event.preventDefault();
    await post(`/api/matches/${match.id}/sets`, { a: Number(a), b: Number(b), kind });
  };
  const deleteLastSet = async () => {
    setBusy(true);
    try {
      const result = await api<{ match: Match }>(`/api/matches/${match.id}/sets/last`, { method: "DELETE" }, csrfToken);
      await onUpdated(result.match);
    } catch (error) { onError(error instanceof Error ? error.message : "Не вдалося видалити сет."); }
    finally { setBusy(false); }
  };
  const deleteMatch = async () => {
    setBusy(true);
    try {
      await api(`/api/matches/${match.id}`, { method: "DELETE" }, csrfToken);
      await onDeleted();
    } catch (error) { onError(error instanceof Error ? error.message : "Не вдалося видалити матч."); }
    finally { setBusy(false); setConfirmDelete(false); }
  };
  const totalSetsA = match.sets.filter((set) => set.a > set.b).length;
  const totalSetsB = match.sets.filter((set) => set.b > set.a).length;
  const canManage = match.canManage;

  return (
    <div className="page-stack">
      <div className="detail-toolbar"><button className="back-link" onClick={onBack}>← До списку матчів</button><div className="detail-toolbar-right"><span className={`status-pill ${match.status}`}>{completed ? "Завершено" : "В процесі"}</span><span className="match-id-tag">МАТЧ #{match.id}</span></div></div>
      <section className="panel match-detail-hero">
        <div className="detail-format"><span>{match.format === "sets" ? "🎾" : "⚡"}</span>{match.format === "sets" ? "Звичайні сети" : "Americano"}<span className="detail-date">{formatDate(match.playedAt ?? match.createdAt)}</span></div>
        <div className="match-scoreboard">
          <div className="score-team"><div className="team-label team-label-a">TEAM A</div><div className="team-members">{match.teams.A.map((player) => <strong key={player.id}>{player.displayName}</strong>)}</div><div className="large-score">{match.format === "sets" ? `${totalSetsA}` : match.scoreA}</div><small>{match.format === "sets" ? "виграні сети" : "очки"}</small></div>
          <div className="versus">VS</div>
          <div className="score-team"><div className="team-label team-label-b">TEAM B</div><div className="team-members">{match.teams.B.map((player) => <strong key={player.id}>{player.displayName}</strong>)}</div><div className="large-score">{match.format === "sets" ? `${totalSetsB}` : match.scoreB}</div><small>{match.format === "sets" ? "виграні сети" : "очки"}</small></div>
        </div>
        {completed && <div className="winner-banner">🏆 {winnerName ? `Перемогла команда: ${winnerName}` : "Нічия"}</div>}
      </section>

      {match.format === "sets" ? (
        <section className="panel score-entry-panel">
          <div className="section-heading"><div><div className="eyebrow">SET SCORE</div><h3>{completed ? "Підсумок матчу" : "Рахунок по сетах"}</h3></div><span className="counter-tag">{match.sets.length} / 3 сети</span></div>
          {match.sets.length ? <div className="sets-table"><div className="sets-table-head"><span>Сет</span><span>Команда A</span><span>Команда B</span><span>Формат</span></div>{match.sets.map((set) => <div className="sets-table-row" key={set.setNumber}><strong>{set.setNumber}</strong><b className={set.a > set.b ? "score-won" : ""}>{set.a}</b><b className={set.b > set.a ? "score-won" : ""}>{set.b}</b><span>{set.kind === "tb" ? "Супер тай-брейк" : "Звичайний"}</span></div>)}</div> : <EmptyState title="Рахунок ще не внесено" description="Додай результат першого сету нижче." />}
          {!completed && canManage && <>
            {match.sets.length > 0 && <button className="text-button danger-text" disabled={busy} onClick={deleteLastSet}>↶ Видалити останній сет</button>}
            {match.sets.length < 3 && !match.winnerTeam && <form className="set-form" onSubmit={addSet}>
              <div className="form-section-title"><strong>Додати наступний сет</strong><span>Команда A · Команда B</span></div>
              <div className="set-input-row"><label>Команда A<input type="number" min="0" max="99" value={a} onChange={(event) => setA(event.target.value)} required /></label><span className="set-colon">:</span><label>Команда B<input type="number" min="0" max="99" value={b} onChange={(event) => setB(event.target.value)} required /></label><label className="kind-select-label">Тип сету<select value={kind} onChange={(event) => setKind(event.target.value as SetKind)} disabled={match.sets.length < 2}><option value="set">Звичайний</option><option value="tb">Супер тай-брейк</option></select></label><button className="button primary" disabled={busy}>＋ Зберегти сет</button></div>
              {match.sets.length < 2 && <p className="helper-text">Супер тай-брейк стане доступним для третього сету.</p>}
            </form>}
          </>}
          {completed && <div className="immutable-note">Результат зафіксовано. ELO оновлено один раз під час завершення матчу.</div>}
        </section>
      ) : (
        <section className="panel score-entry-panel">
          <div className="section-heading"><div><div className="eyebrow">AMERICANO SCORE</div><h3>{completed ? "Фінальний рахунок" : "Лічильник очок"}</h3></div><span className="counter-tag">Ціль: {match.target}</span></div>
          <div className="americano-controls">
            <div className="americano-team team-a-card"><div className="team-label team-label-a">КОМАНДА A</div><div className="americano-team-names">{teamLabel(match.teams.A)}</div><div className="americano-points">{match.scoreA}</div>{!completed && canManage && <ScoreButtons onAdjust={(delta) => adjust("A", delta)} disabled={busy} />}</div>
            <div className="americano-divider"><span>VS</span><small>{match.scoreA + match.scoreB} / {match.target} очок</small><div className="progress-track"><div style={{ width: `${Math.min(100, ((match.scoreA + match.scoreB) / Math.max(1, match.target)) * 100)}%` }} /></div></div>
            <div className="americano-team team-b-card"><div className="team-label team-label-b">КОМАНДА B</div><div className="americano-team-names">{teamLabel(match.teams.B)}</div><div className="americano-points">{match.scoreB}</div>{!completed && canManage && <ScoreButtons onAdjust={(delta) => adjust("B", delta)} disabled={busy} />}</div>
          </div>
          {!completed && canManage && <div className="americano-actions"><button className="button secondary" disabled={busy} onClick={() => post(`/api/matches/${match.id}/americano/reset`)}>↶ Скинути рахунок</button><button className="button primary" disabled={busy || match.scoreA + match.scoreB === 0} onClick={() => post(`/api/matches/${match.id}/americano/complete`)}>🏁 Завершити матч</button></div>}
          {completed && <div className="immutable-note">Матч завершено. Кожен гравець команди отримує кількість командних очок у свою статистику Americano.</div>}
        </section>
      )}
      {match.canDelete && !completed && <div className="delete-match-row">{confirmDelete ? <><span>Видалити незавершений матч без можливості відновлення?</span><button className="button danger" disabled={busy} onClick={deleteMatch}>Так, видалити</button><button className="button secondary" onClick={() => setConfirmDelete(false)}>Скасувати</button></> : <button className="text-button danger-text" onClick={() => setConfirmDelete(true)}>🗑 Видалити незавершений матч</button>}</div>}
      {!canManage && !completed && <div className="immutable-note">Ти можеш переглядати цей матч, але не можеш змінювати рахунок.</div>}
    </div>
  );
}

function ScoreButtons({ onAdjust, disabled }: { onAdjust: (delta: -5 | -1 | 1 | 5) => void; disabled: boolean }) {
  return <div className="score-buttons"><button disabled={disabled} onClick={() => onAdjust(-5)}>−5</button><button disabled={disabled} onClick={() => onAdjust(-1)}>−1</button><button className="plus" disabled={disabled} onClick={() => onAdjust(1)}>+1</button><button className="plus" disabled={disabled} onClick={() => onAdjust(5)}>+5</button></div>;
}

function PlayersPage({ players, user, csrfToken, onRefresh, onError }: {
  players: Player[]; user: User; csrfToken: string; onRefresh: () => Promise<void>; onError: (message: string) => void;
}) {
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [accountPlayer, setAccountPlayer] = useState<Player | null>(null);
  const [accountEmail, setAccountEmail] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const createPlayer = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try {
      await api("/api/players", { method: "POST", body: { displayName: newName } }, csrfToken);
      setNewName(""); await onRefresh();
    } catch (error) { onError(error instanceof Error ? error.message : "Не вдалося додати гравця."); }
    finally { setBusy(false); }
  };
  const createAccount = async (event: FormEvent) => {
    event.preventDefault(); if (!accountPlayer) return; setBusy(true);
    try {
      await api(`/api/players/${accountPlayer.id}/account`, { method: "POST", body: { email: accountEmail, password: accountPassword } }, csrfToken);
      setAccountPlayer(null); setAccountEmail(""); setAccountPassword(""); await onRefresh();
      onError("Доступ до сайту створено. Передай гравцю email і пароль захищеним каналом.");
    } catch (error) { onError(error instanceof Error ? error.message : "Не вдалося створити акаунт."); }
    finally { setBusy(false); }
  };
  return (
    <div className="page-stack">
      <div className="page-toolbar"><div><div className="eyebrow">CLUB ROSTER</div><p className="muted">Гравці, поточний ELO та доступ до вебкабінету.</p></div><span className="total-tag">{players.length} гравців</span></div>
      {user.role === "admin" && <div className="panel admin-add-player"><form onSubmit={createPlayer}><div><div className="eyebrow">ADMIN TOOLS</div><h3>Додати гравця</h3><p className="muted small-copy">Можна створити гравця без акаунта, а потім видати йому доступ.</p></div><div className="inline-form"><input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Ім'я гравця" minLength={2} maxLength={60} required /><button className="button primary" disabled={busy}>＋ Додати</button></div></form></div>}
      {accountPlayer && <div className="panel account-form-panel"><div className="section-heading"><div><div className="eyebrow">ACCOUNT SETUP</div><h3>Доступ для {accountPlayer.displayName}</h3></div><button className="icon-button" onClick={() => setAccountPlayer(null)}>✕</button></div><form className="inline-form" onSubmit={createAccount}><input type="email" placeholder="Email гравця" value={accountEmail} onChange={(event) => setAccountEmail(event.target.value)} required /><input type="password" placeholder="Тимчасовий пароль (12+ символів)" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} minLength={12} maxLength={128} required /><button className="button primary" disabled={busy}>Зберегти доступ</button></form><p className="helper-text">Пароль передай гравцю особисто. Рекомендуй змінити його після першого входу.</p></div>}
      <div className="panel roster-panel"><div className="roster-header"><span>ГРАВЕЦЬ</span><span>РІВЕНЬ</span><span>ELO</span><span>ДОСТУП</span>{user.role === "admin" && <span>ДІЯ</span>}</div>
        {players.map((player, index) => { const rank = rankName(player.eloRating); return <div className="roster-row" key={player.id}><div className="roster-player"><span className="roster-avatar">{player.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{player.displayName}{player.id === user.id && <small className="you-tag">ТИ</small>}</strong><small>Гравець клубу</small></span></div><div className="roster-rank">{rank.emoji} {rank.label}</div><strong className="roster-elo">{player.eloRating}</strong><span><span className={`account-pill ${player.hasAccount ? "has-account" : "no-account"}`}>{player.hasAccount ? "Активний" : "Без акаунта"}</span></span>{user.role === "admin" && <span><button className="text-button" onClick={() => { setAccountPlayer(player); setAccountEmail(""); setAccountPassword(""); }}>{player.hasAccount ? "Оновити доступ" : "Видати доступ"}</button></span>}</div>; })}
      </div>
    </div>
  );
}

function RankingPage({ ranking, currentUserId }: { ranking: RankingRow[]; currentUserId: string }) {
  return (
    <div className="page-stack">
      <div className="page-toolbar"><div><div className="eyebrow">CLUB LEADERBOARD</div><p className="muted">Рейтинг ELO оновлюється після завершення кожного матчу.</p></div><span className="total-tag">{ranking.length} у рейтингу</span></div>
      <div className="podium-grid">{ranking.slice(0, 3).map((player, index) => <div className={`podium-card podium-${index + 1}`} key={player.playerId}><div className="podium-medal">{index === 0 ? "🥇" : index === 1 ? "🥈" : "🥉"}</div><span className="podium-position">#{player.position}</span><strong>{player.displayName}</strong><div className="podium-elo">{player.eloRating}<small> ELO</small></div><span className="podium-rank">{rankName(player.eloRating).emoji} {rankName(player.eloRating).label}</span></div>)}</div>
      <div className="panel ranking-table"><div className="ranking-table-head"><span>#</span><span>ГРАВЕЦЬ</span><span>ELO</span><span>МАТЧІ</span><span>W / D / L</span><span>WIN RATE</span></div>
        {ranking.map((player) => <div className={`ranking-row ${player.playerId === currentUserId ? "current-player" : ""}`} key={player.playerId}><span className={`position position-${player.position}`}>{String(player.position).padStart(2, "0")}</span><div className="ranking-player"><span className="roster-avatar">{player.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{player.displayName}{player.playerId === currentUserId && <small className="you-tag">ТИ</small>}</strong><small>{rankName(player.eloRating).emoji} {rankName(player.eloRating).label}</small></span></div><strong className="ranking-elo">{player.eloRating}</strong><span>{player.played}</span><span className="record-cell"><b>{player.wins}</b> / {player.draws} / <i>{player.losses}</i></span><div className="winrate-cell"><div className="winrate-track"><span style={{ width: `${player.winRate}%` }} /></div><strong>{player.winRate}%</strong></div></div>)}
      </div>
    </div>
  );
}

function StatsPage({ stats, user, matches, onOpenMatch }: { stats: Stats | null; user: User; matches: Match[]; onOpenMatch: (id: string) => void }) {
  const myMatches = matches.filter((match) => match.status === "completed" && match.players.some((player) => player.id === user.id)).slice(0, 10);
  const data = stats ?? { played: 0, wins: 0, draws: 0, losses: 0, winRate: 0, americanoPoints: 0, eloChange: 0 };
  return (
    <div className="page-stack">
      <section className="stats-profile"><div className="stats-avatar">{user.displayName.slice(0, 1).toUpperCase()}</div><div><div className="eyebrow">PLAYER PROFILE</div><h2>{user.displayName}</h2><p>{rankName(user.eloRating).emoji} {rankName(user.eloRating).label} · {user.eloRating} ELO</p></div><div className="stats-elo-change"><span>Зміна ELO за кар'єру</span><strong className={data.eloChange >= 0 ? "positive" : "negative"}>{data.eloChange > 0 ? "+" : ""}{data.eloChange}</strong></div></section>
      <div className="metric-grid stats-metrics"><Metric icon="🎾" label="Матчів" value={data.played} note="Завершено" /><Metric icon="🏆" label="Перемог" value={data.wins} note={`${data.winRate}% win rate`} /><Metric icon="🤝" label="Нічиїх" value={data.draws} note={`${data.losses} поразок`} /><Metric icon="⚡" label="Americano" value={data.americanoPoints} note="Командні очки" /></div>
      <div className="panel recent-panel"><div className="section-heading"><div><div className="eyebrow">MATCH HISTORY</div><h3>Останні завершені матчі</h3></div></div>{myMatches.length ? <div className="match-list">{myMatches.map((match) => <MatchListItem key={match.id} match={match} onClick={() => onOpenMatch(match.id)} />)}</div> : <EmptyState title="Ще немає історії" description="Завершені матчі з'являться тут." />}</div>
    </div>
  );
}

function ProfilePage({ user, csrfToken, onUpdated, onError }: { user: User; csrfToken: string; onUpdated: () => Promise<void>; onError: (message: string) => void }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const saveProfile = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try { await api("/api/auth/profile", { method: "PATCH", body: { displayName, email } }, csrfToken); await onUpdated(); }
    catch (error) { onError(error instanceof Error ? error.message : "Не вдалося оновити профіль."); }
    finally { setBusy(false); }
  };
  const changePassword = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try { await api("/api/auth/change-password", { method: "POST", body: { currentPassword, newPassword } }, csrfToken); setCurrentPassword(""); setNewPassword(""); await onUpdated(); onError("Пароль змінено."); }
    catch (error) { onError(error instanceof Error ? error.message : "Не вдалося змінити пароль."); }
    finally { setBusy(false); }
  };
  return (
    <div className="profile-grid">
      <div className="panel profile-card"><div className="eyebrow">PERSONAL INFORMATION</div><h3>Особисті дані</h3><form className="stacked-form" onSubmit={saveProfile}><label>Ім'я та прізвище<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} minLength={2} maxLength={60} required /></label><label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} /></label><label>Роль<input value={user.role === "admin" ? "Адміністратор" : "Гравець"} disabled /></label><button className="button primary" disabled={busy}>Зберегти зміни</button></form></div>
      <div className="panel profile-card"><div className="eyebrow">ACCOUNT SECURITY</div><h3>Зміна пароля</h3><p className="muted small-copy">Використовуй унікальний пароль довжиною від 12 символів.</p><form className="stacked-form" onSubmit={changePassword}><label>Поточний пароль<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required autoComplete="current-password" /></label><label>Новий пароль<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required minLength={12} maxLength={128} autoComplete="new-password" /></label><button className="button primary" disabled={busy}>Оновити пароль</button></form><div className="security-note">🔒 Сесії зберігаються на сервері. Паролі хешуються Argon2id.</div></div>
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="empty-state"><div className="empty-icon">🎾</div><strong>{title}</strong><p>{description}</p></div>;
}

export default App;
