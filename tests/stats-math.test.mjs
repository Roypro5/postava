import assert from "node:assert/strict";
import test from "node:test";
import { FATIGUE_BUCKETS, computeFatigue, computeScore, number } from "../stats-math.js";

// Builds an ISO string whose local hour (new Date(...).getHours()) equals
// `hour`, regardless of the machine's timezone running the test.
function isoAtLocalHour(hour, minute = 0) {
  return new Date(2025, 1, 14, hour, minute).toISOString();
}

test("number() clamps to a finite, non-negative value", () => {
  assert.equal(number("12"), 12);
  assert.equal(number(-4), 0);
  assert.equal(number("nope"), 0);
  assert.equal(number(undefined), 0);
});

test("FATIGUE_BUCKETS covers the full 24h day in 2h blocks", () => {
  assert.equal(FATIGUE_BUCKETS.length, 12);
  assert.deepEqual(FATIGUE_BUCKETS[0], { label: "00–02", start: 0 });
  assert.deepEqual(FATIGUE_BUCKETS.at(-1), { label: "22–24", start: 22 });
});

test("computeFatigue no longer discards night/early-morning sessions", () => {
  const days = [{
    sessions: [
      { startedAt: isoAtLocalHour(2), goodMs: 0, badMs: 600_000 },
      { startedAt: isoAtLocalHour(23, 30), goodMs: 900_000, badMs: 0 },
    ],
  }];
  const items = computeFatigue(days);
  assert.equal(items.length, 2);
  const nightBucket = items.find((item) => item.label === "02–04");
  const lateBucket = items.find((item) => item.label === "22–24");
  assert.equal(nightBucket.value, 100);
  assert.equal(lateBucket.value, 0);
});

test("computeFatigue skips buckets with sessions but no measured time", () => {
  const days = [{ sessions: [{ startedAt: isoAtLocalHour(9), goodMs: 0, badMs: 0 }] }];
  assert.deepEqual(computeFatigue(days), []);
});

test("computeFatigue ignores sessions with a missing or invalid startedAt", () => {
  const days = [{ sessions: [
    { startedAt: undefined, goodMs: 100, badMs: 0 },
    { startedAt: "not-a-date", goodMs: 100, badMs: 0 },
  ] }];
  assert.deepEqual(computeFatigue(days), []);
});

test("computeFatigue returns an empty list when there is nothing to show", () => {
  assert.deepEqual(computeFatigue([]), []);
  assert.deepEqual(computeFatigue([{ sessions: [] }]), []);
});

test("computeScore weighs each day by its measured minutes", () => {
  const days = [
    { score: 100, measuredMinutes: 10 },
    { score: 50, measuredMinutes: 30 },
  ];
  // (100*10 + 50*30) / 40 = 62.5 -> rounds to 63.
  assert.equal(computeScore(days), 63);
});

test("computeScore excludes days without a score even if they have measured minutes", () => {
  const days = [
    { score: null, measuredMinutes: 50 },
    { score: 90, measuredMinutes: 10 },
  ];
  assert.equal(computeScore(days), 90);
});

test("computeScore excludes scored days with zero measured minutes", () => {
  const days = [
    { score: 20, measuredMinutes: 0 },
    { score: 80, measuredMinutes: 10 },
  ];
  assert.equal(computeScore(days), 80);
});

test("computeScore returns null when no day has both a score and measured time", () => {
  assert.equal(computeScore([]), null);
  assert.equal(computeScore([{ score: null, measuredMinutes: 20 }]), null);
  assert.equal(computeScore([{ score: 90, measuredMinutes: 0 }]), null);
});
