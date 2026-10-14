# Plan de trabajo para Antigravity

Origen: [AUDITORIA.md](AUDITORIA.md) (2026-10-07). Las reglas que no se negocian están en
[`AGENTS.md`](../../AGENTS.md); este plan nunca las anula.

## Cómo ejecutar este plan

1. **Una fase por rama:** `chore/fase-1-estabilizar`, `chore/fase-2-higiene`, etc., creada
   desde `main` actualizado.
2. **Un commit por tarea**, con el ID en el mensaje (`T1.1: …`). Nunca `git add -A`: se
   añaden solo los ficheros de la tarea.
3. **Ciclo de cada tarea:** el subagente indicado ejecuta → `npm test` (y `npm run test:ui`
   si la tarea toca UI, servidor o tests de UI) → `revisor-proyectos` revisa el diff →
   correcciones → commit → marcar la casilla de la [tabla de seguimiento](#seguimiento).
4. **Puertas:** al terminar cada fase, **parar** y presentar un resumen (qué cambió, salida
   de los tests, riesgos). Las tareas marcadas con ⛔ necesitan el OK del usuario antes de
   empezar.
5. **Nunca** hacer push, abrir o mergear PRs, ni borrar ficheros fuera del alcance de la
   tarea, sin el OK explícito del usuario en el chat.
6. Si un subagente `flash` falla la misma tarea dos veces, repetirla con `pro`. Si sigue
   fallando, parar y preguntar.

---

## Fase 0 · Preparación (sin cambios de código)

### T0.1 · Verificar el entorno

**Subagente:** el agente principal.

1. Comprobar Node ≥ 22.15. En esta máquina Node es portable y **no está en el PATH**:
   en PowerShell, `$env:Path = "$env:LOCALAPPDATA\nodejs;$env:Path"`.
2. PowerShell bloquea `npm.ps1`: usar `npm.cmd` / `npx.cmd`, o Git Bash.
3. `npm.cmd install --no-package-lock --registry=https://registry.npmjs.org` (hasta que se
   complete T1.3).
4. Confirmar que `git status` no tiene cambios propios del proyecto (ver A3).

**Hecho cuando:** `node --version` muestra ≥ 22.15 y las dependencias están instaladas.

### T0.2 · Instalar los subagentes de Antigravity

**Subagente:** el agente principal.

Crear `.agents/agents/<nombre>.md` portando cada `.claude/agents/<nombre>.md`.
**No modificar `.claude/agents/`**: Claude Code los sigue usando.

**Frontmatter de cada subagente:**

```yaml
---
name: <nombre>
description: <la misma descripción, sin mencionar modelos de Claude>
tools: [<ver tabla>]
model: <pro | flash>
subagent: true
mainAgent: false
---
```

| Subagente | `model` | Herramientas | Rol |
| --- | --- | --- | --- |
| `planificador` | pro | lectura | desglosa tareas y asigna subagentes |
| `product-manager` | pro | lectura + escritura (solo `docs/`) | historias y criterios de aceptación |
| `architect-reviewer` | pro | lectura + `run_command` | límites entre módulos y diseño |
| `security-auditor` | pro | solo lectura | auditoría, nunca edita |
| `revisor-proyectos` | pro | lectura + `run_command` | revisa el diff de cada tarea, nunca edita |
| `dev-postava` | flash | lectura + escritura + `run_command` | implementación general |
| `frontend-developer` | flash | lectura + escritura + `run_command` | HTML/CSS/JS del cliente |
| `test-automator` | flash | lectura + escritura + `run_command` | `node:test` y Playwright |
| `refactoring-specialist` | flash | lectura + escritura + `run_command` | refactor sin cambiar comportamiento |
| `performance-engineer` | flash | lectura + escritura + `run_command` | canvas, rAF, memoria de MediaPipe |
| `postgres-pro` | flash | lectura + escritura + `run_command` | SQL y migraciones (nunca DDL al arrancar) |

**Nombres de herramientas.** Usa exactamente los identificadores que tu versión de
Antigravity tenga disponibles. Según la documentación son `view_file`, `grep_search`,
`run_command`, `write_to_file` y `replace_file_content`. Un nombre mal escrito puede
**colgar** el subagente, así que comprueba la lista real de tus herramientas antes de
escribirlos.

**Cuerpo de cada subagente.** Copiar el cuerpo del fichero de Claude y adaptarlo:

- Sustituir "Sonnet" por `flash` y "Opus" por `pro`.
- Sustituir `@agente` por "invoca el subagente `<nombre>`".
- Sustituir `CLAUDE.md` por `AGENTS.md`.
- Añadir al final: «Cumple las reglas de `AGENTS.md`; antes de terminar, ejecuta la
  verificación que indique la tarea y pega su salida resumida».

**Hecho cuando:** existen 11 ficheros en `.agents/agents/`, aparecen en el panel de
agentes (`/agents`) y una invocación de prueba de `revisor-proyectos` (por ejemplo,
«resume `timer.js`») responde sin colgarse.

**Commit:** `T0.2: port subagents to Antigravity (.agents/agents)`.

### T0.3 · Línea base

**Subagente:** `test-automator`.

Ejecutar `npm test` y `npm run test:ui` y anotar los resultados en la tabla de seguimiento.
Lo esperado es 719/719 en unitarios y 8/9 en UI (el fallo es A1). Si sale otra cosa,
**parar e informar**.

### ⛔ Puerta F0

- El usuario confirma que el [PR #2](https://github.com/Roypro5/postava/pull/2) está
  mergeado (A2) y que movió el `.docx` fuera del repo (A3).
- Después: `git checkout main && git pull`.

---

## Fase 1 · Estabilizar

Rama: `chore/fase-1-estabilizar`.

### T1.1 · Arreglar `auth-ui.spec.mjs` › «guest statistics access redirects to sign in» (A1)

**Subagentes:** `test-automator` (ejecuta) y `security-auditor` (revisa).

1. **Confirmar la causa.** Levantar el servidor con las mismas variables que fija
   `playwright.config.mjs` y ejecutar
   `curl -i -H "Sec-Fetch-Dest: document" http://127.0.0.1:<puerto>/stats`. Si la respuesta
   es un 307 hacia `clerk.test.invalid`, la causa queda confirmada.
2. **Arreglar el test, no el servidor.** Está prohibido:
   - quitar Clerk de `/stats`;
   - montar Clerk de forma global;
   - añadir atajos del tipo «si es test, salta la autenticación» en `server.mjs`.

   Opciones válidas, de mejor a peor:
   - En modo mock (`POSTAVA_MOCK_CLERK=1`), interceptar con `page.route` el handshake hacia
     `clerk.test.invalid` y redirigir de vuelta, de modo que el flujo termine en
     `/sign-in?redirect=/stats`.
   - Dividir el caso en dos: una aserción HTTP con `request.get("/stats", { maxRedirects: 0 })`
     que acepte el 307 de handshake o el 302 a `/sign-in`, y una navegación directa a
     `/sign-in?redirect=/stats` que compruebe el formulario.
3. Sin llamadas a Clerk real y sin crear cuentas (regla 7).

**Hecho cuando:** `npm run test:ui` da 9/9 en local y el test sigue comprobando que un
invitado no ve `stats.html`.

**Commit:** `T1.1: fix /stats guest redirect spec under mocked Clerk`.

### T1.2 · Playwright en la CI (A5)

**Subagente:** `dev-postava`.

1. Añadir a `.github/workflows/ci.yml` un job `ui` en paralelo al actual:
   - instalar las dependencias;
   - ejecutar `npx playwright install --with-deps chromium`;
   - ejecutar `npm run test:ui` con `CHROMIUM_PATH` sin definir;
   - subir `playwright-report/` como artefacto solo si falla.
2. Sin secretos de Clerk: los tests usan claves ficticias.
3. Mantener `CLERK_TELEMETRY_DISABLED: "1"`.

**Hecho cuando:** el YAML es válido y el job queda documentado en README › Tests. Se
verifica en la CI al hacer push, que necesita el OK del usuario.

**Commit:** `T1.2: run Playwright specs in CI`.

### ⛔ T1.3 · Lockfile público y reproducible (A4)

**Subagente:** `dev-postava`. **Requiere OK:** puede afectar a Replit.

1. Borrar `node_modules/` y `package-lock.json`.
2. Ejecutar `npm.cmd install --registry=https://registry.npmjs.org`.
3. Comprobar que `grep -c "replit" package-lock.json` da 0.
4. Añadir un `.npmrc` con `registry=https://registry.npmjs.org/`.
5. En la CI, cambiar la instalación a `npm ci`.
6. Quitar `--no-package-lock` de README, `AGENTS.md`, `CLAUDE.md` y `.github/workflows/ci.yml`.

**Hecho cuando:** `npm ci && npm test` pasa desde cero y no queda ninguna referencia a
`--no-package-lock`.

**Commit:** `T1.3: regenerate lockfile against the public npm registry`.

### ⛔ Puerta F1

Presentar el resumen y pedir permiso para hacer push de la rama y abrir el PR.

---

## Fase 2 · Higiene y superficie

Rama: `chore/fase-2-higiene`.

### T2.1 · Quitar `/auth-adapter.js` de la allowlist (A6)

**Subagentes:** `dev-postava` (ejecuta) y `security-auditor` (revisa).

1. Quitar la entrada de `publicFiles` en `server.mjs`.
2. Ajustar los tests que la esperen (`tests/server-public-routes.test.mjs` y otros).
3. Añadir un test: `GET /auth-adapter.js` → 404 y `GET /assets/auth-adapter.bundle.js` → 200.

**Hecho cuando:** `npm test` y `npm run test:ui` siguen en verde.

### T2.2 · ESLint mínimo (A7)

**Subagente:** `refactoring-specialist`.

1. Añadir `eslint` como dependencia de desarrollo y un `eslint.config.mjs` (flat config):
   - globales de navegador para el cliente y de Node para `server/`, `server.mjs` y `tests/`;
   - reglas: `no-unused-vars`, `no-undef`, `eqeqeq` y `no-implicit-globals`.
2. Añadir el script `npm run lint` y un paso `lint` en la CI.
3. **Sin reformatear** el código ni añadir Prettier. Solo se corrigen los errores reales
   que salgan, cada uno con su explicación en el commit.

**Hecho cuando:** `npm run lint` termina con 0 errores y los tests siguen en verde.

### T2.3 · Servir las fuentes desde el propio servidor (A8)

**Subagentes:** `frontend-developer` (ejecuta) y `security-auditor` (revisa la CSP).

1. Descargar los `woff2` de DM Sans (400/500/600/700) y Manrope (600/700/800), subset
   latin, a `assets/fonts/`. Incluir sus licencias OFL en `assets/fonts/LICENSE-OFL.txt`.
2. Sustituir el `@import` de `styles.css` por reglas `@font-face` con `font-display: swap`.
3. Registrar cada fichero en la allowlist de `server.mjs` (regla 5).
4. Quitar `fonts.googleapis.com` y `fonts.gstatic.com` de la CSP
   (`server/security-headers.mjs`) y actualizar sus tests.

**Hecho cuando:**
- Playwright no muestra violaciones de CSP ni peticiones a Google Fonts.
- La interfaz se ve igual. Comparar capturas de `/` en claro y oscuro, antes y después.

### T2.4 · Metadatos de `package.json` (A11)

**Subagente:** `dev-postava`.

- `name: "postava"`.
- Quitar `main`.
- Añadir `"private": true`.
- Licencia: **preguntar al usuario** (MIT, propietaria, …) antes de escribir `license` o
  crear `LICENSE`.

### ⛔ T2.5 · Limpiar restos de Replit (A9)

**Subagente:** `refactoring-specialist`. **Requiere OK:** primero preguntar si el
despliegue sigue en Replit.

- **Sí sigue:** borrar solo `artifacts/` y `attached_assets/`, y `screenshots/` si ningún
  documento las usa.
- **No sigue:** además, `.replit`, `replit.md` y `scripts/post-merge.sh`, y actualizar las
  menciones a Replit en README y `db/README.md`.
- Fusionar lo útil de `.agents/memory/*.md` en `docs/` (`docs/auth-verification.md` u otro
  nuevo) y después borrar `.agents/memory/`.

### T2.6 · Una sola fuente de verdad para la documentación (A10)

**Subagente:** `product-manager`.

- **README:** para personas (instalar, usar, arquitectura).
- **`AGENTS.md`:** reglas para agentes, corto y con enlaces al README.
- **`CLAUDE.md`:** conservar su matriz de subagentes de Claude, sustituir el resto por un
  enlace a `AGENTS.md` y al README, y dejar la regla de que todo cambio de reglas se hace
  primero en `AGENTS.md`.

**Hecho cuando:** ninguna regla no negociable aparece redactada de forma distinta en dos
ficheros.

### ⛔ Puerta F2

Resumen al usuario y permiso para hacer push y abrir el PR.

---

## Fase 3 · Datos y privacidad

### ⛔ T3.1 · Conciliar el esquema (A12)

**Responsable:** el usuario, con ayuda de `postgres-pro`.

1. El usuario ejecuta `pg_dump --schema-only -t posture_stats_sessions` en la base de
   desarrollo y pega la salida.
2. `postgres-pro` la compara con `db/schema.sql` y propone una migración `0002_*.sql` solo
   si hay diferencias.

Nunca DDL al arrancar (regla 6).

### ⛔ T3.2 · Webhook `user.deleted` de Clerk (A13)

**Subagentes:** `architect-reviewer` diseña, `dev-postava` implementa y
`security-auditor` audita.

**Orden:** se ejecuta **después de la [Fase 5](#fase-5--despliegue-sin-replit)**: el
webhook necesita una URL pública a la que Clerk pueda llamar.

1. **Diseño primero**, con aprobación del usuario: ruta `POST /api/webhooks/clerk`,
   verificación de la firma Svix con `CLERK_WEBHOOK_SIGNING_SECRET` y body crudo.
   - No pasa por la cookie de presencia, porque no es una ruta de usuario: documentar por
     qué no viola la regla 4.
   - El `user_id` a borrar sale del evento firmado.
   - Debe ser idempotente.
   - Rate limit.
2. Tests con firmas válidas e inválidas generadas localmente, sin llamar a Clerk.

---

## Fase 4 · Producto (cada punto requiere el OK del usuario)

Antes de cada idea de A14:

1. `product-manager` escribe la historia de usuario y los criterios de aceptación en
   `docs/specs/<idea>.md`.
2. `architect-reviewer` valida el diseño.
3. Se implementa siguiendo el ciclo normal.

Restricciones fijas para todo lo de esta fase:

- **PWA:** el service worker nunca cachea `/api/*` ni `/stats`, y sus ficheros van a la
  allowlist.
- **MediaPipe local:** mantener el `import()` dinámico y el modo «solo temporizador» si
  falla.
- **Exportar CSV:** solo los datos propios, con Clerk + cookie de presencia (regla 4).

---

## Fase 5 · Despliegue sin Replit

Rama: `chore/fase-5-despliegue`. **Se ejecuta antes de T3.2.**

T2.5 quitó los ficheros de Replit, pero nada sustituye lo que Replit daba hecho: el
contenedor Node con HTTPS, la PostgreSQL gestionada, el panel de secretos y la detección de
producción por `REPLIT_DEPLOYMENT`. Postava nunca se publicó en Replit, así que no hay
dominio, usuarios ni datos que migrar.

**Stack elegido (coste 0 €; confirmar los límites en las páginas oficiales de precios antes
de crear las cuentas):**

| Pieza | Elección | Límites y motivo |
| --- | --- | --- |
| Web | Render, *web service* gratuito | HTTPS en `*.onrender.com` y health check. Se duerme tras 15 min sin tráfico y tarda ~1 min en despertar. |
| BD | Neon, plan gratuito | No caduca; ~0,5 GB. **No** usar la PostgreSQL gratuita de Render: se borra a los 30 días. |
| Cuentas | Instancia de **desarrollo** de Clerk (`pk_test`/`sk_test`) | La de producción exige dominio propio y el proxy de Clerk no funciona con instancias de desarrollo. Con `VITE_CLERK_PROXY_URL` vacía, clerk-js habla directo y la CSP ya añade ese host (`clerkFrontendApiOrigin`, `server/security-headers.mjs`). |

**Comprobado en el código:**

- `pg` lee `PGSSLMODE`, así que Neon funciona solo con variables `PG*`, sin tocar `server/stats-store.mjs`.
- `esbuild` está en `dependencies`.
- `server.mjs` da prioridad al puerto pasado como argumento sobre `PORT`. Por eso en Render el arranque es `node server.mjs --production`, **no** `npm run start:prod` (fija el 5000).

### T5.1 · Quitar los restos de Replit del código

**Subagentes:** `refactoring-specialist` (ejecuta) y `revisor-proyectos` (revisa).

1. `server/startup-config.mjs`: quitar la inferencia por `REPLIT_DEPLOYMENT` de
   `applyProductionMode` (solo quedan `--production` y `NODE_ENV`). Quitar sus tests en
   `tests/server-startup.test.mjs` y la fila `REPLIT_DEPLOYMENT` del README.
2. `playwright.config.mjs`: quitar `onReplit` / `REPLIT_DEV_DOMAIN` (`TEST_BASE_URL` ya cubre
   la instancia remota). Ajustar `tests/playwright-config.test.mjs` y los comentarios de
   `tests/auth-ui.spec.mjs`.
3. `tests/node-runtime.test.mjs`: borrar el test de `.replit`, que ahora siempre se omite.
4. Comentarios que citan `replit.md`, que ya no existe (`stats-math.js`,
   `tests/server-clerk-auth.test.mjs`): apuntarlos a `docs/auth-verification.md` o al README.
5. `.claude/agents/dev-postava.md` y `.agents/agents/dev-postava.md`: sustituir la línea que
   manda leer `replit.md` y `.agents/memory/` por `docs/auth-verification.md`. Es el único
   cambio permitido en `.claude/agents/`.

**Hecho cuando:** `git grep -il replit -- . ':!docs/antigravity'` no da resultados y
`npm run lint`, `npm test` y `npm run test:ui` siguen en verde.

**Commit:** `T5.1: remove remaining Replit references from code and tests`.

### T5.2 · Documentación de la base de datos

**Subagente:** `postgres-pro`.

1. `db/README.md`: el servidor solo lee las variables `PG*`; `DATABASE_URL` sirve únicamente
   para lanzar `psql` a mano.
2. README › Variables de entorno: añadir `PGSSLMODE=require` (obligatorio en Neon).
3. `db/README.md`: explicar cómo aplicar `0001_initial.sql` desde el editor SQL de Neon, para
   quien no tenga `psql` instalado.

**Commit:** `T5.2: document PG* variables, PGSSLMODE and applying the schema on Neon`.

### ⛔ T5.3 · Crear la base de datos en Neon

**Responsable:** el usuario, con ayuda de `postgres-pro`. Toca la base real (ver `AGENTS.md`).

1. El usuario crea un proyecto en Neon (PostgreSQL 16, región cercana a la de Render) con
   dos ramas: `production` y `dev`.
2. Pega el bloque *Up* de `db/migrations/0001_initial.sql` en el editor SQL de cada rama.
3. Comprueba las columnas con
   `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'posture_stats_sessions';`
   y las compara con `db/schema.sql`.

Ningún agente ve ni escribe las credenciales; las guarda el usuario.

### T5.4 · Test de integración opcional contra PostgreSQL real

**Subagentes:** `postgres-pro` (ejecuta) y `security-auditor` (revisa el SQL).

Cierra el hueco de `db/README.md` › Límites conocidos: el CTE de `saveSession` nunca se ha
ejecutado contra un PostgreSQL real.

1. Nuevo `tests/stats-store.pg.test.mjs`, que se **omite** salvo con `PG_INTEGRATION=1`
   (la CI y `npm test` no cambian).
2. Usa `createStatsStore` / `createStatsPool` de `server/stats-store.mjs` contra la rama
   `dev` de Neon.
3. Casos:
   - guardar una sesión;
   - un reintento con el mismo id da `duplicate`;
   - el límite diario con sesiones a las 23:59:59 y a las 00:00:00 UTC;
   - `deleteAll`.
4. Usa un `user_id` de prueba propio y borra sus filas al terminar. Sin Clerk (regla 7).

**Hecho cuando:** `PG_INTEGRATION=1 npm test` pasa contra la rama `dev` y `npm test` sin la
variable sigue igual.

**Commit:** `T5.4: add opt-in integration test for stats-store against real PostgreSQL`.

### ⛔ T5.5 · Desplegar en Render

**Responsables:** el usuario (crea la cuenta y pega los secretos) y `dev-postava` (escribe la
configuración y la documentación).

1. **`render.yaml`** (Blueprint):
   - runtime `node`;
   - build `npm ci`;
   - start `node server.mjs --production`;
   - `healthCheckPath: /healthz`;
   - despliegue automático solo desde `main`;
   - las variables secretas van con `sync: false`; ningún valor real va en el repo.
2. **Variables en el panel de Render:**
   - `SESSION_SECRET`, aleatoria (`openssl rand -base64 48`);
   - `CLERK_PUBLISHABLE_KEY` y `CLERK_SECRET_KEY` de la instancia de **desarrollo**;
   - `VITE_CLERK_PROXY_URL` vacía;
   - `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` y `PGPORT` de la rama `production` de Neon, más `PGSSLMODE=require`;
   - `TRUST_PROXY_HOPS`.
3. **`TRUST_PROXY_HOPS`:** verificar el número real de saltos del proxy de Render antes de
   fijarlo, porque el rate limit depende de `req.ip`. Hay que comparar `X-Forwarded-For` con
   la IP propia en una petición de prueba y documentar el resultado.
4. **README:** nueva sección «Despliegue» con el stack, los límites del plan gratuito y el
   arranque en frío.

**Commit:** `T5.5: add Render blueprint and deployment docs`.

### T5.6 · Verificación en el despliegue

**Subagentes:** `test-automator` y `security-auditor`.

1. `GET /healthz` → 200.
2. Pomodoro y cámara sin cuenta (HTTPS, permiso de cámara).
3. Login con Clerk de desarrollo y bloque completado → fila en Neon.
4. En `/stats`:
   - aparece el bloque;
   - «Borrar todas mis estadísticas» lo borra;
   - un invitado es redirigido.
5. Cero violaciones de CSP en la consola; cabeceras HSTS y CSP presentes.
6. `npm run test:ui` con `TEST_BASE_URL=https://<app>.onrender.com`. Con URL remota los specs
   usan el Clerk real, sin crear cuentas ni enviar correos (regla 7).
7. Webhook: desde el panel de Clerk, *Send test event* de `user.deleted` a
   `https://<app>.onrender.com/api/webhooks/clerk` → 200; con una firma inválida → 400.

**Hecho cuando:** todos los puntos se cumplen y los resultados quedan anotados en la tabla de
seguimiento.

### ⛔ T5.7 · (Diferida) Dominio propio y Clerk de producción

Solo cuando se quiera abrir Postava al público.

1. Comprar un dominio (~10 €/año) y apuntarlo a Render.
2. Crear la instancia de producción de Clerk con sus registros DNS.
3. Fijar `VITE_CLERK_PROXY_URL=https://<dominio>/api/__clerk` y cambiar a las claves
   `pk_live`/`sk_live`.
4. Valorar el plan de pago de Render (~7 $/mes) para que el servicio no se duerma.

### ⛔ Puerta F5

Resumen al usuario (URL desplegada, salida de los tests, riesgos) y permiso para hacer push
y abrir el PR.

---

## Seguimiento

| ID | Tarea | Estado | Commit | Notas |
| --- | --- | --- | --- | --- |
| T0.1 | Entorno | ☑ | — | Node 24.21, npm 11.19, dependencias OK, árbol limpio |
| T0.2 | Subagentes en `.agents/agents/` | ☑ | `4ca14ae` | 11 subagentes portados y verificados con revisor-proyectos |
| T0.3 | Línea base de tests | ☑ | — | 719/719 unitarios (~16s), 8/9 UI (~66s, fallo esperado A1) |
| F0 | PR #2 mergeado y `.docx` fuera | ☑ | — | Confirmado por usuario (mergeado en main, docx fuera) |
| T1.1 | Spec `/stats` | ☑ | `8ab3d9e` | Interceptar handshake a clerk.test.invalid hacia /sign-in (9/9 en UI) |
| T1.2 | Playwright en CI | ☑ | `d3f2b80` | Job `ui` con Chromium en GitHub Actions y documentación en README |
| T1.3 | Lockfile público | ☑ | `c0a6271` | Lockfile contra npmjs.org, .npmrc, CI con npm ci y docs limpios |
| F1 | Puerta Fase 1 | ☑ | — | Integrado en PR #3 (chore/fase-2-higiene) |
| T2.1 | Sacar `auth-adapter.js` de la allowlist | ☑ | `9a17bb4` | Eliminado de publicFiles, tests añadidos (404/200 OK) |
| T2.2 | ESLint | ☑ | `954a5e3` | Flat config, globals, script lint, paso CI y 0 errores |
| T2.3 | Fuentes servidas en local | ☑ | `edfa012` | WOFF2 locales, allowlist, CSP estricta 'self', tests OK |
| T2.4 | `package.json` | ☑ | `5de29cb` | name: postava, private: true, sin main, licencia MIT añadida |
| T2.5 | Limpieza de Replit | ☑ | `9eeeb91` | Eliminados restos de Replit y maquetas; memoria a docs/auth-verification.md |
| T2.6 | Documentación única | ☑ | `389d382` | Consolidada en AGENTS.md (fuente única de verdad), enlaces en CLAUDE.md y README |
| F2 | Puerta Fase 2 | ☑ | — | Push de chore/fase-2-higiene y PR #3 abierto |
| T3.1 | Esquema vs `pg_dump` | ☑ | `8ebd0d8` | Opción B de usuario (sin BD previa); esquema 0001_initial fijado como canónico |
| T3.2 | Webhook de Clerk | ☑ | `51c3f56` | Webhook user.deleted verificado con Svix HMAC nativo, idempotente y con rate limit |
| T5.1 | Restos de Replit en el código | ☑ | `9b91c49` | Eliminado REPLIT_DEPLOYMENT/REPLIT_DEV_DOMAIN, tests ajustados y cero referencias |
| T5.2 | Documentación de la BD | ☑ | `5eed775` | Documentadas variables PG*, PGSSLMODE=require y aplicación en Neon web/psql |
| T5.3 | BD en Neon | ☑ | — | Creada en Neon (PG 16, AWS us-east-2), ramas production y dev, esquema 0001_initial verificado |
| T5.4 | Test de integración con PostgreSQL | ☑ | `63a5cc0` | Suite opcional con `PG_INTEGRATION=1` (guardar, duplicados, bordes UTC, límite minutos y deleteAll) |
| T5.5 | Despliegue en Render | ☐ | | ⛔ |
| T5.6 | Verificación del despliegue | ☐ | | |
| T5.7 | Dominio propio y Clerk de producción | ☐ | | ⛔ Diferida |
| F5 | Puerta Fase 5 | ☐ | | ⛔ |
