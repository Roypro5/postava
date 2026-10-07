# Auditoría de Postava — 2026-10-07

Estado revisado: rama `refactor/modularizacion-y-endurecimiento` (`6d5e531`), con el
[PR #2](https://github.com/Roypro5/postava/pull/2) abierto contra `main`.

## Resumen

El código está en buen estado. La modularización está hecha (`app.js` ya solo cablea
módulos, unas 650 líneas), los límites entre módulos se respetan y los comprueban tests
(`public-files`, `stats-payload-privacy`, `db-schema`), y el servidor está muy endurecido:
CSP fijada, allowlist, doble validación Clerk + cookie, rate limit, 503 en vez de 401 si
Clerk cae y cierre ordenado.

Lo que falla es el **entorno alrededor del código**: un test de UI roto que nadie ve porque
la CI no corre Playwright, un lockfile que solo funciona dentro de Replit, restos de
Replit en el repositorio y documentación repartida en cinco sitios.

| Verificación | Resultado |
| --- | --- |
| `npm test` (Node 24.21, Windows) | ✅ **719/719** en ~18 s |
| `npm run test:ui` (Playwright, Chrome local) | ❌ **8/9**: falla `auth-ui.spec.mjs:52` |
| CI de GitHub (PR #2) | ✅ verde, pero **solo corre `npm test`** |
| Git | PR #2 abierto y *mergeable*, 8 commits por delante de `origin/main`. El `main` local tiene 2 commits sin subir (`a179ac1`, `d83b093`), que ya van incluidos en el PR |

---

## Hallazgos

Leyenda: 🔴 bloquea o rompe algo · 🟡 riesgo o deuda real · 🟢 mejora · 🔵 producto (decide el dueño).

### 🔴 A1 · Test de UI roto: `guest statistics access redirects to sign in`

- **Síntoma:** `page.goto("/stats")` termina en `net::ERR_NAME_NOT_RESOLVED`
  (`tests/auth-ui.spec.mjs:53`). La última ejecución guardada (`test-results/.last-run.json`)
  ya fallaba, así que no es un fallo intermitente.
- **Causa probable (hay que confirmarla en T1.1):** `/stats` es la única página que pasa
  por `clerkMiddleware` (`server.mjs:498`). Con la clave ficticia de
  `playwright.config.mjs:93` (`pk_test_…`, que decodifica a `clerk.test.invalid`), el SDK
  responde a una navegación sin cookie *dev-browser* con un 307 de *handshake* hacia
  `clerk.test.invalid`, y ese dominio no resuelve. El comentario de `server.mjs:490-497`
  ya describe ese handshake.
- **Por qué nadie lo vio:** la CI no ejecuta `test:ui` (ver A5).

### 🔴 A2 · Trabajo sin integrar en `main`

El PR #2 lleva una semana abierto con la CI en verde. Si se empieza trabajo nuevo antes de
mergearlo, cada rama nueva arrastra ocho commits y los conflictos se acumulan. Además, el
`main` local va por delante de `origin/main`.

### 🔴 A3 · Archivo ajeno sin trackear en la raíz

`Monografia_Exposicion_Cosfimetro_UNFV.docx` no pertenece al proyecto. Basta un
`git add -A` de un agente para que entre en un commit.

### 🟡 A4 · Lockfile atado a Replit

`package-lock.json` tiene 605 URLs de `package-firewall.replit.internal`. Fuera de Replit
hay que instalar con `--no-package-lock`, y por eso la CI y cualquier máquina nueva
resuelven los rangos `^` al día: las instalaciones **no son reproducibles**.

### 🟡 A5 · La CI solo cubre los tests unitarios

`.github/workflows/ci.yml` solo corre `npm test`. Los 9 specs de Playwright (CSP en
producción, Worker en segundo plano, aislamiento de estadísticas por cuenta) no se
ejecutan nunca de forma automática.

### 🟡 A6 · `/auth-adapter.js` expuesto sin necesidad

La allowlist (`server.mjs:476`) sirve el código fuente del adaptador, pero ninguna página
lo importa: todas usan `/assets/auth-adapter.bundle.js`. No contiene secretos, pero es
superficie que sobra y contradice el espíritu de la regla 5.

### 🟡 A7 · Sin linter

No hay ESLint ni equivalente. Las variables sin usar, los globales implícitos o los `==`
solo se detectan en revisión, y ahora van a escribir código agentes distintos.

### 🟡 A8 · Google Fonts con `@import` desde un tercero

`styles.css:2` importa DM Sans y Manrope desde `fonts.googleapis.com`:

- cada visita envía la IP del usuario a Google, lo que choca con el mensaje de privacidad
  de la app;
- obliga a mantener dos hosts más en la CSP;
- encadena peticiones que bloquean el render.

### 🟢 A9 · Restos de Replit y de prototipos

| Ruta | Qué es |
| --- | --- |
| `artifacts/mockup-sandbox/` | un `Dashboard.tsx` de maqueta, no se usa |
| `attached_assets/` | capturas y un prompt pegado |
| `screenshots/` | capturas antiguas |
| `.replit`, `replit.md`, `scripts/post-merge.sh` | configuración de Replit |
| `.agents/memory/` | memoria del agente de Replit (convive con `.agents/` de Antigravity) |

Antes de borrar algo hay que decidir si **el despliegue sigue en Replit**. La base de datos
gestionada está allí (`db/README.md`).

### 🟢 A10 · Documentación duplicada

README, `CLAUDE.md`, `replit.md`, `.agents/memory/` y ahora `AGENTS.md` repiten reglas y el
mapa de módulos. Con dos IDEs agénticos trabajando, se van a desincronizar.

### 🟢 A11 · Metadatos de `package.json`

`name: "workspace"`, `main: "app.js"` (no es una librería), `license: "ISC"` sin fichero
`LICENSE` y `author` vacío.

### 🟢 A12 · Esquema de BD sin conciliar (requiere una persona)

`db/schema.sql` se dedujo del código. Falta compararlo con
`pg_dump --schema-only -t posture_stats_sessions` de la base real. Un agente no tiene
acceso a esa base.

### 🟢 A13 · Borrado de datos al eliminar una cuenta de Clerk

Hoy se hace a mano (`db/delete-user.sql`). Un webhook `user.deleted` firmado (Svix) lo
automatizaría. Es la única deuda de privacidad pendiente.

### 🔵 A14 · Ideas de producto (no son defectos)

- PWA instalable (manifest y service worker que **nunca** cachea `/api/*`).
- MediaPipe y el modelo servidos en local (~12 MB) para funcionar sin conexión.
- Exportar las estadísticas propias a CSV.
- Mantener el temporizador al recargar. Hoy se pierde a propósito y está documentado.

---

## Lo que NO hay que tocar

Esto funciona bien y ya tiene tests. Cualquier plan debe preservarlo:

- La carga dinámica de MediaPipe y del bundle de auth (si fallan, el temporizador sigue).
- `realClerkSession` y el montaje de Clerk **ruta a ruta**, nunca global (`server.mjs:202-263`).
- Respuesta 503 vs 401 cuando Clerk no responde.
- La cola de estadísticas por cuenta (`stats-queue.js`) y `bindFocusAccount`.
- La CSP sin scripts en línea (`theme-init.js` es externo por eso).
