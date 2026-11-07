export type Team = "A" | "B";
export type SetKind = "set" | "tb";
export type ScoreSet = { a: number; b: number; kind: SetKind; setNumber?: number };
export type TeamEloDelta = { deltaA: number; deltaB: number; expectedA: number; actualA: number };

/** Validates a standard padel set or a deciding super tie-break. */
export function validScoreSet(score: ScoreSet): boolean {
  const { a, b, kind } = score;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return false;
  if (kind === "tb") return Math.max(a, b) >= 10 && Math.abs(a - b) >= 2;
  return (
    (a === 6 && b <= 4) ||
    (b === 6 && a <= 4) ||
    (a === 7 && (b === 5 || b === 6)) ||
    (b === 7 && (a === 5 || a === 6))
  );
}

/** Best-of-three match winner. A tie after two sets requires a deciding third set. */
export function getSetWinner(sets: ScoreSet[]): Team | null {
  const winsA = sets.filter((set) => set.a > set.b).length;
  const winsB = sets.filter((set) => set.b > set.a).length;
  if (winsA >= 2 && winsA > winsB) return "A";
  if (winsB >= 2 && winsB > winsA) return "B";
  return null;
}

/** Zero-sum team ELO deltas. Every member of a team receives the same delta. */
export function calculateTeamEloDeltas(
  averageA: number,
  averageB: number,
  winner: Team | null,
  kFactor = 32,
): TeamEloDelta {
  const expectedA = 1 / (1 + 10 ** ((averageB - averageA) / 400));
  const actualA = winner === null ? 0.5 : winner === "A" ? 1 : 0;
  const deltaA = Math.round(kFactor * (actualA - expectedA));
  return { deltaA, deltaB: -deltaA, expectedA, actualA };
}
