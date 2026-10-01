# Postava — Contrato de Desarrollo y Guía de Agentes

Este archivo es la guía maestra para **Claude Code**. Describe la arquitectura del proyecto, las reglas no negociables y el catálogo de subagentes especializados disponibles en `.claude/agents/` para planear, refactorizar, optimizar y desarrollar nuevas funciones.

---

## 1. Visión y Arquitectura del Proyecto

**Postava** es un Pomodoro con corrección de postura en tiempo real que se ejecuta en el navegador.

- **Frontend:** Vanilla JavaScript con módulos ES nativos (`<script type="module">`), HTML5 semántico y CSS3 moderno con variables. [`app.js`](app.js) ya no es un monolito: es solo el punto de entrada y cableado (cerca de 600 líneas), que instancia los módulos de abajo y conecta sus callbacks.
- **Visión por Computador:** MediaPipe `PoseLandmarker` (`@mediapipe/tasks-vision@0.10.14`) cargado vía CDN (jsDelivr) con `import()` dinámico desde `app.js` (si la CDN falla, el temporizador sigue funcionando) y modelos WASM en cliente.
- **Métricas de Postura:** Calculadas en [`posture.js`](posture.js) (`neck`, `width`, `tilt`, `side`, `chin`, `shoulderY`) normalizadas por el ancho de los hombros.
- **Backend:** Node.js con Express 5 (`server.mjs`). Sirve archivos estáticos con **allowlist**, proxy de Clerk y API de sesiones.
- **Autenticación:** Clerk opcional (`login.html`, `login.js`, `account.js`, `auth-adapter.js`). El adaptador se compila con esbuild al levantar el servidor.
- **Base de Datos:** PostgreSQL con la librería nativa `pg` (`server/stats-store.mjs`).
- **Pruebas:** `node:test` (`tests/*.test.mjs`) y Playwright (`tests/*.spec.mjs`).

### Mapa de módulos del cliente (página principal)

Sin ciclos de importación. Las dependencias laterales no se importan: se inyectan desde `app.js` (por ejemplo, `posture-monitor.js` recibe `timer`, `focusStats` e `isCameraOn`; `ui.js` recibe `el`).

- `dom.js`: referencias a los elementos del DOM (`el`, `ctx`), sin lógica. Solo lo importa `app.js`.
- `ui.js`: render puro de la interfaz; no conoce timer, cámara, postura, estadísticas ni red.
- `timer.js`: máquina de fases enfoque/descanso basada en `endAt` (sin deriva); no conoce DOM, cámara, sonido, estadísticas ni red, solo callbacks.
- `focus-stats.js`: métricas del bloque de enfoque en curso; sin DOM ni red, reloj inyectable.
- `camera.js` + `camera-utils.js`: adquisición y liberación del stream, con cancelación de arranques concurrentes; devuelve resultados tipificados, no genera texto de UI ni toca `document`.
- `posture.js`: lógica pura de métricas, umbrales y calibración; sin DOM ni estado global.
- `posture-monitor.js`: MediaPipe (`WASM_BASE`, `MODEL_URL`), bucle de inferencia, calibración y avisos. No toca DOM ni hace peticiones propias; los landmarks nunca salen de él (solo a `posture.js` y `overlay.js`).
- `overlay.js`: dibujo del canvas (esqueleto, HUD, modo mapa, `COLORS`); recibe `ctx` y estado, sin DOM ni estado global.
- `sound.js`: tonos WebAudio; no conoce DOM, timer ni ajustes.
- `notifications.js`: textos y reglas de las notificaciones del sistema; no toca el DOM (el entorno se inyecta).
- `settings.js`: persistencia de ajustes en `localStorage` (`postava.v1`); sin DOM ni timer.
- `stats-session.js`: reglas puras del bloque completado (cuenta, payload agregado, clasificación de errores de envío).
- `stats-queue.js`: cola de envío por cuenta con reintentos; único módulo de la página principal que envía datos al servidor (`POST /api/stats/sessions`), con dependencias inyectadas.
- `stats-math.js`: cálculos puros del panel de estadísticas (usado por `stats.js`).
- Resto de páginas y cuenta: `theme-init.js` (tema antes del primer pintado, externo y síncrono en el `<head>`: la CSP de producción prohíbe scripts en línea), `theme.js` (tema), `account.js` (botón de sesión en la cabecera), `login.js`, `stats.js` y `auth-adapter.js` (Clerk, se compila a `assets/auth-adapter.bundle.js`).
- Tolerancia a fallos: MediaPipe y el bundle de auth se importan con `import()` dinámico desde `app.js`; si fallan, el temporizador sigue en modo anónimo.
- Todo módulo público nuevo debe registrarse en la allowlist de `server.mjs` (regla 5); `tests/public-files.test.mjs` lo comprueba recorriendo los imports.

---

## 2. Reglas Inquebrantables (Non-Negotiables)

1. **Privacidad de la Cámara:** El vídeo y las coordenadas espaciales de MediaPipe **nunca** salen del navegador. Al servidor solo viajan métricas agregadas y redondeadas (duración, porcentajes, conteos).
2. **Uso Anónimo Garantizado:** El Pomodoro y la detección de postura funcionan siempre sin cuenta. Ninguna funcionalidad principal del temporizador puede exigir inicio de sesión.
3. **Validación de Identidad en Servidor:** El `user_id` de las estadísticas se obtiene exclusivamente del contexto verificado de Clerk en el servidor, **nunca** de querystrings, parámetros o el body del request.
4. **Doble Validación en Rutas Privadas:** Toda ruta privada requiere tanto el token de Clerk como la cookie de presencia firmada (`SESSION_SECRET`).
5. **Allowlist Estricta en Express:** Nunca exponer directorios completos. Si se añade un archivo público nuevo, debe registrarse en la allowlist de `server.mjs`.
6. **Cero DDL en Arranque:** Prohibido crear tablas (`CREATE TABLE`) o alterar esquemas automáticamente al iniciar el servidor en producción.
7. **Pruebas sin Cuentas Reales:** Nunca crear cuentas reales ni disparar correos de verificación durante la ejecución de tests automatizados.

---

## 3. Comandos Habituales

- **Iniciar servidor:** `npm start` (ejecuta `node server.mjs 5000`)
- **Ejecutar tests unitarios:** `npm test` (`node --test tests/*.test.mjs`)
- **Ejecutar tests de UI:** `npm run test:ui` (`playwright test`)
- **Instalar dependencias fuera de Replit:** `npm install --no-package-lock --registry=https://registry.npmjs.org`

---

## 4. Matriz de Subagentes Disponibles (`.claude/agents/`)

Usa o convoca a estos agentes según la naturaleza de la tarea:

### 🧠 Planificación y Arquitectura
- **`@planificador`**: Descompone objetivos complejos en planes atómicos priorizados (P0 a P3), asignando a cada tarea el modelo adecuado (Opus para pensar, Sonnet/Haiku para ejecutar).
- **`@product-manager`**: Define hojas de ruta (roadmaps), historias de usuario y criterios de aceptación verificables a partir de ideas de vibecoding.
- **`@architect-reviewer`**: Evalúa decisiones macro, límites entre módulos, acoplamiento cliente-servidor y reduce la deuda técnica estructural.

### 🛠️ Refactorización y Mejora
- **`@refactoring-specialist`**: Mantiene cohesivos y desacoplados los módulos del cliente (la extracción principal de `app.js` ya está hecha: hoy son cerca de 600 líneas de cableado) y divide cualquier archivo que vuelva a crecer, sin alterar el comportamiento observable.
- **`@performance-engineer`**: Optimiza el bucle de renderizado en Canvas, `requestAnimationFrame`, uso de memoria de MediaPipe/cámara y previene Memory Leaks.
- **`@security-auditor`**: Audita la seguridad de endpoints, cookies de sesión, tokens de Clerk, allowlist y consultas SQL (solo lectura).

### 💻 Desarrollo e Implementación
- **`@dev-postava`**: Desarrollador general del proyecto. Conoce a fondo la integración entre timer, MediaPipe y Clerk.
- **`@frontend-developer`**: Especialista en Vanilla JS (ESM), diseño responsive, ergonomía visual y CSS3.
- **`@postgres-pro`**: Modelado relacional, consultas SQL optimizadas e índices para la persistencia de estadísticas.

### 🧪 Calidad y Pruebas
- **`@test-automator`**: Crea y amplía tests unitarios (`node:test`) y pruebas E2E con Playwright (`tests/*.spec.mjs`).
- **`@revisor-proyectos`**: Revisión crítica de código post-implementación para detectar bugs, casos borde y legibilidad.

---

## 5. Flujo de Trabajo Recomendado (De Vibecoding a Código Robusto)

1. **Antes de construir una función grande:**
   - Invoca a `@product-manager` para aterrizar el requerimiento.
   - Invoca a `@planificador` o `@architect-reviewer` para diseñar la estructura sin romper lo existente.
2. **Durante la implementación:**
   - Si se trata de módulos o UI, usa `@dev-postava` o `@frontend-developer`.
   - Si se divide un archivo grande, usa `@refactoring-specialist`.
3. **Antes de dar por cerrado un cambio:**
   - Añade cobertura con `@test-automator`.
   - Corre `npm test`.
   - Pide revisión a `@revisor-proyectos` o `@security-auditor`.
