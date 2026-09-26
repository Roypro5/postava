# Postava

Pomodoro con corrección de postura en tiempo real. Todo se ejecuta en el navegador:
el vídeo **nunca** sale de tu equipo.

## Puesta en marcha

```bash
node server.mjs
```

Abre <http://localhost:5173> y acepta el permiso de cámara.

> **Hace falta servir por `http://`**. Si abres `index.html` con doble clic (`file://`)
> no funcionará: los módulos ES se bloquean por CORS y `getUserMedia` exige un
> contexto seguro (`localhost` y `https://` lo son; `file://` no).
>
> Cualquier servidor estático vale: `npx serve`, la extensión *Live Server* de
> VS Code, `python -m http.server`… `server.mjs` se incluye solo para no depender
> de nada más.

## Librerías por CDN

No hay que instalar nada con `npm`. La única dependencia se carga como módulo ES
desde jsDelivr, en la primera línea de [`app.js`](app.js):

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
| `server.mjs` | servidor estático mínimo |

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
