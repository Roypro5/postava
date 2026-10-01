import { Pool } from "pg";

const ISSUE_KEYS = ["neck", "shoulders", "tilt", "distance"];
const ISSUE_META = {
  neck: { label: "Cuello adelantado", color: "#c96952" },
  shoulders: { label: "Hombros encorvados", color: "#d4a24c" },
  tilt: { label: "Desnivel de hombros", color: "#709b83" },
  distance: { label: "Distancia inadecuada", color: "#6f8997" },
};
const SESSION_KEYS = new Set([
  "id",
  "expectedUserId",
  "type",
  "completed",
  "durationMinutes",
  "startedAt",
  "goodMs",
  "badMs",
  "issues",
  "issuesUnit",
  "alerts",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function validateSessionPayload(body, now = Date.now()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (Object.keys(body).some((key) => !SESSION_KEYS.has(key))) return null;
  if (
    body.type !== "focus" ||
    body.completed !== true ||
    typeof body.expectedUserId !== "string" ||
    !/^user_[a-zA-Z0-9]{8,128}$/.test(body.expectedUserId) ||
    typeof body.id !== "string" ||
    !UUID_PATTERN.test(body.id) ||
    !Number.isInteger(body.durationMinutes) ||
    body.durationMinutes < 1 ||
    body.durationMinutes > 180 ||
    typeof body.startedAt !== "string" ||
    !ISO_DATE_PATTERN.test(body.startedAt)
  ) {
    return null;
  }

  const startedAtMs = Date.parse(body.startedAt);
  if (
    !Number.isFinite(startedAtMs) ||
    startedAtMs > now + 5 * 60_000 ||
    startedAtMs < now - 90 * 24 * 60 * 60_000
  ) {
    return null;
  }

  const durationMs = body.durationMinutes * 60_000;
  if (
    !Number.isSafeInteger(body.goodMs) ||
    !Number.isSafeInteger(body.badMs) ||
    body.goodMs < 0 ||
    body.badMs < 0 ||
    body.goodMs + body.badMs > durationMs ||
    !Number.isInteger(body.alerts) ||
    body.alerts < 0 ||
    body.alerts > 10_000 ||
    !["count", "milliseconds"].includes(body.issuesUnit) ||
    !body.issues ||
    typeof body.issues !== "object" ||
    Array.isArray(body.issues)
  ) {
    return null;
  }

  if (
    Object.keys(body.issues).some((key) => !ISSUE_KEYS.includes(key)) ||
    ISSUE_KEYS.some((key) => {
      const value = body.issues[key] ?? 0;
      const max = body.issuesUnit === "milliseconds" ? durationMs : 100_000;
      return !Number.isSafeInteger(value) || value < 0 || value > max;
    })
  ) {
    return null;
  }

  return {
    id: body.id.toLowerCase(),
    expectedUserId: body.expectedUserId,
    startedAt: new Date(startedAtMs).toISOString(),
    durationMinutes: body.durationMinutes,
    goodMs: body.goodMs,
    badMs: body.badMs,
    issues: Object.fromEntries(
      ISSUE_KEYS.map((key) => [key, body.issues[key] ?? 0]),
    ),
    issuesUnit: body.issuesUnit,
    alerts: body.alerts,
  };
}

function score(goodMs, badMs) {
  const measuredMs = goodMs + badMs;
  return measuredMs > 0 ? Math.round((goodMs / measuredMs) * 100) : null;
}

function dayLabel(date) {
  const [year, month, day] = date.split("-").map(Number);
  const dateObj = new Date(Date.UTC(year, month - 1, day));
  const weekday = new Intl.DateTimeFormat("es-ES", {
    weekday: "short",
    timeZone: "UTC",
  })
    .format(dateObj)
    .replace(/\.$/, "");
  return `${weekday} ${day}`;
}

export function buildStats(rows) {
  const daysByDate = new Map();
  const issueMilliseconds = Object.fromEntries(ISSUE_KEYS.map((key) => [key, 0]));

  for (const row of rows) {
    const startedAt = new Date(row.started_at);
    const date = startedAt.toISOString().slice(0, 10);
    const durationMinutes = Number(row.duration_minutes);
    const goodMs = Number(row.good_ms);
    const badMs = Number(row.bad_ms);
    const issues =
      typeof row.issues === "string" ? JSON.parse(row.issues) : row.issues;

    let day = daysByDate.get(date);
    if (!day) {
      day = {
        date,
        label: dayLabel(date),
        scoreGoodMs: 0,
        scoreBadMs: 0,
        focusMinutes: 0,
        correctMs: 0,
        measuredMs: 0,
        sessions: [],
      };
      daysByDate.set(date, day);
    }
    day.scoreGoodMs += goodMs;
    day.scoreBadMs += badMs;
    day.focusMinutes += durationMinutes;
    day.correctMs += goodMs;
    day.measuredMs += goodMs + badMs;
    day.sessions.push({
      // Instante completo en ISO/UTC: el cliente lo formatea en hora local
      // (agrupar por día sigue siendo en UTC, ver replit.md).
      startedAt: startedAt.toISOString(),
      minutes: durationMinutes,
      score: score(goodMs, badMs),
      goodMs,
      badMs,
    });

    const issueValues = Object.fromEntries(
      ISSUE_KEYS.map((key) => [key, Number(issues?.[key] ?? 0)]),
    );
    if (row.issues_unit === "milliseconds") {
      for (const key of ISSUE_KEYS) issueMilliseconds[key] += issueValues[key];
    } else {
      const totalCounts = ISSUE_KEYS.reduce(
        (sum, key) => sum + issueValues[key],
        0,
      );
      if (totalCounts > 0) {
        for (const key of ISSUE_KEYS) {
          issueMilliseconds[key] += (badMs * issueValues[key]) / totalCounts;
        }
      }
    }
  }

  const days = [...daysByDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => ({
      date: day.date,
      label: day.label,
      score: score(day.scoreGoodMs, day.scoreBadMs),
      pomodoros: day.sessions.length,
      focusMinutes: day.focusMinutes,
      correctMinutes: Math.round(day.correctMs / 60_000),
      measuredMinutes: Math.round(day.measuredMs / 60_000),
      sessions: day.sessions,
    }));

  const habitDistribution = ISSUE_KEYS.map((key) => ({
    key,
    label: ISSUE_META[key].label,
    minutes: Math.round(issueMilliseconds[key] / 60_000),
    color: ISSUE_META[key].color,
  })).filter((habit) => habit.minutes > 0);

  return { days, habitDistribution };
}

export function createStatsStore(pool) {
  return {
    async getStats(userId, period = 7) {
      const result = await pool.query(
        `SELECT started_at, duration_minutes, good_ms, bad_ms, issues, issues_unit
         FROM posture_stats_sessions
         WHERE user_id = $1
           AND started_at >= (date_trunc('day', NOW() AT TIME ZONE 'UTC') - ($2::int - 1) * INTERVAL '1 day') AT TIME ZONE 'UTC'
           AND started_at < NOW() + INTERVAL '5 minutes'
         ORDER BY started_at ASC`,
        [userId, period],
      );
      return buildStats(result.rows);
    },

    async saveSession(userId, session) {
      const result = await pool.query(
        `INSERT INTO posture_stats_sessions
           (user_id, session_id, started_at, duration_minutes, good_ms, bad_ms,
            issues, issues_unit, alerts)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         ON CONFLICT (user_id, session_id) DO NOTHING
         RETURNING session_id`,
        [
          userId,
          session.id,
          session.startedAt,
          session.durationMinutes,
          session.goodMs,
          session.badMs,
          JSON.stringify(session.issues),
          session.issuesUnit,
          session.alerts,
        ],
      );
      return result.rowCount > 0;
    },
  };
}

// The message of a database error is what tells an operator why the stats
// routes answer 503, but a driver can quote connection details in it. This
// keeps the useful part: the error code (pg SQLSTATE or a system code such as
// ECONNREFUSED), and the first line of the message with any URL (connection
// strings carry credentials) and `password=...`-style assignments redacted,
// capped in length. Never the error object itself: its stack and properties
// are not for the log of a request handler. The pool's own errors (an idle
// client that dies) go through the same function.
//
// A secret assignment is a name that contains password/passwd/pwd/secret/token/
// sslkey (so PGPASSWORD and sslpassword count), an optional closing quote (JSON
// style), `=` or `:`, and a value that is either a quoted string (which may hold
// spaces and escaped quotes) or the next run of non-blank characters.
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /\b([a-z0-9_]*(?:password|passwd|pwd|secret|token|sslkey)[a-z0-9_]*)["']?\s*[=:]\s*(?:"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|\S+)/gi;

export function describeDbError(error) {
  const rawCode = String(error?.code ?? "");
  const code = /^[A-Za-z0-9_]{1,32}$/.test(rawCode) ? rawCode : "";
  const raw =
    typeof error === "string"
      ? error
      : typeof error?.message === "string"
        ? error.message
        : "unknown error";
  const message = raw
    .split("\n", 1)[0]
    .replace(URL_PATTERN, "[redacted-url]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1=[redacted]")
    .slice(0, 200);
  return code ? `[${code}] ${message}` : message;
}

// `sendSessionRequired(req, res)` answers a request that has no session. The
// server passes its own, which tells "nobody is signed in" (401) from "Clerk
// could not be asked" (503); this default is the plain 401.
export function createStatsHandlers({
  store,
  authenticatedPresence,
  requestHasPublicOrigin,
  sendSessionRequired = (_req, res) => res.status(401).json({ error: "SESSION_REQUIRED" }),
}) {
  function getUser(req, res) {
    try {
      const presence = authenticatedPresence(req);
      if (!presence?.userId) {
        sendSessionRequired(req, res);
        return null;
      }
      return presence.userId;
    } catch (error) {
      if (error?.code === "SESSION_SECRET_REQUIRED") {
        res.status(500).json({ error: "SESSION_CONFIGURATION_ERROR" });
        return null;
      }
      throw error;
    }
  }

  return {
    async get(req, res) {
      const userId = getUser(req, res);
      if (!userId) return;
      const period = req.query?.days === undefined ? 7 : Number(req.query.days);
      if (![7, 30].includes(period)) return res.status(400).json({ error: "INVALID_PERIOD" });
      try {
        return res.json(await store.getStats(userId, period));
      } catch (error) {
        console.error("[stats] Database error while reading stats:", describeDbError(error));
        return res.status(503).json({ error: "STATS_UNAVAILABLE" });
      }
    },

    async post(req, res) {
      if (!requestHasPublicOrigin(req)) {
        return res.status(403).json({ error: "UNSAFE_ORIGIN" });
      }
      const userId = getUser(req, res);
      if (!userId) return;
      const session = validateSessionPayload(req.body);
      if (!session) return res.status(400).json({ error: "INVALID_SESSION" });
      if (session.expectedUserId !== userId) {
        return res.status(409).json({ error: "ACCOUNT_CHANGED" });
      }
      try {
        const saved = await store.saveSession(userId, session);
        return res.status(saved ? 201 : 200).json({
          saved: true,
          duplicate: !saved,
        });
      } catch (error) {
        console.error("[stats] Database error while saving a session:", describeDbError(error));
        return res.status(503).json({ error: "STATS_UNAVAILABLE" });
      }
    },
  };
}

function positiveInteger(raw, fallback) {
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Pool limits (the connection itself still comes from the standard PG*
 * variables, as with `new Pool()`). Every value can be overridden from the
 * environment; an unset, non-numeric or non-positive override falls back to
 * the default. No DDL and no session-level settings beyond the timeouts.
 *
 *   DB_POOL_MAX                 connections kept open at most (default 5)
 *   DB_IDLE_TIMEOUT_MS          idle connection is closed after (30 s)
 *   DB_CONNECTION_TIMEOUT_MS    give up waiting for a connection after (5 s)
 *   DB_STATEMENT_TIMEOUT_MS     server aborts a statement running longer (10 s)
 *
 * `query_timeout` is the client-side backstop for a server that stops
 * answering altogether, always a little above the server-side timeout.
 */
export function poolConfig(env = process.env) {
  const statementTimeout = positiveInteger(env.DB_STATEMENT_TIMEOUT_MS, 10_000);
  return {
    max: positiveInteger(env.DB_POOL_MAX, 5),
    idleTimeoutMillis: positiveInteger(env.DB_IDLE_TIMEOUT_MS, 30_000),
    connectionTimeoutMillis: positiveInteger(env.DB_CONNECTION_TIMEOUT_MS, 5_000),
    statement_timeout: statementTimeout,
    query_timeout: statementTimeout + 5_000,
  };
}

export function createStatsPool({ env = process.env, PoolClass = Pool } = {}) {
  const pool = new PoolClass(poolConfig(env));
  // An idle client can fail (database restart, network cut) and pg re-emits
  // that on the pool; with no listener the process would crash on it.
  pool.on?.("error", (error) => {
    console.error("Postgres pool error:", describeDbError(error));
  });
  return pool;
}

const pool = createStatsPool();
export const statsStore = createStatsStore(pool);