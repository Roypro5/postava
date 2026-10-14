# Base de datos de Postava

PostgreSQL con una sola tabla, `posture_stats_sessions` (resumen de cada bloque
de enfoque completado por usuario autenticado).

> **Conciliado en T3.1.** `schema.sql` y `migrations/0001_initial.sql` constituyen
> el esquema canónico inicial validado con el código (`server/stats-store.mjs`).
> Si se despliega en una base que ya tiene una tabla previa, compara con
> `pg_dump --schema-only -t posture_stats_sessions` antes de aplicar.

**El DDL nunca se ejecuta al arrancar el servidor** (regla 6 de `AGENTS.md`);
`tests/db-schema.test.mjs` lo vigila. Todo cambio de esquema es un script de
`db/migrations/` aplicado a mano.

## Contenido

| Fichero | Para qué |
| --- | --- |
| `schema.sql` | Estado final del esquema (referencia). |
| `migrations/0001_initial.sql` | Tabla + índice, con bloques Up y Down. |
| `purge-old.sql` | Retención manual: borra sesiones de más de 400 días. |
| `delete-user.sql` | Borrado manual de los datos de un usuario de Clerk eliminado. |

Decisión de índice: `(user_id, started_at)` en vez de `(user_id, created_at DESC)`,
porque las consultas reales (`getStats` y el límite diario) filtran y ordenan por
`started_at`. Postgres recorre un índice ascendente hacia atrás sin coste extra.

## Aplicar en la base de datos de desarrollo

1. Comprueba que las variables `PG*` / `DATABASE_URL` apuntan a la base de **desarrollo**.
2. Si la tabla aún no existe:
   ```sh
   export PGHOST=... PGUSER=... PGPASSWORD=... PGDATABASE=... PGPORT=5432
   psql -v ON_ERROR_STOP=1 -f db/migrations/0001_initial.sql
   # o bien con DATABASE_URL si está definida:
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0001_initial.sql
   ```
   (el fichero contiene el Down comentado; solo se ejecuta el Up).
3. Si ya existe, concilia primero con `pg_dump` (arriba) y no ejecutes el Up.

Revertir (destructivo, borra todas las estadísticas): descomenta y ejecuta el
bloque Down de la migración.

## Límite diario (blando)

Cada usuario puede guardar como máximo **200 sesiones y 1440 minutos sumados por
día UTC de `started_at`**. Pasado el tope, `POST /api/stats/sessions` responde
`422 {"error":"DAILY_LIMIT_REACHED","limit":200}`. Un reintento de una sesión ya
guardada sigue dando 200 aunque el día esté lleno (idempotencia). Se aplica en
una sola sentencia SQL sin advisory lock: dos peticiones simultáneas pueden
rebasar el tope por unas pocas filas. Es un freno anti-abuso, no un invariante.

## Retención

No hay purga automática. Para borrar lo anterior a 400 días:

```sh
psql -v ON_ERROR_STOP=1 -f db/purge-old.sql
```

## Usuario de Clerk eliminado

Hasta que exista un webhook `user.deleted`, el borrado es manual:

```sh
psql -v ON_ERROR_STOP=1 -v user_id="'user_XXXXXXXX'" -f db/delete-user.sql
```

Cada usuario puede además borrar sus propios datos desde `/stats`
(«Borrar todas mis estadísticas», `DELETE /api/stats`).

## Límites conocidos

- El 422 incluye `reason` (`"sessions"` o `"minutes"`) y el `limit` correspondiente (200 o 1440).
- Dos POST simultáneos con el mismo id: el perdedor de `ON CONFLICT` reconsulta con una instantánea nueva y recibe `duplicate` (200).
- Borrado desde `/stats`: la página borra primero la cola local de la cuenta y la cola en memoria del Pomodoro se concilia con `localStorage` antes de enviar o escribir. Un POST que ya iba en vuelo en el momento del borrado puede reinsertar esa fila.
- `getStats` pide `ORDER BY started_at DESC LIMIT` (lo más reciente si se trunca) y reordena en memoria.
- `DELETE /api/stats` registra `[stats] deleteAll { rows }`, sin `user_id`.
- El CTE de `saveSession` no se ha ejecutado contra un PostgreSQL real (no había uno local); los tests usan una base falsa. Conviene probarlo con filas a las 23:59:59 y 00:00:00 UTC antes de publicar.
