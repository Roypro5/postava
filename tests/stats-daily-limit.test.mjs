import assert from "node:assert/strict";
import test from "node:test";
import { createStatsHandlers, createStatsStore } from "../server/stats-store.mjs";

// Límite diario (200 sesiones / 1440 min por usuario y día UTC de started_at) y
// borrado total, contra una base falsa que interpreta los parámetros del SQL.
// Sin base de datos, sin red y sin cuentas reales (regla 7 de CLAUDE.md).

const USER = "user_12345678";
const OTHER = "user_87654321";

function utcDay(offsetDays) {
  const d = new Date();
  d.setUTCHours(8, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return d.toISOString();
}
const DAY_A = utcDay(1);
const DAY_B = utcDay(2);
const day = (iso) => iso.slice(0, 10);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const sessionBody = (n, overrides = {}) => ({
  id: uuid(n),
  expectedUserId: USER,
  type: "focus",
  completed: true,
  durationMinutes: 1,
  startedAt: DAY_A,
  goodMs: 0,
  badMs: 0,
  issues: { neck: 0, shoulders: 0, tilt: 0, distance: 0 },
  issuesUnit: "count",
  alerts: 0,
  ...overrides,
});

function responseStub() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function fakeDb({ failDelete = false } = {}) {
  const rows = [];
  const queries = [];
  return {
    rows,
    queries,
    async query(text, values) {
      queries.push({ text, values });
      assert.match(text, /\$1/);
      assert.ok(!text.includes(USER) && !text.includes(OTHER) && !text.includes("0000-4000"), "valores solo por parámetros");
      if (text.includes("INSERT INTO posture_stats_sessions")) {
        const [userId, id, startedAt, minutes, , , , , , maxSessions, maxMinutes] = values;
        const same = rows.filter((r) => r.userId === userId && day(r.startedAt) === day(startedAt));
        const existed = rows.some((r) => r.userId === userId && r.id === id);
        const fits = same.length < maxSessions && same.reduce((sum, r) => sum + r.minutes, 0) + minutes <= maxMinutes;
        const inserted = fits && !existed;
        if (inserted) rows.push({ userId, id, startedAt, minutes });
        return { rows: [{ inserted, existed, day_sessions: same.length }] };
      }
      if (text.startsWith("DELETE FROM posture_stats_sessions")) {
        if (failDelete) throw new Error("database down");
        assert.match(text, /WHERE user_id = \$1/);
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].userId === values[0]) rows.splice(i, 1);
        return { rowCount: before - rows.length, rows: [] };
      }
      if (text.startsWith("SELECT 1 FROM posture_stats_sessions")) {
        return { rows: rows.some((r) => r.userId === values[0] && r.id === values[1]) ? [{ "?column?": 1 }] : [] };
      }
      if (text.includes("FROM posture_stats_sessions")) return { rows: [] };
      throw new Error(`consulta inesperada: ${text}`);
    },
  };
}

function handlersFor(db, { origin = true } = {}) {
  return createStatsHandlers({
    store: createStatsStore(db),
    authenticatedPresence: (req) => (req.user === null ? null : { userId: req.user ?? USER }),
    requestHasPublicOrigin: () => origin,
  });
}

const post = async (handlers, body, user) => {
  const res = responseStub();
  await handlers.post({ body, user }, res);
  return res;
};
const del = async (handlers, req = {}) => {
  const res = responseStub();
  await handlers.deleteAll(req, res);
  return res;
};
const seed = (db, userId, n, startedAt, minutes = 1, from = 1) => {
  for (let i = 0; i < n; i++) db.rows.push({ userId, id: uuid(from + i), startedAt, minutes });
};

test("día lleno por sesiones: 422 DAILY_LIMIT_REACHED con limit 200; la 200ª aún entra", async () => {
  const db = fakeDb();
  const handlers = handlersFor(db);
  seed(db, USER, 199, DAY_A);
  assert.equal((await post(handlers, sessionBody(500))).statusCode, 201);
  const over = await post(handlers, sessionBody(501));
  assert.equal(over.statusCode, 422);
  assert.deepEqual(over.body, { error: "DAILY_LIMIT_REACHED", reason: "sessions", limit: 200 });
  assert.equal(db.rows.length, 200);
});

test("día lleno por minutos: 1440 sumados como máximo", async () => {
  const db = fakeDb();
  const handlers = handlersFor(db);
  seed(db, USER, 8, DAY_A, 180); // 1440 min
  const full = await post(handlers, sessionBody(600));
  assert.equal(full.statusCode, 422);
  assert.deepEqual(full.body, { error: "DAILY_LIMIT_REACHED", reason: "minutes", limit: 1440 });
  assert.equal((await post(handlers, sessionBody(601, { startedAt: DAY_B }))).statusCode, 201);
});

test("reintento idempotente: un duplicado sigue dando 200 aunque el día esté lleno", async () => {
  const db = fakeDb();
  const handlers = handlersFor(db);
  seed(db, USER, 200, DAY_A);
  const retry = await post(handlers, sessionBody(1));
  assert.equal(retry.statusCode, 200);
  assert.deepEqual(retry.body, { saved: true, duplicate: true });
  assert.equal(db.rows.length, 200);
});

test("otro día UTC (201) y otro usuario (201) no se ven afectados por el día lleno", async () => {
  const db = fakeDb();
  const handlers = handlersFor(db);
  seed(db, USER, 200, DAY_A);
  assert.equal((await post(handlers, sessionBody(700, { startedAt: DAY_B }))).statusCode, 201);
  const other = await post(handlers, sessionBody(701, { expectedUserId: OTHER }), OTHER);
  assert.equal(other.statusCode, 201);
});

test("SQL de saveSession: parametrizado y con los topes como parámetros", async () => {
  const db = fakeDb();
  await post(handlersFor(db), sessionBody(1));
  const [{ text, values }] = db.queries;
  assert.match(text, /^WITH day AS/);
  assert.match(text, /ON CONFLICT \(user_id, session_id\) DO NOTHING/);
  assert.match(text, /user_id = \$1::text/);
  assert.equal(values[0], USER);
  assert.deepEqual(values.slice(-2), [200, 1440]);
});

test("DELETE: 403 sin origen público, 401 sin sesión, 400 sin confirmación; ninguno toca la base", async () => {
  const db = fakeDb();
  seed(db, USER, 3, DAY_A);
  const confirm = { confirm: "DELETE_ALL_STATS" };

  assert.equal((await del(handlersFor(db, { origin: false }), { body: confirm })).statusCode, 403);
  assert.equal((await del(handlersFor(db), { body: confirm, user: null })).statusCode, 401);
  for (const body of [undefined, {}, { confirm: "yes" }, { confirm: true }, [confirm], { ...confirm, userId: OTHER }]) {
    const res = await del(handlersFor(db), { body });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: "CONFIRMATION_REQUIRED" });
  }
  assert.equal(db.rows.length, 3);
  assert.equal(db.queries.length, 0);
});

test("DELETE: 200 {deleted:n} solo con las filas del usuario verificado", async () => {
  const db = fakeDb();
  seed(db, USER, 3, DAY_A);
  seed(db, OTHER, 2, DAY_A, 1, 100);
  const res = await del(handlersFor(db), { body: { confirm: "DELETE_ALL_STATS" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { deleted: 3 });
  assert.deepEqual(db.rows.map((r) => r.userId), [OTHER, OTHER]);
  assert.deepEqual(db.queries.at(-1).values, [USER]);
  assert.equal(db.queries.at(-1).text, "DELETE FROM posture_stats_sessions WHERE user_id = $1");
});

test("DELETE: fallo de base de datos da 503 STATS_UNAVAILABLE", async () => {
  const db = fakeDb({ failDelete: true });
  const original = console.error;
  console.error = () => {};
  try {
    const res = await del(handlersFor(db), { body: { confirm: "DELETE_ALL_STATS" } });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: "STATS_UNAVAILABLE" });
  } finally {
    console.error = original;
  }
});

test("getStats avisa si alcanza el tope de filas", async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const row = { started_at: DAY_A, duration_minutes: 1, good_ms: 0, bad_ms: 0, issues: {}, issues_unit: "count" };
    const pool = { query: async (_t, values) => ({ rows: Array.from({ length: values[2] }, () => row) }) };
    await createStatsStore(pool).getStats(USER, 7);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /1401/);
  } finally {
    console.warn = original;
  }
});

test("dos POST simultáneos con el mismo id: el perdedor de ON CONFLICT recibe duplicate (200), no un falso 422", async () => {
  const stored = new Set();
  let calls = 0;
  const pool = {
    async query(text, values) {
      calls++;
      if (text.startsWith("WITH day AS")) {
        // Instantánea previa a la fila del ganador: ni insertó ni la vio.
        stored.add(values[1]);
        return { rows: [{ inserted: false, existed: false, day_sessions: 3 }] };
      }
      assert.match(text, /^SELECT 1 FROM posture_stats_sessions/);
      assert.match(text, /user_id = \$1 AND session_id = \$2::uuid/);
      return { rows: stored.has(values[1]) ? [{}] : [] };
    },
  };
  assert.equal(await createStatsStore(pool).saveSession(USER, { ...sessionBody(1), issues: {} }), "duplicate");
  assert.equal(calls, 2);
});

test("getStats pide lo más reciente (DESC + LIMIT) y entrega los días en orden ascendente", async () => {
  const mk = (iso) => ({ started_at: iso, duration_minutes: 1, good_ms: 0, bad_ms: 0, issues: {}, issues_unit: "count" });
  let sql = "";
  const pool = {
    async query(text) {
      sql = text;
      return { rows: [mk("2026-03-12T08:00:00.000Z"), mk("2026-03-11T08:00:00.000Z")] }; // DESC, como lo devuelve la BD
    },
  };
  const stats = await createStatsStore(pool).getStats(USER, 7);
  assert.match(sql, /ORDER BY started_at DESC\s+LIMIT \$3/);
  assert.deepEqual(stats.days.map((d) => d.date), ["2026-03-11", "2026-03-12"]);
});

test("DELETE registra solo el número de filas, sin user_id", async () => {
  const db = fakeDb();
  seed(db, USER, 2, DAY_A);
  const logs = [];
  const original = console.info;
  console.info = (...args) => logs.push(args);
  try {
    await del(handlersFor(db), { body: { confirm: "DELETE_ALL_STATS" } });
  } finally {
    console.info = original;
  }
  assert.deepEqual(logs, [["[stats] deleteAll", { rows: 2 }]]);
});
