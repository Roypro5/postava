# Postava

Pomodoro con corrección de postura en tiempo real. Todo se ejecuta en el navegador:
el vídeo **nunca** sale de tu equipo.

## Requisitos

- **Node.js >= 22.15** y npm.
- Solo para `npm run test:ui`: Chrome o Chromium instalado (ver [Tests](#tests)).

## Puesta en marcha

```bash
npm install
npm start
```

`npm start` ejecuta `node server.mjs 5000`, así que por defecto la app queda en
<http://localhost:5000> (se puede cambiar con `node server.mjs <puerto>` o con la
variable `PORT`). Acepta el permiso de cámara al abrirla.

Fuera de Replit, el `package-lock.json` apunta al registry interno de Replit y
la instalación falla; usa en su lugar:

```bash
npm install --no-package-lock --registry=https://registry.npmjs.org
```

Al arrancar, `server.mjs` compila con **esbuild** el adaptador de autenticación
(`auth-adapter.js` → `assets/auth-adapter.bundle.js`) antes de levantar el
servidor **Express**. Este sirve únicamente los ficheros de una allowlist (no la
carpeta completa) y expone además el proxy de Clerk y la API de sesión/estadísticas.

> **Hace falta servir por `http://`**. Si abres `index.html` con doble clic (`file://`)
> no funcionará: los módulos ES se bloquean por CORS y `getUserMedia` exige un
> contexto seguro (`localhost` y `https://` lo son; `file://` no).
>
> El Pomodoro y la cámara funcionan siempre sin cuenta; solo las estadísticas
> privadas piden iniciar sesión.

## Librerías: CDN y npm

MediaPipe se sigue cargando como módulo ES desde jsDelivr (no hay que
empaquetarlo ni versionarlo). El resto —Express, Clerk, `pg`, esbuild, las
herramientas de test— sí se instala con `npm install`. La única dependencia
de MediaPipe es un `import()` **dinámico** en [`app.js`](app.js), que se le pasa
a `posture-monitor.js` como función:

```js
mediapipe: () => import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14"),
```

Al ser dinámico, si la CDN falla o está bloqueada solo falla la inicialización
del motor de postura (se muestra «No se pudo cargar el modelo de visión»): el
temporizador sigue funcionando y solo falta la detección de postura. Con un
`import` estático la caída de la CDN habría impedido cargar `app.js` entero.

El `<script>` de [`index.html`](index.html) es de tipo módulo porque `app.js`
importa el resto de módulos locales con `import`:

```html
<script type="module" src="app.js"></script>
```

Se descargan tres cosas, todas cacheadas por el navegador tras la primera visita:

| Recurso | Origen | Tamaño aprox. |
| --- | --- | --- |
| API JS de MediaPipe Tasks | `cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14` | ~90 KB |
| Runtime WASM | `…@0.10.14/wasm` | ~7 MB |
| Modelo `pose_landmarker_lite` | `storage.googleapis.com/mediapipe-models/…` | ~5 MB |

Para usarlo sin conexión, descarga esos ficheros a una carpeta local y cambia
`WASM_BASE` y `MODEL_URL` (constantes exportadas de `posture-monitor.js`) y la
URL del `import()` de MediaPipe en `app.js` por rutas locales. Cada fichero
local nuevo debe registrarse en la allowlist de `server.mjs`: el servidor no
expone carpetas completas.

## Cómo funciona la detección

1. **Calibrar** — se muestra la imagen de la cámara con los puntos que se van a
   medir, etiquetados (*orejas*, *nariz*, *hombros*) y con un halo alrededor.
   Durante 3 s se promedian las métricas y se guardan como referencia (también en
   `localStorage`). Si te mueves mucho durante esos 3 s, la calibración se rechaza
   y hay que repetirla. Al terminar, la imagen desaparece y queda solo el **modo mapa**:
   los puntos y el esqueleto sobre una retícula. Al volver a calibrar se enseña la
   cámara otra vez.
2. **Métricas** — a partir de orejas, ojos, nariz y hombros
   ([`posture.js`](posture.js)), todas normalizadas por el ancho de hombros, así que
   no dependen de tu distancia a la cámara:

   | Métrica | Detecta |
   | --- | --- |
   | `neck` | cabeza hundida entre los hombros (encorvarse) |
   | `width` | acercarse demasiado a la pantalla |
   | `tilt` | hombros desnivelados |
   | `side` | cargar el cuerpo hacia un lado |
   | `chin` | mirar demasiado hacia abajo |
   | `shoulderY` | deslizarse hacia abajo en la silla |

3. **Lectura en pantalla** — sobre la imagen (o sobre el mapa) se dibuja:

   | Elemento | Qué es |
   | --- | --- |
   | Marcadores de escuadra | los 5 puntos que entran en las métricas |
   | `NOSE·00`, `EAR·07`, `SHLD·11`… | el índice real del landmark en MediaPipe |
   | Rombos + línea discontinua | puntos medios de orejas y hombros: el vector que mide `neck` |
   | Puntos tenues | codos, muñecas, caderas y boca; solo contexto, no se miden |
   | Línea `REF·CALIB` | altura de hombros guardada al calibrar |
   | Panel `POSE · LIVE` | porcentaje del umbral consumido por cada métrica, en vivo |

   El panel se apaga en «Ajustes de detección» si distrae; es independiente del
   esqueleto.

4. **Aviso** — si alguna métrica supera su umbral de forma **continuada** durante
   los segundos configurados (5 por defecto), suena un tono suave y aparece un
   mensaje. Se repite cada 20 s mientras sigas mal, y desaparece tras 1 s de
   postura correcta.

Los umbrales base están en `TH` (`posture.js`) y se escalan con el control de
tolerancia de la interfaz. `metricReport()` es la única fuente de verdad: de ahí
leen tanto las alertas (`collectIssues`, en `posture-monitor.js`; `findIssues`
es la versión que crea arrays nuevos) como el panel en vivo (`overlay.js`).

## Cuentas y estadísticas (opcional)

Tener cuenta **no es obligatorio**: el Pomodoro y la corrección de postura
funcionan igual de invitado. Si inicias sesión (vía **Clerk**, gestionado desde
`login.html` / `login.js` / `auth-adapter.js`) puedes guardar estadísticas
privadas por cuenta (`stats.html`, `stats.js`): duración de cada bloque de
enfoque, tiempo con postura medida, conteos de avisos y de incidencias. El
**vídeo y los landmarks nunca salen del navegador**; al servidor solo llegan
esos agregados redondeados, enviados desde `stats-queue.js` (ver
[Notas de diseño](#notas-de-diseño)). `account.js` pinta el botón de acceso o
de cierre de sesión en la cabecera de `index.html`.

Además del token de Clerk, las rutas privadas exigen una **cookie de
presencia** firmada (`server/session-cookie.mjs`), creada al marcar
«Recordarme» y verificada en el servidor junto con la sesión de Clerk — nunca
basta con una de las dos. El ID de usuario para guardar o leer estadísticas
sale siempre de Clerk en el servidor, nunca del navegador.

## Variables de entorno

| Variable | Para qué sirve |
| --- | --- |
| `SESSION_SECRET` | firma la cookie de presencia (`server/session-cookie.mjs`); debe mantenerse estable entre reinicios |
| `TRUST_PROXY_HOPS` | cuántos saltos de proxy inverso confiar (por defecto `1`, como el de Replit) para no dejar que el cliente falsee `X-Forwarded-*` |
| `PORT` | puerto del servidor si no se pasa como argumento (`node server.mjs <puerto>`); por defecto `5000` |
| `CLERK_SECRET_KEY` | clave secreta de Clerk usada por el proxy del servidor |
| `CLERK_PUBLISHABLE_KEY` / `VITE_CLERK_PUBLISHABLE_KEY` | clave pública de Clerk para el cliente |
| `VITE_CLERK_PROXY_URL` | URL del proxy de Clerk que usa el adaptador empaquetado; en producción debe ser `https://<tu-dominio>/api/__clerk`. Si queda vacía, clerk-js habla directamente con el host de la clave pública y la CSP de producción debe permitirlo: comprueba el login con la CSP activa antes de publicar |
| `NODE_ENV` | `production` activa el endurecimiento: CSP aplicada (si no, solo Report-Only), HSTS, proxy de Clerk y comprobaciones fatales de `SESSION_SECRET`. Nada lo fija por sí solo: usa `npm run start:prod` (equivale a `node server.mjs 5000 --production`, portable a Windows) o `NODE_ENV=production`. En un despliegue de Replit (`REPLIT_DEPLOYMENT=1`) sin `NODE_ENV`, el servidor entra en producción y lo avisa en el log; si `NODE_ENV` está definido con otro valor, se respeta y se avisa de que no hay endurecimiento |
| `REPLIT_DEPLOYMENT` | lo define Replit en los despliegues (`1`); solo se lee para decidir el modo producción como se explica arriba |
| `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`/`PGPORT` | conexión de `pg` (`new Pool()` sin argumentos; `DATABASE_URL` no se lee) a la base de datos de estadísticas (`server/stats-store.mjs`, tabla `posture_stats_sessions`) |

Ninguna de estas variables debe imprimirse ni commitearse con su valor real.

## Tests

```bash
npm test        # node --test tests/*.test.mjs
npm run test:ui # Playwright; necesita Chrome/Chromium instalado
```

`npm test` cubre lógica de servidor y estadísticas sin depender del navegador.
También hay tests de los módulos del cliente (`timer`, `camera`,
`posture-monitor`, `stats-queue`…), posibles porque reciben sus dependencias
(reloj, `fetch`, almacenamiento, MediaPipe) por parámetro, y
`tests/public-files.test.mjs` comprueba que todo módulo importado por las
páginas esté en la allowlist de `server.mjs`. `test:ui` levanta la app real con
Playwright para comprobar flujos de interfaz.
Ninguno de los dos debe crear cuentas reales de Clerk ni disparar correos de
verificación o recuperación.

`test:ui` necesita un Chrome/Chromium instalado: usa el indicado en
`CHROMIUM_PATH` o busca Chrome, Edge o Chromium en las rutas habituales; si no
encuentra ninguno, hay que instalar el de Playwright con
`npx playwright install chromium`. Variables (todas opcionales):

| Variable | Para qué sirve |
| --- | --- |
| `TEST_BASE_URL` | URL de una instancia ya levantada; si se define, Playwright no arranca el servidor local ni sustituye Clerk (en Replit se toma de `REPLIT_DEV_DOMAIN`). Solo con una URL local (`localhost`, `127.0.0.1`, `::1`) el navegador ignora el proxy del sistema; con una remota lo respeta |
| `TEST_PORT` | puerto del servidor local que arranca Playwright; por defecto `5000`. Si ya hay algo escuchando en él, `test:ui` falla en vez de reutilizarlo (usa otro puerto o `TEST_REUSE_SERVER=1`) |
| `TEST_REUSE_SERVER` | `1` para reutilizar de forma explícita un servidor local ya levantado en ese puerto; por defecto no se reutiliza, para no ejecutar los specs contra un servidor ajeno (por ejemplo, uno con claves reales) |
| `CHROMIUM_PATH` | ruta al ejecutable de Chrome/Chromium/Edge |
| `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | claves de Clerk de **desarrollo** que se pasan al servidor local (define ambas; nunca de producción). Sin ninguna de las dos se usan valores ficticios y `tests/auth-ui.spec.mjs` sustituye `/api/auth/config` y el bundle del adaptador, porque no hay proveedor real al que llegar. Si defines cualquiera de las dos, o usas `TEST_BASE_URL` o Replit, esa sustitución no se aplica y los tests de `auth-ui.spec.mjs` que abren `login.html` cargan el Clerk real; solo comprueban su inicialización y las validaciones del formulario, sin crear cuentas ni enviar correos. El resto de specs usan siempre un adaptador simulado |
| `SESSION_SECRET` | secreto de la cookie de presencia para ese servidor local; por defecto un valor solo de pruebas |

## Ajustes

- Duración de enfoque y descanso, con atajos de 25/50/60/90 min.
- Tolerancia y segundos de margen antes del aviso.
- Sonido, esqueleto y modo mapa (se activa solo al calibrar; puedes volver a ver
  la imagen desmarcándolo).
- Apagar la cámara automáticamente al pausar o en el descanso.
- Notificaciones del sistema (opcional, desactivadas por defecto): al activar el
  switch el navegador pide permiso y avisa al terminar cada fase y, con la
  pestaña en segundo plano, cuando detecta mala postura. Con la pestaña en
  segundo plano el navegador ralentiza la detección, así que los avisos de
  postura pueden tardar más en llegar.

Atajos: <kbd>Espacio</kbd> iniciar/pausar · <kbd>C</kbd> calibrar.

> **El temporizador no persiste al recargar.** Es intencional: recargar o
> cerrar la pestaña reinicia el Pomodoro a su estado inicial y descarta el
> bloque de enfoque en curso (fase, tiempo restante y minutos acumulados) sin
> guardarlo en las estadísticas. Solo se guardan en `localStorage` los ajustes
> y la calibración (`saveSettings()` en `app.js`, que escribe con `settings.js`
> en la clave `postava.v1`), la preferencia de tema (`postava.theme`) y, con
> cuenta, los bloques ya completados cuyo envío falló
> (`postava.stats.pending.v2:<cuenta>`).

## Depuración

Abre `?debug=1` para exponer `window.postavaDebug` y simular posturas sin cámara,
útil para afinar umbrales:

```js
postavaDebug.forceCamera(true);
postavaDebug.setBaseline({ neck: .75, width: .533, tilt: 0, side: 0, chin: .094, shoulderY: .85 });
postavaDebug.evaluate({ neck: .54, width: .533, tilt: 0, side: 0, chin: .094, shoulderY: .85 }, performance.now());
```

## Ficheros

La página principal es un conjunto de módulos ES pequeños que `app.js` (cerca de
600 líneas) instancia y conecta por callbacks; solo se importan entre sí como
muestra el diagrama de más abajo.

| Fichero | Contenido |
| --- | --- |
| `index.html` | estructura |
| `styles.css` | sistema de interfaz (claro/oscuro automático) |
| `login.css` / `stats.css` | estilos de las pantallas de acceso y de estadísticas |
| `app.js` | punto de entrada y cableado: crea los módulos, conecta sus callbacks (interfaz, sonido, notificaciones, estadísticas, ajustes) y registra los eventos; solo orquesta, sin lógica de dominio (fases, postura, estadísticas) |
| `dom.js` | referencias a los elementos del DOM (`el`, `ctx`), sin lógica; solo lo importa `app.js` |
| `ui.js` | render puro de la interfaz principal (badge, mensajes, cronómetro y aro, chips, estadísticas de sesión, avisos); recibe `el` inyectado y no conoce timer, cámara, postura, estadísticas ni red |
| `timer.js` | máquina de fases enfoque/descanso basada en `endAt`; no conoce DOM, cámara, sonido, estadísticas ni red: solo callbacks |
| `focus-stats.js` | métricas del bloque de enfoque en curso (tiempo, buena/mala postura, avisos, incidencias); sin DOM ni red, con reloj inyectable; `snapshot()` devuelve solo datos agregados |
| `camera.js` | adquisición del stream y ciclo de vida (`start` con cancelación de arranques concurrentes, `stop`, liberación de pistas); devuelve resultados tipificados y no genera texto de interfaz ni toca `document` |
| `camera-utils.js` | utilidades puras e inyectables: espera de metadata del vídeo y vigilancia del evento `ended` de la pista |
| `posture.js` | lógica pura de postura (métricas, umbrales, informe, calibración), sin DOM |
| `posture-monitor.js` | carga de MediaPipe (`WASM_BASE`, `MODEL_URL`), bucle de inferencia, calibración y avisos; no toca el DOM ni hace peticiones propias (el modelo lo descarga MediaPipe), y los landmarks nunca salen de él (solo van a `posture.js` y `overlay.js`; al exterior salen textos, estados y números agregados) |
| `overlay.js` | dibujo del lienzo (esqueleto, panel en vivo, modo mapa, paleta `COLORS`); recibe `ctx` y un objeto de estado, sin DOM ni estado global |
| `sound.js` | tonos con WebAudio, sin ficheros de audio; no conoce DOM, temporizador ni ajustes |
| `notifications.js` | textos y reglas de las notificaciones del sistema (lógica pura) y su efecto `showSystemNotification` con el entorno inyectable; no toca el DOM |
| `settings.js` | lectura y escritura de ajustes en `localStorage` (`postava.v1`); solo datos, sin DOM ni temporizador |
| `stats-session.js` | reglas puras del bloque de enfoque completado: lo vincula a la cuenta al empezar, construye el payload agregado y clasifica los errores de envío (400/409 se descartan; el resto se reintenta) |
| `stats-queue.js` | cola de envío de estadísticas por cuenta, con reintentos; es el único módulo de la página principal que envía datos al servidor de Postava (`POST /api/stats/sessions`), con `fetch`, almacenamiento y bundle de auth inyectados |
| `stats-math.js` | cálculos puros del panel de estadísticas (fatiga por franja horaria, puntuación ponderada), sin DOM |
| `theme-init.js` | aplica el tema guardado antes del primer pintado; se carga síncrono en el `<head>` de las tres páginas. Es externo a propósito: la CSP de producción no permite scripts en línea (no añadas ninguno) |
| `theme.js` | selector de tema claro/automático/oscuro (`postava.theme`); solo presentación |
| `account.js` | botón de acceso o cierre de sesión de la cabecera; un fallo del servicio de cuentas no afecta al temporizador |
| `login.html` / `login.js` | pantallas de acceso, registro y recuperación (Clerk) |
| `stats.html` / `stats.js` | pantalla de estadísticas privadas por cuenta |
| `auth-adapter.js` | adaptador de Clerk para el cliente; se empaqueta con esbuild al arrancar el servidor |
| `server.mjs` | servidor Express: allowlist de estáticos, proxy de Clerk, cookie de presencia y API de sesión/estadísticas |
| `server/` | `session-cookie.mjs` (cookie de presencia firmada), `stats-store.mjs` (estadísticas en PostgreSQL), `security-headers.mjs` (cabeceras de seguridad y CSP), `rate-limit.mjs` (limitador de peticiones en memoria), `middlewares/` (proxy de Clerk) |
| `tests/` | pruebas `node --test` y especificaciones de Playwright |

Todos los ficheros públicos están en la allowlist de `server.mjs`
(`publicFiles`); `stats.html` y `login.html` se sirven por rutas propias
(`/stats` exige sesión; `/sign-in` y `/sign-up`). Un módulo nuevo que no esté en
la allowlist devuelve 404 en el navegador.

### Dependencias entre módulos

Sin ciclos. Las flechas son `import`; `→ …` marca un `import()` dinámico:

```text
index.html
├─ theme-init.js                (síncrono en <head>, sin scripts en línea por la CSP)
├─ theme.js
├─ account.js ───────────► /assets/auth-adapter.bundle.js   (script aparte)
└─ app.js
   ├─ dom.js                       (solo lo importa app.js)
   ├─ timer.js  focus-stats.js  settings.js  sound.js
   ├─ notifications.js  ui.js  stats-session.js
   ├─ camera.js ───────────► camera-utils.js
   ├─ posture-monitor.js ──► posture.js, overlay.js ──► posture.js
   ├─ stats-queue.js ──────► stats-session.js
   ├─ → MediaPipe (jsDelivr)                 lo invoca posture-monitor.js
   └─ → /assets/auth-adapter.bundle.js       lo invoca stats-queue.js

stats.html ─► theme-init.js, theme.js, stats.js ─► stats-math.js, /assets/auth-adapter.bundle.js
login.html ─► theme-init.js, theme.js, login.js ─► /assets/auth-adapter.bundle.js
auth-adapter.js ── esbuild (al arrancar server.mjs) ──► assets/auth-adapter.bundle.js
```

Las dependencias «laterales» no se importan, se inyectan desde `app.js`: por
ejemplo, `posture-monitor.js` recibe por parámetro `timer`, `focusStats` y
`isCameraOn`, y `ui.js` recibe `el`. Por eso la mayoría de los módulos se
prueba con `node --test` sin navegador.

## Notas de diseño

- **Temporizador sin deriva.** `timer.js` no cuenta ticks: guarda `endAt` y en
  cada `tick()` calcula `remaining = max(0, endAt - now())` (`app.js` lo llama
  cada 250 ms). Si la pestaña se ralentiza o el reloj salta, el tiempo restante
  sigue siendo correcto. Al reanudar, `endAt` se recalcula a partir de lo que
  quedaba.
- **Estadísticas por cuenta, con reintentos.** Un bloque de enfoque pertenece a
  la cuenta presente cuando empieza (`bindFocusAccount`), aunque otra pestaña
  cambie de cuenta antes de que termine. `stats-queue.js` guarda los envíos
  pendientes en `localStorage` con una clave por cuenta y los manda de uno en
  uno; los fallos transitorios (red, 5xx, 401) se conservan y se reintentan al
  completar otro bloque, al abrir la página o con el botón «Reintentar», y solo
  se descartan las respuestas 400/409. Una sesión de otra cuenta no se envía
  hasta iniciar sesión con esa cuenta.
- **Cámara con cancelación de arranques concurrentes.** `camera.js` usa un
  contador de generación: `start()` es idempotente mientras hay un arranque en
  curso (las llamadas concurrentes reciben la misma promesa y solo se abre un
  stream) y `stop()` lo cancela, de modo que un `getUserMedia` que llegue tarde
  nunca deja una pista viva ni la luz de la cámara encendida. `start()` devuelve
  un resultado tipificado (`ok`, `unsupported`, `denied`, `metadata-timeout`,
  `cancelled`) y `app.js` decide qué mensaje mostrar; `cancelled` no es un error.
- **Imports dinámicos y tolerantes a fallos.** En `app.js`, tanto MediaPipe como
  el bundle de autenticación se cargan con `import()`: si la CDN falla, solo
  falla `initEngine` (aviso de modelo no disponible); si el bundle de auth falla
  o está bloqueado, `stats-queue.js` lo avisa por consola y sigue en modo
  anónimo. En ambos casos el temporizador funciona. `account.js` importa el
  bundle de forma estática, pero es un script de módulo aparte en `index.html`:
  si falla, no arrastra a `app.js`.

## Sistema de interfaz

Base clara tipo papel con superficies flotantes; la jerarquía la crea la sombra,
no el borde. Todo vive en variables CSS al principio de `styles.css`.

| Token | Uso |
| --- | --- |
| `--paper` / `--surface` | fondo y tarjetas |
| `--ink` / `--muted` | texto principal y secundario |
| `--accent` `--warn` `--bad` | **gráficos**: aro, barra de espera, lienzo |
| `--accent-ink` `--warn-ink` `--bad-ink` | **texto**: las variantes vivas no llegan a 4,5:1 sobre blanco |
| `--on-dark` | elementos sobre el vídeo, que siempre es oscuro |
| `--r-s/m/l`, `--sh-soft/card/btn` | radios y sombras |
| `--ease` | `cubic-bezier(.22,1,.36,1)` para todas las transiciones |

Detalles con los que hay que tener cuidado al tocar los estilos:

- **`[hidden] { display: none !important }`** es obligatorio: las clases con
  `display:flex` ganan a la regla del navegador y el cartel de cámara, la capa de
  calibración y el aviso se verían siempre.
- **`transform: scaleX(-1)`** en el vídeo y el lienzo (`.stage video, .stage
  canvas`) es funcional, no estético: `overlay.js` dibuja el texto del lienzo
  invertido para compensarlo.
- Los nombres `--accent`, `--warn` y `--bad` se referencian desde estilos en
  línea: `ui.js` en el aro del temporizador (`--accent`, `--warn`) y `app.js` en
  la barra de espera (`--warn`, `--bad`). No renombrarlos. El aviso de guardado
  de estadísticas ya no usa estilos en línea: lo estilizan las clases
  `.stats-save-status` y `.stats-save-retry` de `styles.css`, que leen `--bad-ink`,
  `--line`, `--surface` e `--ink`.
- La paleta del lienzo (`COLORS` en `overlay.js`) es aparte a propósito: va
  sobre vídeo oscuro y necesita tonos más luminosos que la interfaz de papel.
