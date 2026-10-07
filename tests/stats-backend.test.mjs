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

  assert.deepEqual(Object.keys(stats), ["days", "habitDistribution"]);
  assert.equal(stats.days.length, 1);
  assert.equal(stats.days[0].pomodoros, 2);
  assert.equal(stats.days[0].focusMinutes, 49);
  assert.equal(stats.days[0].correctMinutes, 35);
  assert.equal(stats.days[0].measuredMinutes, 44);
  assert.equal(stats.days[0].sessions[0].score, 75);
  assert.equal(stats.days[0].sessions[0].startedAt, "2025-02-14T09:10:00.000Z");
  assert.equal(stats.days[0].sessions[0].goodMs, 900_000);
  assert.equal(stats.days[0].sessions[0].badMs, 300_000);
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
        if (stored.has(key)) return { rows: [{ inserted: false, existed: true }] };
        stored.set(key, values);
        return { rows: [{ inserted: true, existed: false }] };
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

  assert.equal(await store.saveSession("user-a", validSession), "inserted");
  assert.equal(await store.saveSession("user-a", validSession), "duplicate");
  assert.equal((await store.getStats("user-a")).days.length, 1);
  assert.deepEqual(await store.getStats("user-b"), {
    days: [],
    habitDistribution: [],
  });
  await store.getStats("user-a", 30);
  const reads = queries.filter(({ text }) => text.startsWith("SELECT started_at"));
  assert.deepEqual(reads.map(({ values }) => values[1]), [7, 7, 30]);
  assert.deepEqual(reads.map(({ values }) => values[2]), [1401, 1401, 6001]);
  assert.match(reads[0].text, /LIMIT \$3/);
  assert.match(reads[0].text, /date_trunc\('day'/);

  assert.ok(queries.every(({ values }) => values[0] === "user-a" || values[0] === "user-b"));
  const insert = queries.find(({ text }) => text.includes("INSERT INTO"));
  assert.match(insert.text, /ON CONFLICT \(user_id, session_id\) DO NOTHING/);
  assert.match(insert.text, /\$7::jsonb/);
  assert.match(insert.text, /day\.n < \$10::int/);
  assert.match(insert.text, /day\.m \+ \$4::int <= \$11::int/);
  assert.deepEqual(insert.values.slice(9), [200, 1440]);
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

test("two authenticated handler identities cannot read or retry each other's completed blocks", async () => {
  const rows = new Map();
  const pool = {
    async query(text, values) {
      if (text.includes("INSERT INTO posture_stats_sessions")) {
        const [userId, id, startedAt, durationMinutes, goodMs, badMs, issues, issuesUnit] = values;
        const key = `${userId}:${id}`;
        if (rows.has(key)) return { rows: [{ inserted: false, existed: true }] };
        rows.set(key, {
          userId,
          started_at: startedAt,
          duration_minutes: durationMinutes,
          good_ms: goodMs,
          bad_ms: badMs,
          issues: JSON.parse(issues),
          issues_unit: issuesUnit,
        });
        return { rows: [{ inserted: true, existed: false }] };
      }
      assert.match(text, /WHERE user_id = \$1/);
      return { rows: [...rows.values()].filter((row) => row.userId === values[0]) };
    },
  };
  const handlers = createStatsHandlers({
    store: createStatsStore(pool),
    authenticatedPresence: (req) => req.user ? { userId: req.user } : null,
    requestHasPublicOrigin: () => true,
  });
  const accountA = "user_accountA1";
  const accountB = "user_accountB2";
  const blockA = sessionBody({ expectedUserId: accountA });
  const blockB = sessionBody({
    id: "979073a0-5957-4142-a2ac-48a1d6f8dcbc",
    expectedUserId: accountB,
    durationMinutes: 20,
  });
  const post = async (user, body) => {
    const response = responseStub();
    await handlers.post({ user, body }, response);
    return response;
  };
  const get = async (user) => {
    const response = responseStub();
    await handlers.get({ user, query: { days: "7" } }, response);
    assert.equal(response.statusCode, 200);
    return response.body;
  };

  assert.equal((await post(accountA, blockA)).statusCode, 201);
  assert.equal((await get(accountA)).days[0].pomodoros, 1);
  assert.deepEqual((await get(accountB)).days, []);
  // Simulate an upload whose network response was lost: retrying as B must
  // fail even with the original block ID; retrying as A is idempotent.
  assert.equal((await post(accountB, blockA)).statusCode, 409);
  assert.deepEqual((await get(accountB)).days, []);
  assert.equal((await post(accountA, blockA)).statusCode, 200);
  assert.equal((await get(accountA)).days[0].pomodoros, 1);
  assert.equal((await post(accountB, blockB)).statusCode, 201);
  assert.equal((await get(accountB)).days[0].focusMinutes, 20);
  assert.equal((await get(accountA)).days[0].focusMinutes, 25);
  assert.equal(rows.size, 2);
  assert.equal((await post(accountA, { ...blockA, video: "frames" })).statusCode, 400);
  assert.equal((await post(accountA, { ...blockA, landmarks: [] })).statusCode, 400);
});