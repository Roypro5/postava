-- 0001_initial: tabla de sesiones de estadisticas de Postava.
-- PENDIENTE DE CONCILIAR CON pg_dump DE LA BD REAL (deducido del codigo).
-- Si la tabla ya existe en tu base, NO apliques el Up: concilia primero con
-- pg_dump y registra esta migracion como ya aplicada (ver db/README.md).

-- ===== Up =====
BEGIN;

CREATE TABLE posture_stats_sessions (
  user_id          text        NOT NULL
                   CHECK (char_length(user_id) BETWEEN 1 AND 160),
  session_id       uuid        NOT NULL,
  started_at       timestamptz NOT NULL,
  duration_minutes smallint    NOT NULL CHECK (duration_minutes BETWEEN 1 AND 180),
  good_ms          integer     NOT NULL CHECK (good_ms >= 0),
  bad_ms           integer     NOT NULL CHECK (bad_ms >= 0),
  issues           jsonb       NOT NULL CHECK (jsonb_typeof(issues) = 'object'),
  issues_unit      text        NOT NULL CHECK (issues_unit IN ('count', 'milliseconds')),
  alerts           integer     NOT NULL CHECK (alerts BETWEEN 0 AND 10000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, session_id),
  CHECK (good_ms + bad_ms <= duration_minutes * 60000)
);

CREATE INDEX posture_stats_sessions_user_started_idx
  ON posture_stats_sessions (user_id, started_at);

COMMIT;

-- ===== Down =====
-- Destructivo: borra todas las estadisticas. Ejecutar solo este bloque.
-- BEGIN;
-- DROP INDEX IF EXISTS posture_stats_sessions_user_started_idx;
-- DROP TABLE IF EXISTS posture_stats_sessions;
-- COMMIT;
