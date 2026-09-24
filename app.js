/* ─────────────────────────────────────────────────────────────────────────
   Postava · Pomodoro con corrección de postura en tiempo real
   Todo se ejecuta en el cliente: el vídeo nunca sale del dispositivo.
   Motor de visión: MediaPipe Tasks Vision (PoseLandmarker).
   ───────────────────────────────────────────────────────────────────────── */

import {
  PoseLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

import {
  LM,
  KEY_POINTS,
  ISSUE_TEXT,
  keyPointsVisible,
  computeMetrics,
  smooth,
  findIssues,
  metricReport,
  averageMetrics,
} from "./posture.js";
import { bindFocusAccount, completedFocusPayload } from "./stats-session.js";

import { loadAuth } from "/assets/auth-adapter.bundle.js";

const WASM_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const INFER_INTERVAL = 66;   // ms entre inferencias (~15 fps, suficiente y barato)
const RECOVERY_MS = 1000;    // postura buena continua para dar por corregida
const REALERT_MS = 20000;    // repetición del aviso si sigue mal
let RING_LEN = 753.98;       // 2πr con r = 120; se recalcula del SVG al arrancar

/* ─────────────────────────────────────────────────────────────────────────
   Referencias del DOM
   ───────────────────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);

const el = {
  phase: $("phaseLabel"),
  cycle: $("cycleLabel"),
  time: $("timerDisplay"),
  timeHint: $("timerHint"),
  ring: $("ringProgress"),
  focusMins: $("focusMins"),
  breakMins: $("breakMins"),
  btnStart: $("btnStart"),
  btnSkip: $("btnSkip"),
  btnReset: $("btnReset"),
  video: $("video"),
  overlay: $("overlay"),
  stage: $("stage"),
  placeholder: $("camPlaceholder"),
  calibOverlay: $("calibOverlay"),
  calibCount: $("calibCount"),
  calibHint: $("calibHint"),
  badge: $("postureBadge"),
  postureMsg: $("postureMsg"),
  holdFill: $("holdFill"),
  btnCalibrate: $("btnCalibrate"),
  btnCamera: $("btnCamera"),
  tolerance: $("tolerance"),
  tolValue: $("tolValue"),
  delaySeconds: $("delaySeconds"),
  delayValue: $("delayValue"),
  soundToggle: $("soundToggle"),
  skeletonToggle: $("skeletonToggle"),
  hudToggle: $("hudToggle"),
  hideVideoToggle: $("hideVideoToggle"),
  camOnlyRunning: $("camOnlyRunning"),
  goodPct: $("goodPct"),
  alertCount: $("alertCount"),
  focusDone: $("focusDone"),
  alertBanner: $("alertBanner"),
  alertReason: $("alertReason"),
  engine: $("engineStatus"),
};

const ctx = el.overlay.getContext("2d");

/* ─────────────────────────────────────────────────────────────────────────
   Estado
   ───────────────────────────────────────────────────────────────────────── */
const timer = {
  phase: "focus",       // "focus" | "break"
  running: false,
  remaining: 25 * 60_000,
  total: 25 * 60_000,
  endAt: 0,
  session: 1,
  completed: 0,
};

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

const focusStats = {
  accountId: null,
  startedAt: null,
  activeSince: null,
  elapsedMs: 0,
  goodMs: 0,
  badMs: 0,
  alerts: 0,
  issues: { neck: 0, shoulders: 0, tilt: 0, distance: 0 },
  activeIssueKeys: new Set(),
};

let landmarker = null;
let engineReady = false;
let stream = null;
let camOn = false;
let rafId = null;
let lastVideoTime = -1;
let lastInferAt = 0;
let audioCtx = null;
let statsAdapterPromise = null;
let statsAccountId = null;
let statsPending = [];
let statsPostInFlight = false;
let statsStatus;

function ensureStatsStatus() {
  if (statsStatus) return statsStatus;
  statsStatus = document.createElement("p");
  statsStatus.className = "stats-save-status";
  statsStatus.setAttribute("role", "status");
  statsStatus.style.color = "var(--bad)";
  statsStatus.style.fontSize = "0.8rem";
  statsStatus.style.margin = "12px 0 0";
  statsStatus.hidden = true;
  const actions = document.querySelector(".card-timer .actions");
  if (actions) actions.after(statsStatus);
  return statsStatus;
}

function showStatsSaveError(message) {
  const status = ensureStatsStatus();
  status.replaceChildren();
  const text = document.createElement("span");
  text.textContent = message;
  status.append(text);
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "stats-save-retry";
  retry.textContent = "Reintentar";
  retry.style.marginLeft = "8px";
  retry.style.padding = "5px 10px";
  retry.style.borderRadius = "999px";
  retry.style.border = "1px solid var(--line)";
  retry.style.background = "var(--surface)";
  retry.style.color = "var(--ink)";
  retry.addEventListener("click", retryStatsSaves);
  status.append(" ", retry);
  status.hidden = false;
}

function clearStatsSaveError() {
  if (statsStatus) {
    statsStatus.hidden = true;
    statsStatus.replaceChildren();
  }
}

function accountScopedQueueKey(accountId) {
  return `postava.stats.pending.v2:${accountId}`;
}

function persistPendingStats(accountId = statsAccountId, pending = statsPending) {
  if (!accountId) return;
  try {
    localStorage.setItem(accountScopedQueueKey(accountId), JSON.stringify(pending));
  } catch {
    showStatsSaveError("No se pudo guardar temporalmente el envío fallido. Mantén esta página abierta y reintenta.");
  }
}

async function resolveStatsAccount() {
  if (!statsAdapterPromise) statsAdapterPromise = loadAuth();
  const adapter = await statsAdapterPromise;
  const user = await adapter.restore();
  if (!user?.id) {
    statsAccountId = null;
    statsPending = [];
    return null;
  }
  if (statsAccountId !== user.id) {
    statsAccountId = user.id;
    try {
      const saved = JSON.parse(localStorage.getItem(accountScopedQueueKey(user.id)) || "[]");
      statsPending = Array.isArray(saved) ? saved.filter((item) => item && item.expectedUserId === user.id && typeof item.id === "string") : [];
    } catch {
      statsPending = [];
    }
  }
  return user.id;
}

async function sendStatsSession(session) {
  const response = await fetch("/api/stats/sessions", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(session),
  });
  if (!response.ok) throw new Error(response.status === 401 ? "La sesión de tu cuenta ha caducado." : "No se pudo guardar la sesión.");
}

async function retryStatsSaves() {
  if (statsPostInFlight) return;
  statsPostInFlight = true;
  const status = ensureStatsStatus();
  status.textContent = "Guardando estadísticas…";
  status.hidden = false;
  let drainingAccountId = null;
  try {
    drainingAccountId = await resolveStatsAccount();
    if (!drainingAccountId) {
      showStatsSaveError("Inicia sesión para guardar tus estadísticas privadas.");
      return;
    }
    const queue = statsPending;
    while (queue.length) {
      if (await resolveStatsAccount() !== drainingAccountId) {
        throw new Error("La cuenta cambió. Inicia sesión con la cuenta original para reintentar.");
      }
      const session = queue[0];
      await sendStatsSession(session);
      queue.shift();
      persistPendingStats(drainingAccountId, queue);
    }
    if (statsAccountId === drainingAccountId) clearStatsSaveError();
  } catch (error) {
    showStatsSaveError(`${error.message || "No se pudieron guardar tus estadísticas."} Tus sesiones pendientes se conservarán para reintentar.`);
  } finally {
    statsPostInFlight = false;
    if (statsAccountId && statsAccountId !== drainingAccountId && statsPending.length) retryStatsSaves();
  }
}

async function recordCompletedFocus() {
  const session = completedFocusPayload(focusStats, crypto.randomUUID());
  if (!session) return;
  const accountId = session.expectedUserId;
  try {
    // The completed block belongs to the account bound when focus started,
    // even if another tab changed Clerk's current account in the meantime.
    if (statsAccountId === accountId) {
      statsPending.push(session);
      persistPendingStats();
    } else {
      const key = accountScopedQueueKey(accountId);
      const saved = JSON.parse(localStorage.getItem(key) || "[]");
      if (!Array.isArray(saved)) throw new Error("Cola de sesiones no válida");
      saved.push(session);
      localStorage.setItem(key, JSON.stringify(saved));
    }
    if (await resolveStatsAccount() === accountId) await retryStatsSaves();
    else showStatsSaveError("Esta sesión pertenece a otra cuenta. Inicia sesión con esa cuenta para enviarla.");
  } catch (error) {
    showStatsSaveError(`${error.message || "No se pudieron guardar tus estadísticas."} Mantén esta página abierta y reintenta.`);
  }
}

async function resumePendingStats() {
  try {
    const accountId = await resolveStatsAccount();
    if (accountId && statsPending.length) await retryStatsSaves();
  } catch {
    // La restauración de la cuenta nunca debe bloquear el temporizador.
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Persistencia de ajustes
   ───────────────────────────────────────────────────────────────────────── */
const STORE_KEY = "postava.v1";

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
    baseline: posture.baseline,
  };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  } catch {
    /* modo privado o almacenamiento lleno: seguimos sin persistir */
  }
}

function loadSettings() {
  let data;
  try {
    data = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
  } catch {
    data = null;
  }
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
  if (data.baseline) {
    posture.baseline = data.baseline;
    setMessage("Calibración anterior cargada. Si has movido la cámara o la silla, vuelve a calibrar.");
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Sonido (WebAudio, sin archivos externos)
   ───────────────────────────────────────────────────────────────────────── */
function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

function tone(freq, startOffset, duration, peak = 0.12) {
  const ac = ensureAudio();
  if (!ac) return;
  const t0 = ac.currentTime + startOffset;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

const soundPosture = () => {
  if (!el.soundToggle.checked) return;
  tone(523.25, 0, 0.7);      // do
  tone(659.25, 0.14, 0.8);   // mi
};

const soundPhaseEnd = () => {
  if (!el.soundToggle.checked) return;
  tone(587.33, 0, 0.5, 0.14);
  tone(739.99, 0.16, 0.5, 0.14);
  tone(880.0, 0.32, 0.9, 0.14);
};

/* ─────────────────────────────────────────────────────────────────────────
   Motor de visión
   ───────────────────────────────────────────────────────────────────────── */
async function initEngine() {
  try {
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    try {
      landmarker = await PoseLandmarker.createFromOptions(vision, options("GPU"));
    } catch {
      // Algunas GPU/drivers no soportan WebGL para el delegado: caemos a CPU.
      landmarker = await PoseLandmarker.createFromOptions(vision, options("CPU"));
    }

    engineReady = true;
    el.engine.textContent = "Modelo de postura listo.";
    el.btnCalibrate.disabled = false;
    el.btnCamera.disabled = false;
  } catch (err) {
    console.error(err);
    el.engine.classList.add("error");
    el.engine.textContent =
      "No se pudo cargar el modelo de visión. Revisa tu conexión y que la página se sirva por http(s), no con file://.";
  }
}

async function startCamera() {
  if (camOn) return true;
  if (!navigator.mediaDevices?.getUserMedia) {
    setMessage("Este navegador no permite acceder a la cámara.");
    return false;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
      audio: false,
    });
  } catch (err) {
    console.error(err);
    setMessage("Permiso de cámara denegado. El temporizador funciona igual, pero sin control de postura.");
    setBadge("idle", "Sin cámara");
    return false;
  }

  el.video.srcObject = stream;
  await el.video.play().catch(() => {});
  await new Promise((resolve) => {
    if (el.video.videoWidth) return resolve();
    el.video.onloadedmetadata = () => resolve();
  });

  el.overlay.width = el.video.videoWidth || 640;
  el.overlay.height = el.video.videoHeight || 480;

  camOn = true;
  el.placeholder.hidden = true;
  el.btnCamera.textContent = "Apagar cámara";
  posture.lastFrameAt = performance.now();
  posture.lastSeenAt = performance.now();
  lastVideoTime = -1;
  loop();
  return true;
}

function stopCamera() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  el.video.srcObject = null;
  camOn = false;
  el.placeholder.hidden = false;
  el.btnCamera.textContent = "Encender cámara";
  ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
  cancelCalibration();
  clearAlert();
  setBadge("idle", "Sin monitorizar");
  el.holdFill.style.width = "0%";
}

/* ── Bucle de inferencia ───────────────────────────────────────────────── */
function loop() {
  if (!camOn) return;
  rafId = requestAnimationFrame(loop);

  if (!engineReady || el.video.readyState < 2) return;

  const now = performance.now();
  if (now - lastInferAt < INFER_INTERVAL) return;
  if (el.video.currentTime === lastVideoTime) return;

  lastInferAt = now;
  lastVideoTime = el.video.currentTime;

  let result;
  try {
    result = landmarker.detectForVideo(el.video, now);
  } catch (err) {
    console.error(err);
    return;
  }

  const landmarks = result?.landmarks?.[0] || null;
  const usable = landmarks && keyPointsVisible(landmarks);

  draw(usable ? landmarks : null);

  if (posture.calibrating) {
    handleCalibration(landmarks, usable, now);
    return;
  }

  if (!usable) {
    handleNotDetected(now);
    return;
  }

  posture.lastSeenAt = now;
  const metrics = computeMetrics(landmarks, videoAspect());
  posture.smoothed = smooth(posture.smoothed, metrics, 0.3);
  evaluate(posture.smoothed, now);
}

function videoAspect() {
  return (el.video.videoWidth || 640) / (el.video.videoHeight || 480);
}

/* ── Calibración ──────────────────────────────────────────────────────── */
function startCalibration() {
  if (!camOn) {
    startCamera().then((ok) => ok && startCalibration());
    return;
  }
  posture.calibrating = true;
  posture.calibSamples = [];
  posture.calibEndsAt = performance.now() + 4000; // 1 s de margen + 3 s de muestreo
  el.calibOverlay.hidden = false;
  el.btnCalibrate.disabled = true;
  // Mientras se calibra se ve la cámara aunque el modo mapa esté activo
  el.stage.dataset.calibrating = "true";
  el.calibHint.textContent = "Siéntate recto y mira a la pantalla";
  clearAlert();
  setBadge("idle", "Calibrando…");
  setMessage("Estos son los puntos que voy a medir: orejas, nariz y hombros.");
}

function cancelCalibration() {
  posture.calibrating = false;
  posture.calibSamples = [];
  el.calibOverlay.hidden = true;
  el.stage.dataset.calibrating = "false";
  el.btnCalibrate.disabled = !engineReady;
}

/* Modo mapa: se oculta la imagen y quedan solo los puntos */
function enableMapMode() {
  el.hideVideoToggle.checked = true;
  el.stage.dataset.hideVideo = "true";
}

function handleCalibration(landmarks, usable, now) {
  const left = posture.calibEndsAt - now;
  el.calibCount.textContent = Math.max(1, Math.ceil(left / 1000));

  // Solo muestreamos el último tramo, para dar tiempo a colocarse.
  const sampling = left < 3000;
  if (usable && sampling) {
    posture.calibSamples.push(computeMetrics(landmarks, videoAspect()));
  }

  el.calibHint.textContent = !usable
    ? "No te veo bien: encuadra cabeza y hombros"
    : sampling
      ? `Capturando puntos… ${posture.calibSamples.length} muestras`
      : "Siéntate recto y mira a la pantalla";

  if (left > 0) return;

  const samples = posture.calibSamples;
  cancelCalibration();

  if (samples.length < 8) {
    setMessage("No he podido verte bien. Asegúrate de que se vean cabeza y hombros, y vuelve a calibrar.");
    setBadge("idle", "Sin calibrar");
    return;
  }

  posture.baseline = averageMetrics(samples);
  posture.smoothed = { ...posture.baseline };
  posture.badSince = null;
  posture.goodStreak = 0;
  posture.showingIssue = false;
  enableMapMode();
  saveSettings();

  setBadge("good", "Postura correcta");
  setMessage("Calibrado. Oculto la imagen y dejo solo el mapa de puntos; te avisaré si te desvías.");
}

/* ─────────────────────────────────────────────────────────────────────────
   Evaluación
   ───────────────────────────────────────────────────────────────────────── */
function monitoringActive() {
  return camOn && timer.running && timer.phase === "focus" && !!posture.baseline;
}

function evaluate(m, now) {
  const dt = Math.min(now - posture.lastFrameAt, 200);
  posture.lastFrameAt = now;

  if (!posture.baseline) {
    setBadge("idle", "Sin calibrar");
    el.holdFill.style.width = "0%";
    return;
  }

  const issues = findIssues(m, posture.baseline, +el.tolerance.value || 1);
  const bad = issues.length > 0;

  // Fuera de la fase de enfoque solo mostramos el estado, sin avisos ni conteo.
  if (!monitoringActive()) {
    focusStats.activeIssueKeys.clear();
    setBadge(bad ? "warn" : "good", bad ? "Postura mejorable" : "Postura correcta");
    el.holdFill.style.width = "0%";
    return;
  }

  const delayMs = (+el.delaySeconds.value || 5) * 1000;

  if (bad) {
    posture.badMs += dt;
    focusStats.badMs += dt;
    posture.goodStreak = 0;
    const currentIssueKeys = new Set(issues.map((issue) => issue.key));
    const issueCounts = {
      neckDrop: "neck", chinDown: "neck", slump: "neck",
      sideLean: "shoulders", shoulderTilt: "tilt", proximity: "distance",
    };
    for (const issue of issues) {
      const category = issueCounts[issue.key];
      if (category && !focusStats.activeIssueKeys.has(issue.key)) focusStats.issues[category] += 1;
    }
    focusStats.activeIssueKeys = currentIssueKeys;
    if (posture.badSince === null) posture.badSince = now;

    const held = now - posture.badSince;
    const progress = Math.min(1, held / delayMs);
    el.holdFill.style.width = `${progress * 100}%`;
    el.holdFill.style.background = progress >= 1 ? "var(--bad)" : "var(--warn)";

    if (held >= delayMs) {
      setBadge("bad", "Corrige la postura");
      if (now - posture.lastAlertAt >= REALERT_MS || !posture.alerting) {
        raiseAlert(issues[0].key);
        posture.lastAlertAt = now;
      }
    } else {
      setBadge("warn", "Postura mejorable");
      setMessage(ISSUE_TEXT[issues[0].key]);
      posture.showingIssue = true;
    }
  } else {
    posture.goodMs += dt;
    focusStats.goodMs += dt;
    posture.goodStreak += dt;
    focusStats.activeIssueKeys.clear();

    if (posture.badSince !== null) {
      const shrink = Math.max(0, 1 - posture.goodStreak / RECOVERY_MS);
      el.holdFill.style.width = `${shrink * 100}%`;
    }

    if (posture.goodStreak >= RECOVERY_MS) {
      if (posture.alerting) {
        clearAlert();
        setMessage("Bien, postura recuperada.");
      } else if (posture.showingIssue) {
        setMessage("Todo en orden, sigue así.");
      }
      posture.showingIssue = false;
      posture.badSince = null;
      posture.lastAlertAt = 0;
      setBadge("good", "Postura correcta");
      el.holdFill.style.width = "0%";
    }
  }

  updateStats();
}

function handleNotDetected(now) {
  posture.lastFrameAt = now;
  focusStats.activeIssueKeys.clear();
  el.holdFill.style.width = "0%";
  setBadge("idle", "No te veo");
  if (now - posture.lastSeenAt > 3000) {
    setMessage("No detecto tu cabeza y hombros. Colócate frente a la cámara.");
    // Si desapareces un rato, el tramo de mala postura deja de contar.
    posture.badSince = null;
    clearAlert();
  }
}

function raiseAlert(issueKey) {
  posture.alerting = true;
  posture.alerts += 1;
  focusStats.alerts += 1;
  el.alertReason.textContent = ISSUE_TEXT[issueKey];
  el.alertBanner.hidden = false;
  setMessage(ISSUE_TEXT[issueKey]);
  posture.showingIssue = true;
  soundPosture();
  updateStats(true);
}

function clearAlert() {
  posture.alerting = false;
  el.alertBanner.hidden = true;
}

/* ─────────────────────────────────────────────────────────────────────────
   Dibujo del esqueleto
   ───────────────────────────────────────────────────────────────────────── */
const CONNECTIONS = [
  [LM.L_SHOULDER, LM.R_SHOULDER],
  [LM.L_SHOULDER, LM.L_EAR],
  [LM.R_SHOULDER, LM.R_EAR],
  [LM.L_EAR, LM.L_EYE],
  [LM.R_EAR, LM.R_EYE],
  [LM.L_EYE, LM.NOSE],
  [LM.R_EYE, LM.NOSE],
];

/* Puntos de contexto: no entran en ninguna métrica, solo dan cuerpo al
   esqueleto. Se dibujan más tenues y solo si el modelo los ve con confianza. */
const SECONDARY_CONNECTIONS = [
  [LM.L_SHOULDER, LM.L_ELBOW],
  [LM.R_SHOULDER, LM.R_ELBOW],
  [LM.L_ELBOW, LM.L_WRIST],
  [LM.R_ELBOW, LM.R_WRIST],
  [LM.L_SHOULDER, LM.L_HIP],
  [LM.R_SHOULDER, LM.R_HIP],
  [LM.L_HIP, LM.R_HIP],
  [LM.MOUTH_L, LM.MOUTH_R],
];
const SECONDARY_POINTS = [
  LM.MOUTH_L, LM.MOUTH_R, LM.L_ELBOW, LM.R_ELBOW,
  LM.L_WRIST, LM.R_WRIST, LM.L_HIP, LM.R_HIP,
];

/* Puntos que entran en las métricas (KEY_POINTS). El código lleva el índice
   real del landmark en MediaPipe. `below` evita que la etiqueta tape la cara. */
const POINT_INFO = {
  [LM.NOSE]: { code: "NOSE·00", name: "nariz", below: true },
  [LM.L_EAR]: { code: "EAR·07", name: "oreja", below: false },
  [LM.R_EAR]: { code: "EAR·08", name: "oreja", below: false },
  [LM.L_SHOULDER]: { code: "SHLD·11", name: "hombro", below: true },
  [LM.R_SHOULDER]: { code: "SHLD·12", name: "hombro", below: true },
};

const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/* Paleta del lienzo. Va siempre sobre vídeo o sobre el mapa oscuro, así que
   usa tonos más luminosos que los de la interfaz: sobre fondo oscuro un verde
   bosque no se lee. Mismo significado, distinto sustrato. */
const COLORS = { good: "#5fe3a0", warn: "#ffb454", bad: "#ff7a68" };
const MAP_BG = "#0d1014";
const MAP_GRID = "rgba(95, 227, 160, 0.09)";

/* Mientras se calibra siempre se ve la cámara, aunque el modo mapa esté activo */
function videoHidden() {
  return el.hideVideoToggle.checked && !posture.calibrating;
}

/* Fondo del modo mapa: oscuro con una retícula tenue */
function drawMapBackground(w, h) {
  ctx.fillStyle = MAP_BG;
  ctx.fillRect(0, 0, w, h);

  const step = Math.max(16, Math.round(w / 22));
  ctx.strokeStyle = MAP_GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = step; x < w; x += step) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
  }
  for (let y = step; y < h; y += step) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
  }
  ctx.stroke();
}

/* El lienzo va espejado por CSS. Todo el texto se dibuja dentro de este
   contexto invertido para que se lea del derecho en pantalla. */
function unmirrored(w, fn) {
  ctx.save();
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  fn();
  ctx.restore();
}

/* Esquinas de encuadre: el marco de una interfaz de seguimiento */
function drawCornerBrackets(w, h, color) {
  const len = Math.round(Math.min(w, h) * 0.06);
  const inset = Math.round(w * 0.02);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = Math.max(1.5, w / 400);
  ctx.lineCap = "square";
  for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const x = cx ? w - inset : inset;
    const y = cy ? h - inset : inset;
    const dx = cx ? -len : len;
    const dy = cy ? -len : len;
    ctx.beginPath();
    ctx.moveTo(x + dx, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy);
    ctx.stroke();
  }
  ctx.restore();
}

/* Marcador de seguimiento: cuatro escuadras y un punto central */
function drawMarker(x, y, r, color, lineW) {
  const s = r * 2.1;
  const arm = s * 0.45;
  ctx.save();
  ctx.strokeStyle = "rgba(6, 8, 12, 0.6)";
  ctx.lineWidth = lineW * 1.6;
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) {
      ctx.strokeStyle = color;
      ctx.lineWidth = lineW * 0.8;
    }
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(x + sx * s - sx * arm, y + sy * s);
      ctx.lineTo(x + sx * s, y + sy * s);
      ctx.lineTo(x + sx * s, y + sy * s - sy * arm);
      ctx.stroke();
    }
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(6, 8, 12, 0.65)";
  ctx.lineWidth = Math.max(1, lineW * 0.5);
  ctx.stroke();
  ctx.restore();
}

/* Rombo hueco para los puntos derivados (los que el cálculo usa de verdad) */
function drawDiamond(x, y, r, color, lineW) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineW * 0.8;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

/* Etiqueta de una o dos líneas, centrada en (x, y) del lienzo espejado */
function drawLabel(lines, x, y, color, w) {
  const size = Math.max(10, Math.round(w / 56));
  const lh = Math.round(size * 1.3);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(-1, 1);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${size}px ${MONO}`;

  const boxW = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 12;
  const boxH = lh * lines.length + 6;
  ctx.fillStyle = "rgba(8, 10, 14, 0.78)";
  ctx.fillRect(-boxW / 2, -boxH / 2, boxW, boxH);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 1;
  ctx.strokeRect(-boxW / 2 + 0.5, -boxH / 2 + 0.5, boxW - 1, boxH - 1);
  ctx.globalAlpha = 1;

  lines.forEach((text, i) => {
    ctx.fillStyle = i === 0 ? color : "rgba(190, 200, 215, 0.8)";
    ctx.font = `${i === 0 ? size : size - 1}px ${MONO}`;
    ctx.fillText(text, 0, -boxH / 2 + 3 + lh * (i + 0.5));
  });
  ctx.restore();
}

/* Panel de métricas en vivo: cuánto se ha consumido de cada umbral */
function drawHud(w, h, color) {
  const size = Math.max(10, Math.round(w / 50));
  const lh = Math.round(size * 1.55);
  const pad = Math.round(w * 0.022);
  const barW = size * 5;
  const rows = posture.baseline && posture.smoothed
    ? metricReport(posture.smoothed, posture.baseline, +el.tolerance.value || 1)
    : [];

  const panelW = size * 4.2 + barW + size * 3.4 + pad * 2;
  const panelH = lh * (rows.length + 1) + pad * 1.4;
  // Debajo del corchete de encuadre, para que no se pisen
  const top = pad + Math.round(Math.min(w, h) * 0.06) + 6;

  unmirrored(w, () => {
    ctx.font = `${size}px ${MONO}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";

    ctx.fillStyle = "rgba(8, 10, 14, 0.62)";
    ctx.fillRect(pad, top, panelW, panelH);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1;
    ctx.strokeRect(pad + 0.5, top + 0.5, panelW - 1, panelH - 1);
    ctx.globalAlpha = 1;

    const x0 = pad + pad * 0.6;
    let y = top + pad * 0.7 + lh / 2;

    ctx.fillStyle = color;
    ctx.fillText(rows.length ? "POSE · LIVE" : "POSE · SIN CALIBRAR", x0, y);

    for (const row of rows) {
      y += lh;
      const pct = Math.max(0, Math.min(1.35, row.ratio));
      const tone = row.exceeded ? COLORS.bad : pct > 0.7 ? COLORS.warn : color;

      ctx.fillStyle = "rgba(190, 200, 215, 0.85)";
      ctx.fillText(row.code, x0, y);

      const bx = x0 + size * 4.2;
      ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
      ctx.fillRect(bx, y - size * 0.32, barW, size * 0.64);
      ctx.fillStyle = tone;
      ctx.fillRect(bx, y - size * 0.32, barW * Math.min(pct, 1), size * 0.64);
      if (row.exceeded) ctx.fillRect(bx + barW + 2, y - size * 0.32, 2, size * 0.64);

      ctx.fillStyle = tone;
      ctx.fillText(`${Math.round(row.ratio * 100)}%`.padStart(4), bx + barW + size * 0.7, y);
    }
  });
}

function draw(landmarks) {
  const w = el.overlay.width;
  const h = el.overlay.height;
  ctx.clearRect(0, 0, w, h);

  const color = COLORS[el.badge.dataset.state] || COLORS.good;

  if (videoHidden()) drawMapBackground(w, h);

  // Durante la calibración el esqueleto se muestra siempre: es lo que se explica.
  if (landmarks && (el.skeletonToggle.checked || posture.calibrating)) {
    drawSkeleton(landmarks, w, h, color);
  }

  // El panel va aparte: se puede querer solo los números, sin esqueleto.
  if (el.hudToggle.checked) drawHud(w, h, color);
}

function drawSkeleton(landmarks, w, h, color) {
  const lineW = Math.max(2, w / 220);
  const P = (i) => landmarks[i];
  const seen = (i) => {
    const p = landmarks[i];
    return p && (typeof p.visibility !== "number" || p.visibility > 0.5);
  };

  drawCornerBrackets(w, h, color);

  // ── Esqueleto de contexto: codos, muñecas, caderas, boca ───────────────
  ctx.lineCap = "round";
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineW * 0.7;
  for (const [a, b] of SECONDARY_CONNECTIONS) {
    if (!seen(a) || !seen(b)) continue;
    ctx.beginPath();
    ctx.moveTo(P(a).x * w, P(a).y * h);
    ctx.lineTo(P(b).x * w, P(b).y * h);
    ctx.stroke();
  }
  for (const i of SECONDARY_POINTS) {
    if (!seen(i)) continue;
    ctx.beginPath();
    ctx.arc(P(i).x * w, P(i).y * h, Math.max(2, w / 260), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // ── Esqueleto medido, con trazo oscuro debajo para leerse sobre cualquier fondo
  for (const pass of [0, 1]) {
    ctx.strokeStyle = pass ? color : "rgba(6, 8, 12, 0.55)";
    ctx.lineWidth = pass ? lineW : lineW * 2.4;
    for (const [a, b] of CONNECTIONS) {
      if (!P(a) || !P(b)) continue;
      ctx.beginPath();
      ctx.moveTo(P(a).x * w, P(a).y * h);
      ctx.lineTo(P(b).x * w, P(b).y * h);
      ctx.stroke();
    }
  }

  // ── Geometría derivada: puntos medios y vector de cuello (la métrica `neck`)
  const mid = (a, b) => ({
    x: ((P(a).x + P(b).x) / 2) * w,
    y: ((P(a).y + P(b).y) / 2) * h,
  });
  const earMid = P(LM.L_EAR) && P(LM.R_EAR) ? mid(LM.L_EAR, LM.R_EAR) : null;
  const shMid =
    P(LM.L_SHOULDER) && P(LM.R_SHOULDER) ? mid(LM.L_SHOULDER, LM.R_SHOULDER) : null;

  if (earMid && shMid) {
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = lineW * 0.7;
    ctx.beginPath();
    ctx.moveTo(earMid.x, earMid.y);
    ctx.lineTo(shMid.x, shMid.y);
    ctx.stroke();
    ctx.restore();
    drawDiamond(earMid.x, earMid.y, lineW * 2, color, lineW);
    drawDiamond(shMid.x, shMid.y, lineW * 2, color, lineW);
  }

  // ── Marcadores de seguimiento sobre los puntos medidos ─────────────────
  const r = Math.max(3, w / 170) * (posture.calibrating ? 1.4 : 1);

  for (const i of [LM.L_EYE, LM.R_EYE]) {
    if (!P(i)) continue;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(P(i).x * w, P(i).y * h, r * 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  for (const i of KEY_POINTS) {
    if (!P(i)) continue;
    const x = P(i).x * w;
    const y = P(i).y * h;
    if (posture.calibrating) {
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r * 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    drawMarker(x, y, r, color, lineW);
  }

  // ── Códigos de landmark; al calibrar se añade el nombre en claro ───────
  const offset = Math.max(18, w / 22);
  for (const [i, info] of Object.entries(POINT_INFO)) {
    if (!P(i)) continue;
    const lines = posture.calibrating ? [info.code, info.name] : [info.code];
    drawLabel(lines, P(i).x * w, P(i).y * h + (info.below ? offset : -offset), color, w);
  }

  // ── Línea de referencia de la calibración (altura de hombros ideal) ────
  if (posture.baseline) {
    ctx.save();
    ctx.setLineDash([6, 8]);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = Math.max(1, w / 420);
    ctx.beginPath();
    ctx.moveTo(0, posture.baseline.shoulderY * h);
    ctx.lineTo(w, posture.baseline.shoulderY * h);
    ctx.stroke();
    ctx.restore();

    unmirrored(w, () => {
      ctx.font = `${Math.max(9, Math.round(w / 62))}px ${MONO}`;
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.6;
      ctx.fillText("REF·CALIB", w - w * 0.02, posture.baseline.shoulderY * h - 4);
    });
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Interfaz de estado
   ───────────────────────────────────────────────────────────────────────── */
function setBadge(state, text) {
  el.badge.dataset.state = state;
  el.badge.className = `badge badge-${state}`;
  el.badge.textContent = text;
}

function setMessage(text) {
  el.postureMsg.textContent = text;
}

let lastStatsAt = 0;
function updateStats(force = false) {
  const now = performance.now();
  if (!force && now - lastStatsAt < 1000) return;
  lastStatsAt = now;
  const total = posture.goodMs + posture.badMs;
  el.goodPct.textContent =
    total > 5000 ? `${Math.round((posture.goodMs / total) * 100)} %` : "—";
  el.alertCount.textContent = posture.alerts;
  el.focusDone.textContent = timer.completed;
}

/* ─────────────────────────────────────────────────────────────────────────
   Temporizador Pomodoro
   ───────────────────────────────────────────────────────────────────────── */
function phaseDurationMs(phase) {
  const mins =
    phase === "focus"
      ? clamp(+el.focusMins.value || 25, 1, 180)
      : clamp(+el.breakMins.value || 5, 1, 60);
  return mins * 60_000;
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function beginFocusStats() {
  if (!focusStats.startedAt) focusStats.startedAt = new Date().toISOString();
  if (!focusStats.activeSince) focusStats.activeSince = Date.now();
}

function stopFocusStats() {
  if (focusStats.activeSince) {
    focusStats.elapsedMs += Math.max(0, Date.now() - focusStats.activeSince);
    focusStats.activeSince = null;
  }
}

function resetFocusStats() {
  focusStats.accountId = null;
  focusStats.startedAt = null;
  focusStats.activeSince = null;
  focusStats.elapsedMs = 0;
  focusStats.goodMs = 0;
  focusStats.badMs = 0;
  focusStats.alerts = 0;
  focusStats.issues = { neck: 0, shoulders: 0, tilt: 0, distance: 0 };
  focusStats.activeIssueKeys.clear();
}

function setPhase(phase, autoStart = false) {
  timer.phase = phase;
  timer.total = phaseDurationMs(phase);
  timer.remaining = timer.total;
  timer.endAt = Date.now() + timer.remaining;
  timer.running = autoStart;
  el.phase.textContent = phase === "focus" ? "Enfoque" : "Descanso";
  el.ring.style.stroke = phase === "focus" ? "var(--accent)" : "var(--warn)";
  renderTimer();
}

async function startTimer() {
  ensureAudio(); // el gesto del usuario desbloquea el audio
  if (timer.phase === "focus" && !focusStats.startedAt) {
    el.btnStart.disabled = true;
    try {
      bindFocusAccount(focusStats, await resolveStatsAccount());
    } catch {
      // Guest timer remains available; no private history is attributed.
      bindFocusAccount(focusStats, null);
    } finally {
      el.btnStart.disabled = false;
    }
  }
  if (timer.remaining <= 0) timer.remaining = phaseDurationMs(timer.phase);
  timer.endAt = Date.now() + timer.remaining;
  timer.running = true;
  if (timer.phase === "focus") beginFocusStats();
  el.btnStart.textContent = "Pausar";
  el.timeHint.textContent = timer.phase === "focus" ? "en marcha" : "descansando";
  posture.lastFrameAt = performance.now();

  if (timer.phase === "focus") {
    const ok = await startCamera();
    if (ok && !posture.baseline) {
      setMessage("Pulsa «Calibrar postura» sentado como quieres estar durante la sesión.");
    }
  }
  renderTimer();
}

function pauseTimer() {
  if (timer.phase === "focus") stopFocusStats();
  timer.running = false;
  el.btnStart.textContent = "Reanudar";
  el.timeHint.textContent = "en pausa";
  el.holdFill.style.width = "0%";
  posture.badSince = null;
  clearAlert();
  if (el.camOnlyRunning.checked) stopCamera();
  renderTimer();
}

function resetTimer() {
  stopFocusStats();
  resetFocusStats();
  timer.running = false;
  timer.session = 1;
  timer.completed = 0;
  posture.goodMs = 0;
  posture.badMs = 0;
  posture.alerts = 0;
  posture.badSince = null;
  clearAlert();
  setPhase("focus");
  el.btnStart.textContent = "Iniciar";
  el.timeHint.textContent = "listo para empezar";
  el.cycle.textContent = "Sesión 1";
  if (el.camOnlyRunning.checked) stopCamera();
  updateStats(true);
}

function completePhase({ skipped = false } = {}) {
  soundPhaseEnd();
  clearAlert();

  if (timer.phase === "focus") {
    stopFocusStats();
    timer.completed += 1;
    if (!skipped && focusStats.elapsedMs > 0) recordCompletedFocus();
    resetFocusStats();
    setPhase("break", true);
    el.timeHint.textContent = "descansa y estírate";
    if (el.camOnlyRunning.checked) stopCamera();
  } else {
    timer.session += 1;
    el.cycle.textContent = `Sesión ${timer.session}`;
    setPhase("focus", false);
    el.btnStart.textContent = "Iniciar";
    el.timeHint.textContent = "listo para la siguiente";
  }
  updateStats(true);
}

function skipPhase() {
  timer.remaining = 0;
  completePhase({ skipped: true });
}

function tick() {
  if (timer.running) {
    timer.remaining = Math.max(0, timer.endAt - Date.now());
    if (timer.remaining === 0) {
      completePhase();
      return;
    }
  }
  renderTimer();
}

function renderTimer() {
  const secs = Math.ceil(timer.remaining / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  el.time.textContent = `${mm}:${ss}`;

  const progress = timer.total ? 1 - timer.remaining / timer.total : 0;
  el.ring.style.strokeDashoffset = String(RING_LEN * progress);

  const phaseName = timer.phase === "focus" ? "Enfoque" : "Descanso";
  document.title = timer.running
    ? `${mm}:${ss} · ${phaseName} · Postava`
    : "Postava · Pomodoro con postura";
}

/* ─────────────────────────────────────────────────────────────────────────
   Eventos
   ───────────────────────────────────────────────────────────────────────── */
el.btnStart.addEventListener("click", () => {
  timer.running ? pauseTimer() : startTimer();
});

el.btnSkip.addEventListener("click", skipPhase);
el.btnReset.addEventListener("click", resetTimer);
el.btnCalibrate.addEventListener("click", startCalibration);

el.btnCamera.addEventListener("click", () => {
  camOn ? stopCamera() : startCamera();
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    el.focusMins.value = chip.dataset.minutes;
    el.focusMins.dispatchEvent(new Event("change"));
    syncChips();
  });
});

function syncChips() {
  document.querySelectorAll(".chip").forEach((c) => {
    c.setAttribute("aria-pressed", String(c.dataset.minutes === el.focusMins.value));
  });
}

[el.focusMins, el.breakMins].forEach((input) => {
  input.addEventListener("change", () => {
    input.value = clamp(+input.value || 1, +input.min, +input.max);
    syncChips();
    if (!timer.running) setPhase(timer.phase);
    saveSettings();
  });
});

el.tolerance.addEventListener("input", () => {
  const v = +el.tolerance.value;
  el.tolValue.textContent = v < 0.9 ? "estricta" : v > 1.3 ? "relajada" : "normal";
  saveSettings();
});

el.delaySeconds.addEventListener("input", () => {
  el.delayValue.textContent = `${el.delaySeconds.value} s`;
  saveSettings();
});

el.hideVideoToggle.addEventListener("change", () => {
  el.stage.dataset.hideVideo = String(el.hideVideoToggle.checked);
  saveSettings();
});

[el.soundToggle, el.skeletonToggle, el.hudToggle, el.camOnlyRunning].forEach((c) =>
  c.addEventListener("change", saveSettings)
);

document.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName);
  if (typing) return;
  if (e.code === "Space") {
    e.preventDefault();
    timer.running ? pauseTimer() : startTimer();
  } else if (e.key.toLowerCase() === "c") {
    startCalibration();
  }
});

window.addEventListener("beforeunload", () => {
  if (stream) stream.getTracks().forEach((t) => t.stop());
});

/* ─────────────────────────────────────────────────────────────────────────
   Arranque
   ───────────────────────────────────────────────────────────────────────── */
el.btnCalibrate.disabled = true;
el.btnCamera.disabled = true;

loadSettings();
syncChips();
el.stage.dataset.hideVideo = String(el.hideVideoToggle.checked);
el.tolValue.textContent =
  +el.tolerance.value < 0.9 ? "estricta" : +el.tolerance.value > 1.3 ? "relajada" : "normal";
el.delayValue.textContent = `${el.delaySeconds.value} s`;

// Longitud real del trazo del aro, para que el progreso cierre exacto
if (typeof el.ring.getTotalLength === "function") {
  RING_LEN = el.ring.getTotalLength() || RING_LEN;
  el.ring.style.strokeDasharray = String(RING_LEN);
}

setPhase("focus");
setBadge("idle", "Sin monitorizar");
setInterval(tick, 250);
updateStats(true);
resumePendingStats();
initEngine();

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
      camOn = on;
    },
    evaluate,
    draw,
    startCalibration,
    handleCalibration,
  };
}
