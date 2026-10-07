-- Retencion manual: borra sesiones con mas de 400 dias de antiguedad.
-- Ejecutar a mano (p. ej. una vez al mes); no hay tarea programada ni se lanza
-- desde el servidor. Revisa primero cuantas filas afecta:
--   SELECT count(*) FROM posture_stats_sessions
--   WHERE started_at < now() - interval '400 days';
DELETE FROM posture_stats_sessions
WHERE started_at < now() - interval '400 days';
