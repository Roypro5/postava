-- Borrado manual de los datos de un usuario de Clerk eliminado.
-- (Un webhook user.deleted de Clerk que lo automatice queda para mas adelante.)
-- Uso: psql "$DATABASE_URL" -v user_id="'user_XXXXXXXX'" -f db/delete-user.sql
-- El valor entra como literal de psql (:user_id); no lo construyas con texto de terceros.
BEGIN;
SELECT count(*) AS filas_a_borrar FROM posture_stats_sessions WHERE user_id = :user_id;
DELETE FROM posture_stats_sessions WHERE user_id = :user_id;
COMMIT;
