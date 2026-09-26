# Postava

Pomodoro con corrección de postura en tiempo real. Todo se ejecuta en el navegador:
el vídeo **nunca** sale de tu equipo.

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
de MediaPipe está en la primera línea de [`app.js`](app.js):

```js
import { PoseLandmarker, FilesetResolver }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
```

Y por eso el `<script>` de [`index.html`](index.html) es de tipo módulo:

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
`WASM_BASE` y `MODEL_URL` en `app.js` por rutas relativas.

## Cómo funciona la detección

1. **Calibrar** — se muestra la imagen de la cámara con los puntos que se van a
   medir, etiquetados (*orejas*, *nariz*, *hombros*) y con un halo alrededor.
   Durante 3 s se promedian las métricas y se guardan como referencia (también en
   `localStorage`). Al terminar, la imagen desaparece y queda solo el **modo mapa**:
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
leen tanto las alertas (`findIssues`) como el panel en vivo.

## Cuentas y estadísticas (opcional)

Tener cuenta **no es obligatorio**: el Pomodoro y la corrección de postura
funcionan igual de invitado. Si inicias sesión (vía **Clerk**, gestionado desde
`login.html` / `login.js` / `auth-adapter.js`) puedes guardar estadísticas
privadas por cuenta (`stats.html`, `stats.js`): duración de cada bloque de
enfoque, tiempo con postura medida, conteos de avisos y de incidencias. El
**vídeo y los landmarks nunca salen del navegador**; al servidor solo llegan
esos agregados redondeados.

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
| `VITE_CLERK_PROXY_URL` | URL del proxy de Clerk que usa el adaptador empaquetado |
| `NODE_ENV` | condiciona el comportamiento del proxy de Clerk en producción |
| `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`/`PGPORT` | conexión de `pg` (`new Pool()` sin argumentos; `DATABASE_URL` no se lee) a la base de datos de estadísticas (`server/stats-store.mjs`, tabla `posture_stats_sessions`) |

Ninguna de estas variables debe imprimirse ni commitearse con su valor real.

## Tests

```bash
npm test        # node --test tests/*.test.mjs
npm run test:ui # Playwright; antes hace falta `npx playwright install chromium`
```

`npm test` cubre lógica de servidor y estadísticas sin depender del navegador;
`test:ui` levanta la app real con Playwright para comprobar flujos de interfaz.
Ninguno de los dos debe crear cuentas reales de Clerk ni disparar correos de
verificación o recuperación.

## Ajustes

- Duración de enfoque y descanso, con atajos de 25/50/60/90 min.
- Tolerancia y segundos de margen antes del aviso.
- Sonido, esqueleto y modo mapa (se activa solo al calibrar; puedes volver a ver
  la imagen desmarcándolo).
- Apagar la cámara automáticamente al pausar o en el descanso.

Atajos: <kbd>Espacio</kbd> iniciar/pausar · <kbd>C</kbd> calibrar.

> **El temporizador no persiste al recargar.** Es intencional: recargar o
> cerrar la pestaña reinicia el Pomodoro a su estado inicial y descarta el
> bloque de enfoque en curso (fase, tiempo restante y minutos acumulados) sin
> guardarlo en las estadísticas. Solo se guardan en `localStorage` los ajustes
> y la calibración (`saveSettings()` en `app.js`).

## Depuración

Abre `?debug=1` para exponer `window.postavaDebug` y simular posturas sin cámara,
útil para afinar umbrales:

```js
postavaDebug.forceCamera(true);
postavaDebug.setBaseline({ neck: .75, width: .533, tilt: 0, side: 0, chin: .094, shoulderY: .85 });
postavaDebug.evaluate({ neck: .54, width: .533, tilt: 0, side: 0, chin: .094, shoulderY: .85 }, performance.now());
```

## Ficheros

| Fichero | Contenido |
| --- | --- |
| `index.html` | estructura |
| `styles.css` | sistema de interfaz (claro/oscuro automático) |
| `app.js` | cámara, modelo, temporizador, alertas e interfaz |
| `posture.js` | lógica pura de postura, sin DOM |
| `server.mjs` | servidor Express: allowlist de estáticos, proxy de Clerk, cookie de presencia y API de sesión/estadísticas |
| `login.html` / `login.js` | pantallas de acceso, registro y recuperación (Clerk) |
| `auth-adapter.js` | adaptador de Clerk para el cliente; se empaqueta con esbuild al arrancar el servidor |
| `stats.html` / `stats.js` | pantalla de estadísticas privadas por cuenta |
| `stats-session.js` | registra y reintenta el envío del bloque de enfoque completado |
| `server/` | `session-cookie.mjs` (cookie de presencia firmada), `stats-store.mjs` (estadísticas en PostgreSQL), `middlewares/` (proxy de Clerk) |
| `tests/` | pruebas `node --test` y especificaciones de Playwright |

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
- **`transform: scaleX(-1)`** en `#video` y `#overlay` es funcional, no estético:
  `app.js` dibuja el texto del lienzo invertido para compensarlo.
- Los nombres `--accent`, `--warn` y `--bad` los inyecta `app.js` en estilos en
  línea (aro y barra de espera). No renombrarlos.
- La paleta del lienzo (`COLORS` en `app.js`) es aparte a propósito: va sobre
  vídeo oscuro y necesita tonos más luminosos que la interfaz de papel.
