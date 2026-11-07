import test from "node:test";
import assert from "node:assert/strict";
import { calculateTeamEloDeltas, getSetWinner, validScoreSet } from "../src/server/domain.js";

test("standard padel set score validation", () => {
  assert.equal(validScoreSet({ a: 6, b: 4, kind: "set" }), true);
  assert.equal(validScoreSet({ a: 7, b: 6, kind: "set" }), true);
  assert.equal(validScoreSet({ a: 6, b: 5, kind: "set" }), false);
  assert.equal(validScoreSet({ a: 8, b: 6, kind: "set" }), false);
});

test("super tie-break needs at least 10 points and a two-point lead", () => {
  assert.equal(validScoreSet({ a: 10, b: 8, kind: "tb" }), true);
  assert.equal(validScoreSet({ a: 9, b: 7, kind: "tb" }), false);
  assert.equal(validScoreSet({ a: 11, b: 10, kind: "tb" }), false);
});

test("match is won after two sets; one set each requires a decider", () => {
  assert.equal(getSetWinner([{ a: 6, b: 3, kind: "set" }]), null);
  assert.equal(getSetWinner([{ a: 6, b: 3, kind: "set" }, { a: 4, b: 6, kind: "set" }]), null);
  assert.equal(getSetWinner([{ a: 6, b: 3, kind: "set" }, { a: 4, b: 6, kind: "set" }, { a: 10, b: 8, kind: "tb" }]), "A");
});

test("team ELO is zero-sum for wins, losses and draws", () => {
  for (const winner of ["A", "B", null] as const) {
    const delta = calculateTeamEloDeltas(1050, 950, winner);
    assert.equal(delta.deltaA + delta.deltaB, 0);
  }
  assert.ok(calculateTeamEloDeltas(1050, 950, "A").deltaA > 0);
  assert.ok(calculateTeamEloDeltas(1050, 950, "B").deltaA < 0);
  assert.equal(calculateTeamEloDeltas(1050, 950, null).actualA, 0.5);
});
