/* ─────────────────────────────────────────────────────────────────────────
   Postava · Pomodoro con corrección de postura en tiempo real
   Todo se ejecuta en el cliente: el vídeo nunca sale del dispositivo.
   Motor de visión: MediaPipe Tasks Vision (PoseLandmarker).
   ───────────────────────────────────────────────────────────────────────── */

import { createPostureMonitor } from "./posture-monitor.js";
import { el, ctx } from "./dom.js";
import { ensureAudio, setSoundEnabled, soundPosture, soundPhaseEnd } from "./sound.js";
import { createCamera } from "./camera.js";
import { createUi } from "./ui.js";
import { phaseEndNotification, postureNotification, shouldNotifyPostureNow, showSystemNotification, notifyStatusView } from "./notifications.js";
import { readSettings, writeSettings } from "./settings.js";
import { bindFocusAccount } from "./stats-session.js";
import { createStatsQueue } from "./stats-queue.js";
import { createFocusStats } from "./focus-stats.js";
import { createTimer } from "./timer.js";

/* Render puro de la interfaz (badge, mensaje, cronómetro, chips…): ver ui.js.
   Se desestructura para conservar los nombres en los puntos de llamada. */
const ui = createUi(el, { doc: document });
const { setBadge, setMessage, renderTimer, syncChips } = ui;

/* ─────────────────────────────────────────────────────────────────────────
   Estado
   ───────────────────────────────────────────────────────────────────────── */
/* La máquina de fases vive en timer.js; aquí solo se cablean sus callbacks
   (DOM, sonido, stats, cámara). `timer` ES el estado (phase, running,
   remaining, total, endAt, session, completed) más sus operaciones. */
const timer = createTimer({
  getSettings: () => ({ focusMins: el.focusMins.value, breakMins: el.breakMins.value }),
  onPhase: ({ phase }) => {
    ui.renderPhase(phase);
    renderTimer(timer);
  },
  onTick: () => renderTimer(timer),
  onPhaseEnd: ({ from, skipped }) => {
    soundPhaseEnd();
    monitor.resetSession();
    if (from === "focus") {
      // Tope = duración planificada: una suspensión del equipo no infla el bloque.
      focusStats.stop(timer.total);
      if (!skipped && focusStats.elapsedMs > 0) statsQueue.recordCompletedFocus(focusStats);
      focusStats.reset();
    }
  },
  onSuspend: ({ at }) => {
    // El equipo durmió con el reloj en marcha: el timer ya está en pausa con el
    // restante congelado en `at`. Se cierra el enfoque en ese instante.
    enterPausedState(at);
    setMessage("Pausado: el equipo estuvo suspendido.");
  },
  onComplete: ({ from, skipped }) => {
    if (from === "focus") {
      if (!skipped) sendSystemNotification({ ...phaseEndNotification("break"), renotify: true });
      el.timeHint.textContent = "descansa y estírate";
      if (el.camOnlyRunning.checked) stopCamera();
    } else {
      el.cycle.textContent = `Sesión ${timer.session}`;
      if (!skipped) sendSystemNotification({ ...phaseEndNotification("focus"), renotify: true });
      el.timeHint.textContent = "listo para la siguiente";
    }
    // Saltar el enfoque estando parado o en pausa deja el descanso en marcha
    // (timer.setPhase("break", true)): el botón refleja el estado real.
    el.btnStart.textContent = timer.running ? "Pausar" : "Iniciar";
    updateStats(true);
  },
});

const focusStats = createFocusStats();

/* Cámara (getUserMedia, pistas, srcObject, flag on/off): ver camera.js.
   El estado "encendida" ya no es una variable de app.js: camera.isOn(). */
const camera = createCamera({
  video: el.video,
  onEnded: () => {
    stopCamera();
    setMessage("La cámara se desconectó o perdió el permiso. Vuelve a encenderla.");
  },
});

/* Barra de espera (holdFill): el monitor solo indica la fracción (0..1) y, en los
   fotogramas de mala postura, el tono ("warn" | "bad"); el estilo se aplica aquí. */
function renderHold({ fraction, tone }) {
  el.holdFill.style.width = `${fraction * 100}%`;
  if (tone) el.holdFill.style.background = tone === "bad" ? "var(--bad)" : "var(--warn)";
}

/* Ajustes que lee el monitor en cada fotograma inferido (~15 veces por segundo):
   siempre se rellena y se devuelve el MISMO objeto, en vez de crear uno por
   llamada. Los valores se siguen leyendo de los controles en cada llamada (así
   los cambios, incluidos los programáticos, se aplican al instante), pero sin
   asignar memoria; el monitor no conserva el objeto entre llamadas. */
const monitorSettings = { tolerance: 1, delaySeconds: 5, showSkeleton: true, showHud: true, hideVideo: false };
function readMonitorSettings() {
  monitorSettings.tolerance = +el.tolerance.value;
  monitorSettings.delaySeconds = +el.delaySeconds.value;
  monitorSettings.showSkeleton = el.skeletonToggle.checked;
  monitorSettings.showHud = el.hudToggle.checked;
  monitorSettings.hideVideo = el.hideVideoToggle.checked;
  return monitorSettings;
}

/* Motor y evaluación de postura (MediaPipe, bucle de inferencia, calibración y
   avisos): ver posture-monitor.js. No usa DOM ni red: aquí se cablean sus
   callbacks a la UI (ui.js), el sonido, las notificaciones y las estadísticas.
   `posture` es el mismo objeto de estado del monitor, así que las lecturas y
   escrituras directas de más abajo (ajustes, temporizador, ?debug=1) siguen
   igual. MediaPipe se importa de forma dinámica desde la CDN (ver `mediapipe`
   más abajo) para que un fallo de red no impida cargar este módulo. Siguen aquí
   por estar entrelazados con el DOM: la barra de espera, la capa de calibración,
   el modo mapa y la decisión de mostrar la notificación del sistema. */

/* Motor de visión caído (CDN bloqueada o fallan GPU y CPU): el temporizador sigue en
   modo "solo temporizador" y no se enciende la cámara, porque sin modelo no habría
   detección y btnCamera sigue deshabilitado (no habría forma de apagarla). Mientras
   el modelo aún carga esto es false y todo se comporta como siempre. */
let engineFailed = false;

/* Mensaje de postura cuando no hay modelo: lo pone onEngineError (el fallo puede llegar
   con el temporizador ya en marcha y un aviso de calibrar en pantalla) y lo repite
   startTimer si se inicia con el motor ya caído. */
const ENGINE_DOWN_MESSAGE =
  "Modelo de postura no disponible. El temporizador funciona igual, pero sin control de postura.";

const monitor = createPostureMonitor({
  video: el.video,
  canvas: el.overlay,
  ctx,
  timer,
  focusStats,
  isCameraOn: () => camera.isOn(),
  startCamera: () => startCamera(),
  // Import dinámico: si la CDN falla, solo falla initEngine (onEngineError) y el
  // temporizador sigue funcionando sin cámara ni modelo (regla de uso anónimo).
  mediapipe: () => import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14"),
  getSettings: readMonitorSettings,
  getBadgeState: () => el.badge.dataset.state,
  onBadge: setBadge,
  onMessage: setMessage,
  onHold: renderHold,
  onStats: updateStats,
  onAlert: ({ text }) => ui.showAlertBanner(text),
  onClear: () => ui.hideAlertBanner(),
  onSound: () => soundPosture(),
  onNotify: ({ text }) => {
    if (
      shouldNotifyPostureNow({
        hidden: document.hidden,
        supported: "Notification" in window,
        permission: window.Notification ? Notification.permission : "default",
        enabled: el.notifyToggle.checked,
      })
    ) {
      sendSystemNotification({ ...postureNotification(text), renotify: true });
    }
  },
  onCalibrationStart: ({ hint }) => {
    el.calibOverlay.hidden = false;
    el.btnCalibrate.disabled = true;
    // Mientras se calibra se ve la cámara aunque el modo mapa esté activo
    el.stage.dataset.calibrating = "true";
    el.calibHint.textContent = hint;
  },
  onCalibrationProgress: ({ count, hint }) => {
    el.calibCount.textContent = count;
    el.calibHint.textContent = hint;
  },
  onCalibrationEnd: ({ engineReady }) => {
    el.calibOverlay.hidden = true;
    el.stage.dataset.calibrating = "false";
    el.btnCalibrate.disabled = !engineReady;
  },
  onCalibrated: () => {
    enableMapMode();
    saveSettings();
  },
  onEngineReady: () => {
    el.engine.textContent = "Modelo de postura listo.";
    el.btnCalibrate.disabled = false;
    el.btnCamera.disabled = false;
  },
  onEngineError: () => {
    engineFailed = true;
    // Si la cámara se encendió (o su permiso estaba pendiente) mientras el modelo
    // cargaba, se apaga: sin modelo no hay detección ni botón para apagarla.
    stopCamera();
    setMessage(ENGINE_DOWN_MESSAGE);
    el.engine.classList.add("error");
    el.engine.textContent =
      "No se pudo cargar el modelo de visión. Revisa tu conexión y que la página se sirva por http(s), no con file://.";
  },
});
const posture = monitor.state;

const statsQueue = createStatsQueue({
  fetch: (...args) => fetch(...args),
  storage: {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
  },
  // El bundle de autenticación se importa de forma dinámica: si falla o está
  // bloqueado, el temporizador y la postura siguen funcionando en modo anónimo.
  importAuth: () => import("/assets/auth-adapter.bundle.js"),
  onStatus: (event) => {
    if (event.type === "saving") {
      ui.showStatsSaving(event.message);
    } else if (event.type === "error") {
      ui.showStatsSaveError(event.message, () => statsQueue.retry());
    } else if (event.type === "clear") {
      ui.clearStatsSaveError();
    }
  },
  randomUUID: () => crypto.randomUUID(),
  warn: (...args) => console.warn(...args),
});


/* ─────────────────────────────────────────────────────────────────────────
   Persistencia de ajustes
   ───────────────────────────────────────────────────────────────────────── */
/* La clave y la lectura/escritura del JSON viven en settings.js; aquí solo se
   recogen y aplican los valores de los controles (acoplados al DOM y a `posture`). */

function sendSystemNotification(notification) {
  showSystemNotification(notification, el.notifyToggle.checked);
}

/* Vuelca al DOM el estado calculado en notifications.js (notifyStatusView) */
function syncNotifyStatus() {
  const view = notifyStatusView({
    supported: "Notification" in window,
    permission: "Notification" in window ? Notification.permission : undefined,
    enabled: el.notifyToggle.checked,
  });
  ui.renderNotifyStatus(view);
}

function saveSettings() {
  const data = {
    focus: +el.focusMins.value,
    brk: +el.breakMins.value,
    tolerance: +el.tolerance.value,
    delay: +el.delaySeconds.value,
    sound: el.soundToggle.checked,
    skeleton: el.skeletonToggle.checked,
    hud: el.hudToggle.checked,
    hideVideo: el.hideVideoToggle.checked,
    camOnlyRunning: el.camOnlyRunning.checked,
    notify: el.notifyToggle.checked,
    baseline: posture.baseline,
  };
  writeSettings(data);
}

const BASELINE_KEYS = ["neck", "width", "tilt", "side", "chin", "shoulderY"];
const isValidBaseline = (b) =>
  b !== null && typeof b === "object" && BASELINE_KEYS.every((key) => Number.isFinite(b[key]));

function loadSettings() {
  const data = readSettings();
  if (!data) return;

  if (data.focus) el.focusMins.value = data.focus;
  if (data.brk) el.breakMins.value = data.brk;
  if (data.tolerance) el.tolerance.value = data.tolerance;
  if (data.delay) el.delaySeconds.value = data.delay;
  if (typeof data.sound === "boolean") el.soundToggle.checked = data.sound;
  if (typeof data.skeleton === "boolean") el.skeletonToggle.checked = data.skeleton;
  if (typeof data.hud === "boolean") el.hudToggle.checked = data.hud;
  if (typeof data.hideVideo === "boolean") el.hideVideoToggle.checked = data.hideVideo;
  if (typeof data.camOnlyRunning === "boolean") el.camOnlyRunning.checked = data.camOnlyRunning;
  // Solo se restaura activado si el permiso ya está concedido; si no, el primer
  // clic tendría que desmarcar en vez de pedir permiso.
  if (typeof data.notify === "boolean") {
    el.notifyToggle.checked = data.notify && "Notification" in window && Notification.permission === "granted";
  }
  // Un baseline manipulado o de una versión antigua (claves ausentes o no numéricas)
  // daría NaN en las métricas y nunca marcaría `exceeded`: se ignora sin avisar,
  // como si no hubiera calibración guardada.
  if (isValidBaseline(data.baseline)) {
    posture.baseline = data.baseline;
    setMessage("Calibración anterior cargada. Si has movido la cámara o la silla, vuelve a calibrar.");
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Cámara
   ───────────────────────────────────────────────────────────────────────── */
/* La adquisición del stream vive en camera.js (devuelve un resultado tipificado);
   aquí se traducen los fallos a los mensajes/badge de la UI. El motor de visión
   (initEngine) y el bucle de inferencia viven en posture-monitor.js. */
async function startCamera() {
  if (camera.isOn()) return true;
  if (engineFailed) return false; // sin modelo no se enciende la cámara (ver engineFailed)
  const result = await camera.start();
  if (!result.ok) {
    if (result.reason === "unsupported") {
      setMessage("Este navegador no permite acceder a la cámara.");
    } else if (result.reason === "denied") {
      console.error(result.error);
      setMessage("Permiso de cámara denegado. El temporizador funciona igual, pero sin control de postura.");
      setBadge("idle", "Sin cámara");
    } else if (result.reason === "cancelled") {
      // stop() (apagar, pausar, reiniciar, fin del enfoque…) canceló este arranque:
      // camera.js ya paró el stream y stopCamera() ya dejó la UI en "apagada".
      // No es un error: no se muestra ningún mensaje.
    } else {
      // metadata-timeout: camera.js ya liberó el stream; falta el resto de la UI de "apagada".
      stopCamera();
      setMessage("La cámara tardó demasiado en responder. Inténtalo de nuevo.");
    }
    return false;
  }

  ui.renderCameraOn({
    width: el.video.videoWidth || 640,
    height: el.video.videoHeight || 480,
  });
  monitor.start(); // reinicia lastFrameAt/lastSeenAt/lastVideoTime y arranca el bucle
  return true;
}

function stopCamera() {
  monitor.stop(); // cancela el rAF pendiente
  camera.stop(); // desregistra "ended", detiene todas las pistas y libera srcObject
  ui.renderCameraOff();
  ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
  monitor.cancelCalibration();
  monitor.resetSession();
  setBadge("idle", "Sin monitorizar");
  el.holdFill.style.width = "0%";
}

/* Modo mapa: se oculta la imagen y quedan solo los puntos */
function enableMapMode() {
  el.hideVideoToggle.checked = true;
  el.stage.dataset.hideVideo = "true";
}

/* La evaluación de postura (monitoringActive, evaluate, handleNotDetected,
   raiseAlert, clearAlert) y el dibujo del esqueleto (draw) viven en
   posture-monitor.js. */

/* ─────────────────────────────────────────────────────────────────────────
   Interfaz de estado
   ───────────────────────────────────────────────────────────────────────── */
/* setBadge / setMessage / renderTimer / syncChips vienen de ui.js (ver arriba).
   Aquí solo queda la limitación de frecuencia; el pintado está en ui.renderStats. */
let lastStatsAt = 0;
function updateStats(force = false) {
  const now = performance.now();
  if (!force && now - lastStatsAt < 1000) return;
  lastStatsAt = now;
  ui.renderStats({
    goodMs: posture.goodMs,
    badMs: posture.badMs,
    alerts: posture.alerts,
    completed: timer.completed,
  });
}

/* ─────────────────────────────────────────────────────────────────────────
   Temporizador Pomodoro
   ───────────────────────────────────────────────────────────────────────── */
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/* Espera máxima de la cuenta al iniciar un bloque de enfoque. Clerk puede tardar o
   no responder nunca (red lenta, script bloqueado): el Pomodoro no debe quedarse
   esperándolo, así que pasado este plazo el bloque arranca como invitado. */
const ACCOUNT_RESOLVE_TIMEOUT_MS = 2000;

/* Aviso al vencer ese plazo. Sin respuesta de Clerk no se sabe si hay sesión, así que
   el texto es condicional: vale igual para quien no usa cuenta (su bloque nunca se guarda). */
const ACCOUNT_TIMEOUT_MESSAGE =
  "No se pudo comprobar tu sesión a tiempo. Si tienes cuenta, este bloque no se guardará en estadísticas.";

/* { accountId, timedOut }: la cuenta actual (o null si es invitado), y si null se debe a que
   venció el plazo. NO cancela la resolución en curso: si termina tarde, su resultado se
   descarta aquí (Promise.race ya la da por atendida, así que un rechazo tardío tampoco
   queda sin manejar). Un bloque iniciado como invitado nunca se asocia a una cuenta
   posterior: bindFocusAccount solo asigna antes de que el bloque empiece. */
async function resolveAccountOrGuest() {
  let timeoutId;
  let timedOut = false;
  const deadline = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, ACCOUNT_RESOLVE_TIMEOUT_MS);
  });
  try {
    const accountId = await Promise.race([statsQueue.resolveAccount(), deadline]);
    return { accountId, timedOut };
  } finally {
    clearTimeout(timeoutId);
  }
}

/* true mientras startTimer espera la cuenta: ignora reentradas (clic, Enter o la tecla
   Espacio) para no iniciar dos veces. Por eso el botón se marca `aria-disabled` en vez de
   `disabled`: deshabilitar de verdad el botón enfocado le quita el foco a quien usa el
   teclado, y no lo recupera al rehabilitarlo. Los clics se ignoran aquí, por código. */
let startPending = false;

/* Se incrementa al Reiniciar o Saltar: un startTimer que aún espera la cuenta compara
   su época al volver y, si cambió, se descarta en vez de arrancar (o reanudar) el reloj
   sobre un estado que el usuario ya cambió. Pausar no lo toca: solo se puede pausar con
   el reloj en marcha, y en plena espera eso solo ocurre tras Saltar (que ya lo invalida). */
let startEpoch = 0;

async function startTimer() {
  if (startPending) return;
  ensureAudio(); // el gesto del usuario desbloquea el audio
  let accountTimedOut = false;
  if (timer.phase === "focus" && !focusStats.startedAt) {
    startPending = true;
    el.btnStart.setAttribute("aria-disabled", "true");
    const epoch = startEpoch;
    let accountId = null;
    try {
      ({ accountId, timedOut: accountTimedOut } = await resolveAccountOrGuest());
    } catch {
      // Guest timer remains available; no private history is attributed.
    } finally {
      startPending = false;
      el.btnStart.setAttribute("aria-disabled", "false");
    }
    if (epoch !== startEpoch) return; // Reiniciar/Saltar durante la espera: no se arranca nada
    bindFocusAccount(focusStats, accountId);
    if (accountTimedOut) setMessage(ACCOUNT_TIMEOUT_MESSAGE);
  }
  timer.start();
  if (timer.phase === "focus") focusStats.begin();
  el.btnStart.textContent = "Pausar";
  el.timeHint.textContent = timer.phase === "focus" ? "en marcha" : "descansando";
  posture.lastFrameAt = performance.now();

  if (timer.phase === "focus") {
    const ok = await startCamera();
    // Tras vencer el plazo de la cuenta, su aviso se conserva: estos mensajes no lo pisan
    // (el estado de calibración y del modelo ya se ven en la insignia y en el pie).
    if (!accountTimedOut && ok && !posture.baseline) {
      setMessage("Pulsa «Calibrar postura» sentado como quieres estar durante la sesión.");
    } else if (!accountTimedOut && !ok && engineFailed) {
      // Solo temporizador: startCamera() no enciende la cámara sin modelo.
      setMessage(ENGINE_DOWN_MESSAGE);
    }
  }
  renderTimer(timer);
}

function pauseTimer() {
  // Si el equipo acaba de despertar, se detecta la suspensión (onSuspend ya
  // pausa) en vez de contar el sueño como enfoque.
  if (timer.checkSuspend()) return;
  timer.pause();
  enterPausedState();
}

// Estado de pausa de la interfaz y de las métricas; `timer` ya está pausado.
// `atMs`: instante de cierre del enfoque (por defecto, ahora).
function enterPausedState(atMs) {
  if (timer.phase === "focus") focusStats.stop(timer.total - timer.remaining, atMs);
  el.btnStart.textContent = "Reanudar";
  el.timeHint.textContent = "en pausa";
  el.holdFill.style.width = "0%";
  monitor.resetSession();
  if (el.camOnlyRunning.checked) stopCamera();
  renderTimer(timer);
}

function resetTimer() {
  startEpoch++; // descarta un arranque que aún espera a la cuenta (ver startEpoch)
  focusStats.stop();
  focusStats.reset();
  posture.goodMs = 0;
  posture.badMs = 0;
  posture.alerts = 0;
  monitor.resetSession();
  timer.reset();
  el.btnStart.textContent = "Iniciar";
  el.timeHint.textContent = "listo para empezar";
  el.cycle.textContent = "Sesión 1";
  if (el.camOnlyRunning.checked) stopCamera();
  updateStats(true);
}

/* ─────────────────────────────────────────────────────────────────────────
   Eventos
   ───────────────────────────────────────────────────────────────────────── */
el.btnStart.addEventListener("click", () => {
  timer.running ? pauseTimer() : startTimer();
});

el.btnSkip.addEventListener("click", () => {
  // Igual que pausar: si el equipo acaba de despertar, se pausa en vez de saltar.
  if (timer.checkSuspend()) return;
  startEpoch++; // descarta un arranque que aún espera a la cuenta (ver startEpoch)
  timer.skip();
});
el.btnReset.addEventListener("click", resetTimer);
el.btnCalibrate.addEventListener("click", monitor.startCalibration);

el.btnCamera.addEventListener("click", () => {
  camera.isOn() ? stopCamera() : startCamera();
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    el.focusMins.value = chip.dataset.minutes;
    el.focusMins.dispatchEvent(new Event("change"));
  });
});

[el.focusMins, el.breakMins].forEach((input) => {
  input.addEventListener("change", () => {
    input.value = clamp(+input.value || 1, +input.min, +input.max);
    syncChips();
    if (!timer.running) timer.setPhase(timer.phase);
    saveSettings();
  });
});

el.tolerance.addEventListener("input", () => {
  ui.renderTolerance(+el.tolerance.value);
  saveSettings();
});

el.delaySeconds.addEventListener("input", () => {
  ui.renderDelay(el.delaySeconds.value);
  saveSettings();
});

el.hideVideoToggle.addEventListener("change", () => {
  el.stage.dataset.hideVideo = String(el.hideVideoToggle.checked);
  saveSettings();
});

[el.soundToggle, el.skeletonToggle, el.hudToggle, el.camOnlyRunning].forEach((c) =>
  c.addEventListener("change", saveSettings)
);
el.soundToggle.addEventListener("change", () => setSoundEnabled(el.soundToggle.checked));

el.notifyToggle.addEventListener("change", async () => {
  if (el.notifyToggle.checked && "Notification" in window) {
    if (Notification.permission === "default") {
      try {
        await Notification.requestPermission();
      } catch {
        /* navegadores antiguos: seguimos y comprobamos el permiso */
      }
    }
    if (Notification.permission !== "granted") el.notifyToggle.checked = false;
  }
  saveSettings();
  syncNotifyStatus();
});

document.addEventListener("keydown", (e) => {
  // Los atajos son teclas sueltas: con Ctrl/Cmd/Alt (p. ej. Ctrl+C = copiar) son del navegador
  // o del sistema, y una tecla mantenida (repeat) no debe alternar el temporizador en bucle.
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName);
  if (typing) return;
  if (e.code === "Space") {
    // Con el foco en un botón, enlace o <summary> (el «Ajustes» desplegable), Espacio ya lo
    // activa el propio navegador (en Firefox el clic llega en keyup aunque aquí se cancele el
    // keydown): se ignora para no alternar el temporizador dos veces.
    const { tagName } = e.target;
    if (tagName === "BUTTON" || tagName === "A" || tagName === "SUMMARY") return;
    e.preventDefault();
    timer.running ? pauseTimer() : startTimer();
  } else if (e.key.toLowerCase() === "c") {
    monitor.startCalibration();
  }
});

/* Al salir (cerrar, recargar, navegar) se sueltan las pistas de la cámara.
   `pagehide` es el evento fiable en móviles y Safari (donde `beforeunload` no
   siempre se dispara); `beforeunload` se mantiene por compatibilidad. Misma
   función para ambos: no se duplica lógica y releaseTracks() es idempotente. */
const releaseCameraOnExit = () => camera.releaseTracks();
window.addEventListener("pagehide", releaseCameraOnExit);
window.addEventListener("beforeunload", releaseCameraOnExit);
/* Si el navegador restaura la página desde la caché de navegación (bfcache) las
   pistas ya están paradas pero `camera.isOn()` seguiría en true: se apaga del
   todo para no mostrar un vídeo congelado como si estuviera activo. */
window.addEventListener("pageshow", (event) => {
  if (event.persisted && camera.isOn()) stopCamera();
});

/* ─────────────────────────────────────────────────────────────────────────
   Arranque
   ───────────────────────────────────────────────────────────────────────── */
el.btnCalibrate.disabled = true;
el.btnCamera.disabled = true;

loadSettings();
setSoundEnabled(el.soundToggle.checked);
syncNotifyStatus();
syncChips();
el.stage.dataset.hideVideo = String(el.hideVideoToggle.checked);
ui.renderTolerance(+el.tolerance.value);
ui.renderDelay(el.delaySeconds.value);

// Longitud real del trazo del aro, para que el progreso cierre exacto
ui.initRing();

timer.setPhase("focus");
setBadge("idle", "Sin monitorizar");
// La suspensión solo se vigila con la página visible: oculta, un hueco largo
// puede ser throttling/congelado de pestaña y no debe pausar el Pomodoro.
const syncWatch = () => timer.setSuspendWatch(document.visibilityState === "visible");
document.addEventListener("visibilitychange", syncWatch);
syncWatch();
setInterval(() => timer.tick(), 250);
updateStats(true);
statsQueue.resumePending();
monitor.initEngine();

/* Gancho de depuración: abre la página con ?debug=1 para simular posturas
   desde la consola sin necesidad de cámara. Útil para ajustar umbrales.
   Ej.:  postavaDebug.setBaseline(postavaDebug.state.posture.smoothed)      */
if (new URLSearchParams(location.search).has("debug")) {
  window.postavaDebug = {
    state: { posture, timer },
    setBaseline: (b) => {
      posture.baseline = { ...b };
      posture.smoothed = { ...b };
    },
    forceCamera: (on) => {
      camera.forceOn(on); // antes: camOn = on
    },
    evaluate: monitor.evaluate,
    draw: monitor.draw,
    startCalibration: monitor.startCalibration,
    handleCalibration: monitor.handleCalibration,
  };
}
