# Postava — Reglas para agentes (Antigravity y otros)

Pomodoro con corrección de postura en tiempo real, en el navegador.

- **Cliente:** Vanilla JS con módulos ES y MediaPipe desde CDN.
- **Servidor:** Express 5 (`server.mjs`).
- **Cuentas:** Clerk, opcional.
- **Base de datos:** PostgreSQL con `pg`.

Para la arquitectura y el mapa de módulos, ver el [README](README.md) (secciones
«Ficheros» y «Dependencias entre módulos»). El trabajo pendiente está en
[`docs/antigravity/PLAN.md`](docs/antigravity/PLAN.md).

## Reglas que no se negocian

1. **Privacidad de la cámara.** El vídeo y los landmarks de MediaPipe nunca salen del
   navegador. Al servidor solo viajan agregados redondeados (duración, porcentajes,
   conteos).
2. **Uso anónimo garantizado.** El temporizador y la detección de postura funcionan sin
   cuenta, sin red hacia Clerk y aunque la CDN falle.
3. **Identidad en el servidor.** El `user_id` sale solo del contexto verificado de Clerk
   en el servidor, nunca de query, params ni body.
4. **Doble validación.** Toda ruta privada exige el token de Clerk **y** la cookie de
   presencia firmada (`SESSION_SECRET`).
5. **Allowlist estricta.** Nunca exponer directorios. Cada fichero público nuevo se
   registra en `publicFiles` de `server.mjs`; `tests/public-files.test.mjs` lo comprueba.
6. **Cero DDL al arrancar.** Los cambios de esquema son scripts de `db/migrations/`
   aplicados a mano.
7. **Tests sin cuentas reales.** Ningún test crea cuentas de Clerk ni envía correos.

**Además:**

- Clerk se monta **ruta a ruta**, nunca con `app.use()` global.
- Sin scripts ni estilos en línea: la CSP de producción los prohíbe.
- Nada de secretos en el código, en los logs ni en los commits.

## Límites entre módulos del cliente

- Sin ciclos de importación. Las dependencias laterales se **inyectan** desde `app.js`;
  `app.js` solo cablea.
- **Sin DOM:** `timer.js`, `posture.js`, `focus-stats.js`, `settings.js`,
  `stats-session.js`, `stats-math.js` y `notifications.js` no tocan el DOM.
- `ui.js` solo pinta: no conoce el temporizador, la cámara ni la red.
- `stats-queue.js` es el **único** módulo de la página principal que envía datos al
  servidor.
- MediaPipe y el bundle de auth se cargan con `import()` dinámico, para que un fallo no
  tumbe el temporizador.

## Entorno (Windows de esta máquina)

- Node ≥ 22.15. Aquí es una instalación portable fuera del PATH: en PowerShell,
  `$env:Path = "$env:LOCALAPPDATA\nodejs;$env:Path"`.
- PowerShell bloquea `npm.ps1`: usar `npm.cmd` / `npx.cmd`, o Git Bash.
- Instalar: `npm.cmd install --no-package-lock --registry=https://registry.npmjs.org`.
  El lockfile apunta a Replit hasta que se complete la tarea T1.3.

## Comandos

| Comando | Qué hace |
| --- | --- |
| `npm start` | servidor en `http://localhost:5000` (requiere `SESSION_SECRET` para las rutas de sesión) |
| `npm test` | `node --test tests/*.test.mjs`, unos 20 s |
| `npm run test:ui` | Playwright; necesita Chrome, Edge o Chromium |
| `npm run start:prod` | modo producción: CSP aplicada, HSTS y comprobaciones fatales |

## Cuándo una tarea está terminada

1. `npm test` en verde, con la salida resumida pegada.
2. `npm run test:ui` en verde si se tocó UI, servidor, CSP o specs.
3. Fichero público nuevo registrado en la allowlist.
4. El README se actualiza si cambia el comportamiento, la configuración o el mapa de
   módulos.
5. Diff revisado por el subagente `revisor-proyectos`, y por `security-auditor` si se
   tocaron auth, cookies, CSP, allowlist o SQL.
6. Un commit por tarea, añadiendo solo los ficheros de la tarea (nunca `git add -A`).

## Lo que exige permiso explícito del usuario

- Hacer push, abrir o mergear PRs.
- Borrar ficheros fuera del alcance de la tarea.
- Cambiar dependencias de producción o la CI.
- Tocar la base de datos real o las claves de Clerk.
- Cualquier tarea marcada con ⛔ en el plan.

## Subagentes

Están en `.agents/agents/` (se crean en la tarea T0.2 del plan, a partir de
`.claude/agents/`):

- **Para pensar, `model: pro`:** `planificador`, `product-manager`, `architect-reviewer`,
  `security-auditor` y `revisor-proyectos`.
- **Para ejecutar, `model: flash`:** `dev-postava`, `frontend-developer`,
  `test-automator`, `refactoring-specialist`, `performance-engineer` y `postgres-pro`.

`.claude/agents/` y `CLAUDE.md` son de Claude Code: no se borran. Si cambia una regla,
se cambia primero aquí.
