-- Postava: esquema de referencia de la base de datos de estadisticas.
--
-- PENDIENTE DE CONCILIAR CON pg_dump DE LA BD REAL: este fichero se DEDUJO del
-- codigo (INSERT/SELECT y limites de validacion de server/stats-store.mjs), no
-- se extrajo de la base de datos. Antes de aplicarlo en una base que ya tenga
-- la tabla, comparalo con `pg_dump --schema-only -t posture_stats_sessions`.
--
-- NUNCA se ejecuta al arrancar el servidor (CLAUDE.md, regla 6). Ver db/README.md.
-- Fuente de verdad del cambio incremental: db/migrations/. Este fichero es el
-- estado resultante tras aplicar todas las migraciones.

CREATE TABLE posture_stats_sessions (
  -- ID de usuario de Clerk, siempre del servidor (nunca del body).
  user_id          text        NOT NULL
                   CHECK (char_length(user_id) BETWEEN 1 AND 160),
  -- UUID generado por el cliente: hace idempotentes los reintentos.
  session_id       uuid        NOT NULL,
  started_at       timestamptz NOT NULL,
  duration_minutes smallint    NOT NULL CHECK (duration_minutes BETWEEN 1 AND 180),
  good_ms          integer     NOT NULL CHECK (good_ms >= 0),
  bad_ms           integer     NOT NULL CHECK (bad_ms >= 0),
  -- {neck, shoulders, tilt, distance}: conteos o milisegundos segun issues_unit.
  issues           jsonb       NOT NULL CHECK (jsonb_typeof(issues) = 'object'),
  issues_unit      text        NOT NULL CHECK (issues_unit IN ('count', 'milliseconds')),
  alerts           integer     NOT NULL CHECK (alerts BETWEEN 0 AND 10000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, session_id),
  CHECK (good_ms + bad_ms <= duration_minutes * 60000)
);

-- Lecturas (getStats) y limite diario (saveSession) filtran por
-- user_id + rango de started_at; getStats ordena por started_at.
CREATE INDEX posture_stats_sessions_user_started_idx
  ON posture_stats_sessions (user_id, started_at);
