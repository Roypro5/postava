/* Motor y evaluación de postura: carga de MediaPipe, bucle de inferencia,
   calibración y avisos. Sin DOM ni red: `document`, `window`, `fetch` y los
   elementos de `el` NO se usan aquí; todo lo que toca la interfaz sale por
   callbacks inyectados que app.js cablea a ui.js, sound.js y notifications.js.

   PRIVACIDAD: los landmarks y los fotogramas nunca salen de este módulo. Solo
   se pasan a `drawOverlay` (dibujo local en el canvas) y a `computeMetrics`; a
   los callbacks solo llegan textos, estados y números agregados (segundos de
   calibración, fracción de la barra de espera, contadores).

   Qué se queda en app.js (entrelazado con el DOM, se cablea por callbacks):
     - la barra de espera (`holdFill`): el monitor pide `onHold`;
     - la capa de calibración (`calibOverlay`, `calibCount`, `calibHint`,
       `btnCalibrate`, `stage.dataset.calibrating`): `onCalibration*`;
     - la decisión de mostrar la notificación del sistema (`document.hidden`,
       permiso, interruptor): `onNotify`;
     - el modo mapa y el guardado de ajustes tras calibrar: `onCalibrated`;
     - startCamera/stopCamera (getUserMedia + textos de la UI + canvas).

   El estado `posture` es un objeto plano que se expone como `monitor.state`:
   app.js y window.postavaDebug lo leen y escriben directamente, como antes.

   Callbacks (todos opcionales):
     onBadge(state, text)                  badge de estado
     onMessage(text)                       mensaje de postura
     onHold({ fraction, tone? })           barra de espera; `tone` "warn" | "bad" se envía
                                           en CADA fotograma de mala postura (no solo al
                                           cambiar de color); sin `tone` (recuperación,
                                           sin detección) el color se conserva.
                                           `{ fraction: 0 }` es un objeto compartido e
                                           inmutable: se lee, no se modifica ni se conserva
     onStats(force)                        pide repintar las estadísticas de sesión
     onAlert({ issueKey, text })           mostrar el cartel de aviso
     onClear()                             ocultar el cartel de aviso
     onSound()                             sonido de aviso
     onNotify({ issueKey, text })          cada aviso; app.js decide si notifica al sistema
     onCalibrationStart({ hint })          arranca la calibración
     onCalibrationProgress({ count, hint }) cada fotograma calibrando
     onCalibrationEnd({ engineReady })     termina/cancela la calibración
     onCalibrated({ baseline })            calibración válida, tras fijar el baseline
     onEngineReady()                       modelo cargado
     onEngineError(err)                    fallo al cargar el modelo */

import {
  ISSUE_TEXT,
  keyPointsVisible,
  computeMetrics,
  smoothInto,
  metricReport,
  collectIssues,
  averageMetrics,
  validateCalibrationSamples,
} from "./posture.js";
import { drawOverlay as defaultDrawOverlay } from "./overlay.js";

export const WASM_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
export const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

export const INFER_INTERVAL = 66;   // ms entre inferencias (~15 fps, suficiente y barato)
export const RECOVERY_MS = 1000;    // postura buena continua para dar por corregida
export const REALERT_MS = 20000;    // repetición del aviso si sigue mal

const CALIB_HINT = "Siéntate recto y mira a la pantalla";

const noop = () => {};

/* Constantes compartidas (inmutables) para no crear objetos en el bucle. */
const NO_SETTINGS = Object.freeze({});
const HOLD_ZERO = Object.freeze({ fraction: 0 });

/* `mediapipe`: { PoseLandmarker, FilesetResolver } o una función que devuelve
   (o resuelve a) ese objeto. La importación por CDN (jsDelivr,
   @mediapipe/tasks-vision@0.10.14) vive en app.js como import dinámico: Node no
   puede importar URLs https (así el módulo es testeable) y un fallo de la CDN
   llega a `onEngineError` en vez de romper el enlace de app.js.
   `canvas` / `ctx`: lienzo del esqueleto (solo se leen sus dimensiones y se
   pasa el ctx a drawOverlay).
   `getSettings()`: { tolerance, delaySeconds, showSkeleton, showHud, hideVideo }
   con los valores crudos de los controles (el monitor aplica los `|| 1` / `|| 5`).
   Se llama una vez por fotograma inferido y el monitor no conserva el resultado
   entre llamadas: puede devolver siempre el mismo objeto mutable (app.js lo hace
   para no asignar memoria en el bucle).
   `getBadgeState()`: estado actual del badge, solo para el HUD del lienzo.
   `startCamera()`: Promise<boolean>; se usa al calibrar con la cámara apagada.
   `clock()`, `requestFrame(cb)`, `cancelFrame(id)`: por defecto los de globalThis. */
export function createPostureMonitor({
  video,
  canvas,
  ctx,
  timer,
  focusStats,
  isCameraOn,
  startCamera = () => Promise.resolve(false),
  mediapipe,
  getSettings = () => NO_SETTINGS,
  getBadgeState = () => "",
  clock = () => globalThis.performance.now(),
  requestFrame = (callback) => globalThis.requestAnimationFrame(callback),
  cancelFrame = (id) => globalThis.cancelAnimationFrame(id),
  drawOverlay = defaultDrawOverlay,
  logger = console,
  onBadge = noop,
  onMessage = noop,
  onHold = noop,
  onStats = noop,
  onAlert = noop,
  onClear = noop,
  onSound = noop,
  onNotify = noop,
  onCalibrationStart = noop,
  onCalibrationProgress = noop,
  onCalibrationEnd = noop,
  onCalibrated = noop,
  onEngineReady = noop,
  onEngineError = noop,
} = {}) {
  const posture = {
    baseline: null,       // métricas de referencia guardadas al calibrar
    smoothed: null,       // métricas suavizadas (EMA)
    badSince: null,       // timestamp del inicio del tramo de mala postura
    goodStreak: 0,
    lastAlertAt: 0,
    alerting: false,
    showingIssue: false,
    alerts: 0,
    goodMs: 0,
    badMs: 0,
    lastFrameAt: 0,
    lastSeenAt: 0,
    calibrating: false,
    calibSamples: [],
    calibEndsAt: 0,
  };

  let landmarker = null;
  let engineReady = false;
  let rafId = null;
  let lastVideoTime = -1;
  let lastInferAt = 0;

  /* Buffers de trabajo del bucle (una inferencia cada ~66 ms): se reutilizan en
     cada fotograma para no crear objetos ni arrays y no provocar pausas de GC.
     `metricsBuf` recibe las métricas crudas; `reportRows`/`issueRows`, el informe
     por métrica y las incidencias ordenadas (solo válidos dentro de un evaluate). */
  const metricsBuf = { neck: 0, width: 0, tilt: 0, side: 0, chin: 0, shoulderY: 0 };
  const reportRows = [];
  const issueRows = [];

  /* ───────────────────────────────────────────────────────────────────────
     Motor de visión
     ─────────────────────────────────────────────────────────────────────── */
  async function initEngine() {
    try {
      // `mediapipe` puede ser el módulo ya resuelto o una función (import dinámico
      // de app.js): en ambos casos un fallo de carga cae en el catch de abajo.
      const { PoseLandmarker, FilesetResolver } = await (typeof mediapipe === "function" ? mediapipe() : mediapipe);
      const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
      const options = (delegate) => ({
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });

      let delegate = "GPU";
      try {
        landmarker = await PoseLandmarker.createFromOptions(vision, options("GPU"));
      } catch {
        // Algunas GPU/drivers no soportan WebGL para el delegado: caemos a CPU.
        delegate = "CPU";
        landmarker = await PoseLandmarker.createFromOptions(vision, options("CPU"));
      }
      logger.info(`Postava: motor de postura listo con delegado ${delegate}.`);

      engineReady = true;
      onEngineReady();
    } catch (err) {
      logger.error(err);
      onEngineError(err);
    }
  }

  /* Arranca el bucle de inferencia (app.js lo llama cuando la cámara ya está
     encendida). Idempotente: cancela antes el rAF pendiente, de modo que dos
     start() seguidos (p. ej. botón de cámara + tecla C con el permiso pendiente)
     dejan UN solo bucle y stop() siempre puede pararlo. */
  function start() {
    stop();
    posture.lastFrameAt = clock();
    posture.lastSeenAt = clock();
    lastVideoTime = -1;
    loop();
  }

  /* Cancela el rAF pendiente. La limpieza de calibración/aviso la encadena
     app.js (cancelCalibration, clearAlert) en el mismo orden que antes. */
  function stop() {
    if (rafId !== null) cancelFrame(rafId);
    rafId = null;
  }

  /* ── Bucle de inferencia ─────────────────────────────────────────────── */
  function loop() {
    if (!isCameraOn()) {
      rafId = null; // el rAF que acaba de disparar ya no está pendiente
      return;
    }
    rafId = requestFrame(loop);

    if (!engineReady || video.readyState < 2) return;

    const now = clock();
    if (now - lastInferAt < INFER_INTERVAL) return;
    if (video.currentTime === lastVideoTime) return;

    lastInferAt = now;
    lastVideoTime = video.currentTime;

    let result;
    try {
      result = landmarker.detectForVideo(video, now);
    } catch (err) {
      logger.error(err);
      return;
    }

    const landmarks = result?.landmarks?.[0] || null;
    const usable = landmarks && keyPointsVisible(landmarks);

    // Una sola lectura de ajustes por fotograma, compartida por draw() y evaluate().
    const settings = getSettings();
    draw(usable ? landmarks : null, settings);

    if (posture.calibrating) {
      handleCalibration(landmarks, usable, now);
      return;
    }

    if (!usable) {
      handleNotDetected(now);
      return;
    }

    posture.lastSeenAt = now;
    const metrics = computeMetrics(landmarks, videoAspect(), metricsBuf);
    // dt real desde el último fotograma evaluado, acotado para no dar un salto
    // grande tras una pausa larga o una pestaña oculta (donde rAF se frena).
    const dt = Math.min(Math.max(now - posture.lastFrameAt, 0), 500);
    // Se suaviza en sitio sobre el mismo objeto (sin asignar). Solo se crea uno
    // nuevo la primera vez o si `smoothed` fuese el mismo objeto que `baseline`,
    // que nunca debe mutar.
    const prev = posture.smoothed;
    posture.smoothed = smoothInto(prev && prev !== posture.baseline ? prev : {}, prev, metrics, dt);
    evaluate(posture.smoothed, now, settings);
  }

  function videoAspect() {
    return (video.videoWidth || 640) / (video.videoHeight || 480);
  }

  /* ── Calibración ─────────────────────────────────────────────────────── */
  function startCalibration() {
    if (!engineReady || posture.calibrating) return;
    if (!isCameraOn()) {
      startCamera().then((ok) => ok && startCalibration());
      return;
    }
    posture.calibrating = true;
    posture.calibSamples = [];
    posture.calibEndsAt = clock() + 4000; // 1 s de margen + 3 s de muestreo
    onCalibrationStart({ hint: CALIB_HINT });
    clearAlert();
    onBadge("idle", "Calibrando…");
    onMessage("Estos son los puntos que voy a medir: orejas, nariz y hombros.");
  }

  function cancelCalibration() {
    posture.calibrating = false;
    posture.calibSamples = [];
    onCalibrationEnd({ engineReady });
  }

  function handleCalibration(landmarks, usable, now) {
    const left = posture.calibEndsAt - now;
    const count = Math.max(1, Math.ceil(left / 1000));

    // Solo muestreamos el último tramo, para dar tiempo a colocarse.
    const sampling = left < 3000;
    if (usable && sampling) {
      posture.calibSamples.push(computeMetrics(landmarks, videoAspect()));
    }

    const hint = !usable
      ? "No te veo bien: encuadra cabeza y hombros"
      : sampling
        ? `Capturando puntos… ${posture.calibSamples.length} muestras`
        : CALIB_HINT;
    onCalibrationProgress({ count, hint });

    if (left > 0) return;

    const samples = posture.calibSamples;
    cancelCalibration();

    const validation = validateCalibrationSamples(samples);
    if (!validation.ok) {
      onMessage(
        validation.reason === "movement"
          ? "Te has movido durante la calibración. Quédate quieto y vuelve a intentarlo."
          : "No he podido verte bien. Asegúrate de que se vean cabeza y hombros, y vuelve a calibrar."
      );
      onBadge("idle", "Sin calibrar");
      return;
    }

    posture.baseline = averageMetrics(samples);
    posture.smoothed = { ...posture.baseline };
    posture.badSince = null;
    posture.goodStreak = 0;
    posture.showingIssue = false;
    onCalibrated({ baseline: posture.baseline });

    onBadge("good", "Postura correcta");
    onMessage("Calibrado. Oculto la imagen y dejo solo el mapa de puntos; te avisaré si te desvías.");
  }

  /* ───────────────────────────────────────────────────────────────────────
     Evaluación
     ─────────────────────────────────────────────────────────────────────── */
  function monitoringActive() {
    return isCameraOn() && timer.running && timer.phase === "focus" && !!posture.baseline;
  }

  /* `settings` (opcional): los ajustes del fotograma en curso; el bucle los pasa
     ya leídos. Si se llama directamente (?debug=1, tests) se leen aquí. */
  function evaluate(m, now, settings) {
    const dt = Math.min(now - posture.lastFrameAt, 200);
    posture.lastFrameAt = now;

    if (!posture.baseline) {
      onBadge("idle", "Sin calibrar");
      onHold(HOLD_ZERO);
      return;
    }

    const cfg = settings || getSettings();
    // Incidencias de más a menos grave, en buffers reutilizados (mismos resultados
    // que findIssues(); `issues` solo es válido hasta el final de esta llamada).
    const issues = collectIssues(metricReport(m, posture.baseline, cfg.tolerance || 1, reportRows), issueRows);
    const bad = issues.length > 0;

    // Fuera de la fase de enfoque solo mostramos el estado, sin avisos ni conteo.
    if (!monitoringActive()) {
      focusStats.clearActiveIssues();
      onBadge(bad ? "warn" : "good", bad ? "Postura mejorable" : "Postura correcta");
      onHold(HOLD_ZERO);
      return;
    }

    const delayMs = (cfg.delaySeconds || 5) * 1000;

    if (bad) {
      posture.badMs += dt;
      posture.goodStreak = 0;
      focusStats.addBad(dt, issues.map((issue) => issue.key));
      if (posture.badSince === null) posture.badSince = now;

      const held = now - posture.badSince;
      const progress = Math.min(1, held / delayMs);
      onHold({ fraction: progress, tone: progress >= 1 ? "bad" : "warn" });

      if (held >= delayMs) {
        onBadge("bad", "Corrige la postura");
        if (now - posture.lastAlertAt >= REALERT_MS || !posture.alerting) {
          raiseAlert(issues[0].key);
          posture.lastAlertAt = now;
        }
      } else {
        onBadge("warn", "Postura mejorable");
        onMessage(ISSUE_TEXT[issues[0].key]);
        posture.showingIssue = true;
      }
    } else {
      posture.goodMs += dt;
      posture.goodStreak += dt;
      focusStats.addGood(dt);

      if (posture.badSince !== null) {
        const shrink = Math.max(0, 1 - posture.goodStreak / RECOVERY_MS);
        onHold({ fraction: shrink });
      }

      if (posture.goodStreak >= RECOVERY_MS) {
        if (posture.alerting) {
          clearAlert();
          onMessage("Bien, postura recuperada.");
        } else if (posture.showingIssue) {
          onMessage("Todo en orden, sigue así.");
        }
        posture.showingIssue = false;
        posture.badSince = null;
        posture.lastAlertAt = 0;
        onBadge("good", "Postura correcta");
        onHold(HOLD_ZERO);
      }
    }

    onStats(false);
  }

  function handleNotDetected(now) {
    posture.lastFrameAt = now;
    focusStats.clearActiveIssues();
    onHold(HOLD_ZERO);
    onBadge("idle", "No te veo");
    if (now - posture.lastSeenAt > 3000) {
      onMessage("No detecto tu cabeza y hombros. Colócate frente a la cámara.");
      // Si desapareces un rato, el tramo de mala postura deja de contar.
      posture.badSince = null;
      clearAlert();
    }
  }

  function raiseAlert(issueKey) {
    const text = ISSUE_TEXT[issueKey];
    posture.alerting = true;
    posture.alerts += 1;
    focusStats.addAlert();
    onAlert({ issueKey, text });
    onMessage(text);
    posture.showingIssue = true;
    onSound();
    onStats(true);
    onNotify({ issueKey, text });
  }

  function clearAlert() {
    posture.alerting = false;
    onClear();
  }

  /* ───────────────────────────────────────────────────────────────────────
     Dibujo del esqueleto: ver overlay.js. `overlayState` es el único objeto
     mutable que se rellena en cada frame (sin asignar objetos nuevos).
     ─────────────────────────────────────────────────────────────────────── */
  const overlayState = {
    badgeState: "",
    showSkeleton: false,
    showHud: false,
    hideVideo: false,
    calibrating: false,
    baseline: null,
    smoothed: null,
    tolerance: 1,
  };

  /* `settings` (opcional): ajustes ya leídos por el bucle; si no, se leen aquí. */
  function draw(landmarks, settings = getSettings()) {
    const st = overlayState;
    st.badgeState = getBadgeState();
    st.showSkeleton = settings.showSkeleton;
    st.showHud = settings.showHud;
    st.hideVideo = settings.hideVideo;
    st.calibrating = posture.calibrating;
    st.baseline = posture.baseline;
    st.smoothed = posture.smoothed;
    st.tolerance = settings.tolerance || 1;
    drawOverlay(ctx, canvas.width, canvas.height, landmarks, st);
  }

  return {
    state: posture,
    initEngine,
    isEngineReady: () => engineReady,
    start,
    stop,
    startCalibration,
    cancelCalibration,
    handleCalibration,
    monitoringActive,
    evaluate,
    handleNotDetected,
    raiseAlert,
    clearAlert,
    draw,
  };
}
