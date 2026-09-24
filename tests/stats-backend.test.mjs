import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStats,
  createStatsHandlers,
  createStatsStore,
  validateSessionPayload,
} from "../server/stats-store.mjs";

const sessionBody = (overrides = {}) => ({
  id: "4b2de3a2-e6c2-4f8b-9d01-217e26ec8766",
  expectedUserId: "user_12345678",
  type: "focus",
  completed: true,
  durationMinutes: 25,
  startedAt: new Date().toISOString(),
  goodMs: 900_000,
  badMs: 300_000,
  issues: { neck: 2, shoulders: 1, tilt: 0, distance: 1 },
  issuesUnit: "count",
  alerts: 2,
  ...overrides,
});

function responseStub() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("validates only bounded, aggregated completed focus sessions", () => {
  const accepted = validateSessionPayload(sessionBody());
  assert.equal(accepted.id, "4b2de3a2-e6c2-4f8b-9d01-217e26ec8766");
  assert.equal(accepted.issues.neck, 2);

  for (const invalid of [
    { ...sessionBody(), completed: false },
    { ...sessionBody(), type: "break" },
    { ...sessionBody(), durationMinutes: 181 },
    { ...sessionBody(), goodMs: 1_500_001 },
    { ...sessionBody(), startedAt: "not-a-date" },
    { ...sessionBody(), issues: { neck: 1, landmarks: [1, 2, 3] } },
    { ...sessionBody(), video: "raw-video-data" },
    { ...sessionBody(), issuesUnit: "milliseconds", issues: { neck: 1_500_001 } },
  ]) {
    assert.equal(validateSessionPayload(invalid), null);
  }
});

test("aggregates actual rows into the stats.js response shape", () => {
  const stats = buildStats([
    {
      started_at: "2025-02-14T09:10:00.000Z",
      duration_minutes: 25,
      good_ms: "900000",
      bad_ms: "300000",
      issues: { neck: 200_000, shoulders: 100_000, tilt: 0, distance: 0 },
      issues_unit: "milliseconds",
    },
    {
      started_at: "2025-02-14T10:10:00.000Z",
      duration_minutes: 24,
      good_ms: "1200000",
      bad_ms: "240000",
      issues: { neck: 1, shoulders: 1, tilt: 0, distance: 0 },
      issues_unit: "count",
    },
  ]);

  assert.deepEqual(Object.keys(stats), ["days", "habitDistribution", "fatigue"]);
  assert.equal(stats.days.length, 1);
  assert.equal(stats.days[0].pomodoros, 2);
  assert.equal(stats.days[0].focusMinutes, 49);
  assert.equal(stats.days[0].correctMinutes, 35);
  assert.equal(stats.days[0].measuredMinutes, 44);
  assert.equal(stats.days[0].sessions[0].score, 75);
  assert.deepEqual(stats.fatigue, [
    { label: "08–10", value: 25 },
    { label: "10–12", value: 17 },
  ]);
  assert.equal(stats.habitDistribution.find((habit) => habit.key === "neck").minutes, 5);
});

test("unmonitored sessions remain completed without inventing a posture score", () => {
  const stats = buildStats([{
    started_at: "2025-02-14T09:10:00.000Z",
    duration_minutes: 25,
    good_ms: "0",
    bad_ms: "0",
    issues: { neck: 0, shoulders: 0, tilt: 0, distance: 0 },
    issues_unit: "count",
  }]);
  assert.equal(stats.days[0].pomodoros, 1);
  assert.equal(stats.days[0].score, null);
  assert.equal(stats.days[0].measuredMinutes, 0);
  assert.equal(stats.days[0].sessions[0].score, null);
  assert.deepEqual(stats.fatigue, []);
});

test("store scopes every query by authenticated user and binds values", async () => {
  const queries = [];
  const stored = new Map();
  const pool = {
    async query(text, values) {
      queries.push({ text, values });
      assert.match(text, /\$1/);
      assert.doesNotMatch(text, /user-a|user-b/);
      if (text.includes("INSERT INTO posture_stats_sessions")) {
        const [userId, sessionId] = values;
        const key = `${userId}:${sessionId}`;
        if (stored.has(key)) return { rowCount: 0, rows: [] };
        stored.set(key, values);
        return { rowCount: 1, rows: [{ session_id: sessionId }] };
      }
      const userId = values[0];
      return { rows: userId === "user-a" ? [{
        started_at: "2025-02-14T09:10:00.000Z",
        duration_minutes: 25,
        good_ms: "900000",
        bad_ms: "300000",
        issues: { neck: 200_000, shoulders: 0, tilt: 0, distance: 0 },
        issues_unit: "milliseconds",
      }] : [] };
    },
  };
  const store = createStatsStore(pool);
  const validSession = validateSessionPayload(sessionBody());

  assert.equal(await store.saveSession("user-a", validSession), true);
  assert.equal(await store.saveSession("user-a", validSession), false);
  assert.equal((await store.getStats("user-a")).days.length, 1);
  assert.deepEqual(await store.getStats("user-b"), {
    days: [],
    habitDistribution: [],
    fatigue: [],
  });
  await store.getStats("user-a", 30);
  const reads = queries.filter(({ text }) => text.includes("FROM posture_stats_sessions"));
  assert.deepEqual(reads.map(({ values }) => values[1]), [7, 7, 30]);
  assert.match(reads[0].text, /date_trunc\('day'/);

  assert.ok(queries.every(({ values }) => values[0] === "user-a" || values[0] === "user-b"));
  const insert = queries.find(({ text }) => text.includes("INSERT INTO"));
  assert.match(insert.text, /ON CONFLICT \(user_id, session_id\) DO NOTHING/);
  assert.match(insert.text, /\$7::jsonb/);
  assert.equal(insert.values[1], validSession.id);
  assert.deepEqual(JSON.parse(insert.values[6]), validSession.issues);
});

test("handlers enforce same-origin, account authentication, and explicit DB errors", async () => {
  const store = {
    async getStats() {
      throw new Error("database down");
    },
    async saveSession() {
      throw new Error("database down");
    },
  };
  const handlers = createStatsHandlers({
    store,
    authenticatedPresence: (req) => req.user ? { userId: req.user } : null,
    requestHasPublicOrigin: (req) => req.sameOrigin === true,
  });

  const unauthenticated = responseStub();
  await handlers.get({}, unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);

  const getFailure = responseStub();
  await handlers.get({ user: "account-1" }, getFailure);
  assert.equal(getFailure.statusCode, 503);
  assert.deepEqual(getFailure.body, { error: "STATS_UNAVAILABLE" });

  const crossOrigin = responseStub();
  await handlers.post({ user: "account-1", sameOrigin: false, body: sessionBody() }, crossOrigin);
  assert.equal(crossOrigin.statusCode, 403);

  const unauthenticatedPost = responseStub();
  await handlers.post({ sameOrigin: true, body: sessionBody() }, unauthenticatedPost);
  assert.equal(unauthenticatedPost.statusCode, 401);

  const postFailure = responseStub();
  await handlers.post({ user: "user_12345678", sameOrigin: true, body: sessionBody() }, postFailure);
  assert.equal(postFailure.statusCode, 503);
  assert.deepEqual(postFailure.body, { error: "STATS_UNAVAILABLE" });

  const accountChanged = responseStub();
  await handlers.post({ user: "user_87654321", sameOrigin: true, body: sessionBody() }, accountChanged);
  assert.equal(accountChanged.statusCode, 409);
  assert.deepEqual(accountChanged.body, { error: "ACCOUNT_CHANGED" });
});