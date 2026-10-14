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

## Variables de conexión y el servidor

El servidor de Postava (`server/stats-store.mjs`) utiliza `node-postgres` (`pg`),
el cual lee **exclusivamente** las variables de entorno estándar `PG*`:

- `PGHOST`
- `PGUSER`
- `PGPASSWORD`
- `PGDATABASE`
- `PGPORT` (por defecto `5432`)
- `PGSSLMODE` (debe ser `require` en Neon y en cualquier base de datos gestionada con TLS/SSL)

> **Importante:** El servidor **no lee** `DATABASE_URL`. Esta variable solo sirve
> para herramientas externas o para lanzar `psql` a mano. En producción (por ejemplo,
> en Render), cada variable `PG*` debe configurarse individualmente en el panel.

## Aplicar el esquema (migración `0001_initial.sql`)

### Opción A · Desde el editor SQL web de Neon (sin instalar `psql`)

1. Accede a la consola de Neon (<https://console.neon.tech>) y abre tu proyecto.
2. Selecciona la rama correspondiente (`dev` para desarrollo o `main` para producción).
3. Entra en la pestaña **SQL Editor** del menú lateral.
4. Abre en tu editor el fichero [`db/migrations/0001_initial.sql`](migrations/0001_initial.sql).
5. Copia el bloque **Up** (o todo el contenido del fichero, ya que el bloque Down está comentado).
6. Pégalo en el editor SQL de Neon y pulsa **Run** (o `Ctrl+Enter`).
7. Comprueba la creación de la tabla ejecutando:
   ```sql
   SELECT column_name, data_type
   FROM information_schema.columns
   WHERE table_name = 'posture_stats_sessions';
   ```
   (deben aparecer las 10 columnas definidas en [`db/schema.sql`](schema.sql)).

### Opción B · Desde la terminal con `psql`

1. Comprueba que las variables `PG*` / `DATABASE_URL` apuntan a la base de **desarrollo** o **producción**.
2. Si la tabla aún no existe:
   - **En Bash / Git Bash / macOS / Linux:**
     ```sh
     export PGHOST="..." PGUSER="..." PGPASSWORD="..." PGDATABASE="..." PGPORT="5432" PGSSLMODE="require"
     psql -v ON_ERROR_STOP=1 -f db/migrations/0001_initial.sql
     # o bien con DATABASE_URL si está definida (Neon incluye ?sslmode=require):
     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0001_initial.sql
     ```
   - **En PowerShell (Windows):**
     ```powershell
     $env:PGHOST="..."; $env:PGUSER="..."; $env:PGPASSWORD="..."; $env:PGDATABASE="..."; $env:PGPORT="5432"; $env:PGSSLMODE="require"
     psql -v ON_ERROR_STOP=1 -f db/migrations/0001_initial.sql
     # o bien con DATABASE_URL si está definida:
     psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f db/migrations/0001_initial.sql
     ```
   *(Nota: entrecomilla siempre los valores, especialmente contraseñas con caracteres especiales).*
   (El fichero contiene el Down comentado; solo se ejecuta el Up).
3. Si ya existía una tabla previa, concilia primero con `pg_dump` (arriba) y no ejecutes el Up sin verificar.

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

Postava procesa automáticamente el webhook `user.deleted` de Clerk en
`POST /api/webhooks/clerk` (verificado mediante firma criptográfica Svix con
`CLERK_WEBHOOK_SIGNING_SECRET`), borrando todas las sesiones del usuario de forma
idempotente.

Para borrado manual (fallback o emergencias):

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
