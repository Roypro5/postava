import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  createPostureMonitor,
  INFER_INTERVAL,
  MODEL_URL,
  RECOVERY_MS,
  REALERT_MS,
  WASM_BASE,
} from "../posture-monitor.js";
import { createFocusStats } from "../focus-stats.js";
import { computeMetrics, ISSUE_TEXT, LM, smooth } from "../posture.js";

const ASPECT = 640 / 480;
const BASE = { neck: 0.75, width: 0.533, tilt: 0, side: 0, chin: 0.094, shoulderY: 0.85 };
const BAD_NECK = { ...BASE, neck: 0.54 }; // (0.75 - 0.54) / 0.75 = 0.28 > 0.16 (neckDrop)

/* Landmarks sintéticos: solo los puntos clave, con coordenadas "centinela" para
   comprobar que no se filtran a ningún callback. */
function makeLandmarks({ earY = 0.35, visibility = 0.83217 } = {}) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility }));
  lm[LM.NOSE] = { x: 0.50123456, y: 0.38, visibility };
  lm[LM.L_EAR] = { x: 0.45, y: earY, visibility };
  lm[LM.R_EAR] = { x: 0.55, y: earY, visibility };
  lm[LM.L_SHOULDER] = { x: 0.35, y: 0.6, visibility };
  lm[LM.R_SHOULDER] = { x: 0.65, y: 0.6, visibility };
  return lm;
}
const GOOD_LANDMARKS = makeLandmarks();
const BAD_LANDMARKS = makeLandmarks({ earY: 0.45 }); // cabeza hundida

function fakeVision({ gpuFails = false, cpuFails = false, resolverFails = false, frames = () => null } = {}) {
  const calls = { forVisionTasks: [], createFromOptions: [], detect: [] };
  const landmarker = {
    detectForVideo(video, timestamp) {
      calls.detect.push({ video, timestamp });
      const landmarks = frames();
      return landmarks ? { landmarks: [landmarks] } : { landmarks: [] };
    },
  };
  const mediapipe = {
    FilesetResolver: {
      async forVisionTasks(base) {
        calls.forVisionTasks.push(base);
        if (resolverFails) throw new Error("wasm no disponible");
        return { fileset: true };
      },
    },
    PoseLandmarker: {
      async createFromOptions(vision, options) {
        calls.createFromOptions.push({ vision, options });
        const { delegate } = options.baseOptions;
        if (delegate === "GPU" && gpuFails) throw new Error("sin WebGL");
        if (delegate === "CPU" && cpuFails) throw new Error("sin CPU");
        return landmarker;
      },
    },
  };
  return { mediapipe, calls, landmarker };
}

function fakeFocusStats() {
  const calls = [];
  return {
    calls,
    addBad: (dt, keys) => calls.push(["addBad", dt, keys]),
    addGood: (dt) => calls.push(["addGood", dt]),
    addAlert: () => calls.push(["addAlert"]),
    clearActiveIssues: () => calls.push(["clearActiveIssues"]),
  };
}

function setup({
  settings = {},
  timer: timerState = {},
  cameraOn = true,
  vision = fakeVision(),
  focusStats = fakeFocusStats(),
  startCamera,
  ...options
} = {}) {
  const events = [];
  const logs = [];
  const clock = { t: 10_000 };
  const cfg = {
    tolerance: 1,
    delaySeconds: 5,
    showSkeleton: true,
    showHud: true,
    hideVideo: false,
    ...settings,
  };
  const timer = { running: true, phase: "focus", ...timerState };
  const camera = { on: cameraOn };
  const video = { readyState: 4, currentTime: 0, videoWidth: 640, videoHeight: 480 };
  const canvas = { width: 640, height: 480 };
  const ctx = { fakeCtx: true };
  const rafs = { nextId: 1, pending: new Map(), cancelled: [] };
  const drawn = [];
  const badge = { state: "idle" };

  const monitor = createPostureMonitor({
    video,
    canvas,
    ctx,
    timer,
    focusStats,
    isCameraOn: () => camera.on,
    startCamera:
      startCamera ??
      (async () => {
        events.push(["startCamera"]);
        camera.on = true;
        return true;
      }),
    mediapipe: vision.mediapipe,
    getSettings: () => cfg,
    getBadgeState: () => badge.state,
    clock: () => clock.t,
    requestFrame: (callback) => {
      const id = rafs.nextId++;
      rafs.pending.set(id, callback);
      return id;
    },
    cancelFrame: (id) => {
      rafs.cancelled.push(id);
      rafs.pending.delete(id);
    },
    drawOverlay: (drawCtx, w, h, landmarks, state) =>
      drawn.push({ ctx: drawCtx, w, h, landmarks, state, snapshot: { ...state } }),
    logger: {
      info: (...args) => logs.push(["info", ...args]),
      error: (...args) => logs.push(["error", ...args]),
    },
    onBadge: (state, text) => {
      badge.state = state;
      events.push(["badge", state, text]);
    },
    onMessage: (text) => events.push(["message", text]),
    onHold: (hold) => events.push(["hold", hold]),
    onStats: (force) => events.push(["stats", force]),
    onAlert: (alert) => events.push(["alert", alert]),
    onClear: () => events.push(["clear"]),
    onSound: () => events.push(["sound"]),
    onNotify: (notice) => events.push(["notify", notice]),
    onCalibrationStart: (payload) => events.push(["calibStart", payload]),
    onCalibrationProgress: (payload) => events.push(["calibProgress", payload]),
    onCalibrationEnd: (payload) => events.push(["calibEnd", payload]),
    onCalibrated: (payload) => events.push(["calibrated", payload]),
    onEngineReady: () => events.push(["engineReady"]),
    onEngineError: (err) => events.push(["engineError", err]),
    ...options,
  });

  const of = (kind) => events.filter((e) => e[0] === kind);
  const lastOf = (kind) => of(kind).at(-1);
  const mark = () => events.length;
  const since = (index) => events.slice(index);
  /* Avanza el reloj y evalúa un fotograma de métricas sintéticas */
  const step = (metrics, ms = 100) => {
    clock.t += ms;
    monitor.evaluate(metrics, clock.t);
  };
  /* Ejecuta el último rAF pendiente avanzando reloj y vídeo (una inferencia) */
  const frame = (ms = 100) => {
    clock.t += ms;
    video.currentTime += ms / 1000;
    const [id, callback] = [...rafs.pending].at(-1);
    rafs.pending.delete(id);
    callback();
  };

  return {
    monitor, events, logs, clock, cfg, timer, camera, video, canvas, ctx, rafs, drawn, badge,
    vision, focusStats, of, lastOf, mark, since, step, frame,
  };
}

async function readySetup(options) {
  const s = setup(options);
  await s.monitor.initEngine();
  s.events.length = 0;
  return s;
}

/* ── Motor: initEngine ─────────────────────────────────────────────────── */

test("las URLs de MediaPipe y el modelo se conservan exactamente", () => {
  assert.equal(WASM_BASE, "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  assert.equal(
    MODEL_URL,
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
  );
  assert.equal(INFER_INTERVAL, 66);
  assert.equal(RECOVERY_MS, 1000);
  assert.equal(REALERT_MS, 20000);
});

test("initEngine: carga con delegado GPU, opciones exactas y avisa una vez", async () => {
  const s = setup();
  assert.equal(s.monitor.isEngineReady(), false);
  await s.monitor.initEngine();

  assert.deepEqual(s.vision.calls.forVisionTasks, [WASM_BASE]);
  assert.equal(s.vision.calls.createFromOptions.length, 1);
  assert.deepEqual(s.vision.calls.createFromOptions[0].vision, { fileset: true });
  assert.deepEqual(s.vision.calls.createFromOptions[0].options, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  assert.deepEqual(s.logs, [["info", "Postava: motor de postura listo con delegado GPU."]]);
  assert.equal(s.monitor.isEngineReady(), true);
  assert.deepEqual(s.events, [["engineReady"]]);
});

test("initEngine: si la GPU falla cae a CPU con las mismas opciones", async () => {
  const s = setup({ vision: fakeVision({ gpuFails: true }) });
  await s.monitor.initEngine();

  const delegates = s.vision.calls.createFromOptions.map((c) => c.options.baseOptions.delegate);
  assert.deepEqual(delegates, ["GPU", "CPU"]);
  const [gpu, cpu] = s.vision.calls.createFromOptions.map((c) => c.options);
  assert.deepEqual({ ...cpu, baseOptions: { ...cpu.baseOptions, delegate: "GPU" } }, gpu);
  assert.deepEqual(s.logs, [["info", "Postava: motor de postura listo con delegado CPU."]]);
  assert.equal(s.monitor.isEngineReady(), true);
  assert.deepEqual(s.events, [["engineReady"]]);
});

test("initEngine: si GPU y CPU fallan, registra el error, avisa y no queda listo", async () => {
  const s = setup({ vision: fakeVision({ gpuFails: true, cpuFails: true }) });
  await s.monitor.initEngine();

  assert.equal(s.monitor.isEngineReady(), false);
  assert.equal(s.of("engineReady").length, 0);
  assert.equal(s.of("engineError").length, 1);
  assert.equal(s.of("engineError")[0][1].message, "sin CPU");
  assert.deepEqual(s.logs.map((l) => l[0]), ["error"]);
  assert.equal(s.logs[0][1].message, "sin CPU");

  // Sin motor, calibrar es un no-op
  s.monitor.startCalibration();
  assert.equal(s.of("calibStart").length, 0);
  assert.equal(s.monitor.state.calibrating, false);
});

test("initEngine: si el resolvedor WASM falla no llega a crear el landmarker", async () => {
  const s = setup({ vision: fakeVision({ resolverFails: true }) });
  await s.monitor.initEngine();

  assert.equal(s.vision.calls.createFromOptions.length, 0);
  assert.equal(s.monitor.isEngineReady(), false);
  assert.equal(s.of("engineError").length, 1);
  assert.equal(s.logs.filter((l) => l[0] === "error").length, 1);
});

test("initEngine: `mediapipe` puede ser una función (import dinámico) que devuelve el módulo o una promesa", async () => {
  for (const [name, factory] of [
    ["síncrona", (vision) => () => vision.mediapipe],
    ["asíncrona", (vision) => async () => vision.mediapipe],
  ]) {
    const vision = fakeVision();
    let loads = 0;
    const load = factory(vision);
    const s = setup({ vision, mediapipe: () => (loads++, load()) });
    await s.monitor.initEngine();

    assert.equal(loads, 1, `${name}: se importa una sola vez`);
    assert.deepEqual(vision.calls.forVisionTasks, [WASM_BASE], name);
    assert.equal(vision.calls.createFromOptions.length, 1, name);
    assert.equal(s.monitor.isEngineReady(), true, name);
    assert.deepEqual(s.events, [["engineReady"]], name);
  }
});

test("initEngine: si el import dinámico de MediaPipe falla (CDN caída) llega a onEngineError sin lanzar", async () => {
  const failure = new Error("CDN inaccesible");
  for (const [name, mediapipe] of [
    ["promesa rechazada", () => Promise.reject(failure)],
    ["lanza síncrono", () => { throw failure; }],
  ]) {
    const s = setup({ mediapipe });
    await assert.doesNotReject(() => s.monitor.initEngine(), name);

    assert.equal(s.monitor.isEngineReady(), false, name);
    assert.deepEqual(s.events, [["engineError", failure]], name);
    assert.deepEqual(s.logs, [["error", failure]], name);
    // Sin motor, calibrar sigue siendo un no-op y el bucle no infiere
    s.monitor.startCalibration();
    assert.equal(s.of("calibStart").length, 0, name);
  }
});

/* ── Evaluación ────────────────────────────────────────────────────────── */

test("evaluate sin baseline: badge 'Sin calibrar' y barra a cero, sin contar nada", () => {
  const s = setup();
  s.step(BAD_NECK);
  assert.deepEqual(s.events, [
    ["badge", "idle", "Sin calibrar"],
    ["hold", { fraction: 0 }],
  ]);
  assert.deepEqual(s.focusStats.calls, []);
});

test("evaluate con buena postura: acumula goodMs y no avisa; recupera tras RECOVERY_MS", () => {
  const s = setup();
  s.monitor.state.baseline = { ...BASE };
  s.monitor.state.lastFrameAt = s.clock.t;

  for (let i = 0; i < 5; i++) s.step(BASE);
  assert.equal(s.monitor.state.goodMs, 500);
  assert.equal(s.monitor.state.badMs, 0);
  assert.equal(s.monitor.state.goodStreak, 500);
  assert.deepEqual(s.focusStats.calls, Array.from({ length: 5 }, () => ["addGood", 100]));
  assert.equal(s.of("alert").length, 0);
  assert.equal(s.of("badge").length, 0, "sin tramo malo no se repinta el badge hasta el umbral");

  for (let i = 0; i < 5; i++) s.step(BASE);
  assert.deepEqual(s.lastOf("badge"), ["badge", "good", "Postura correcta"]);
  assert.deepEqual(s.lastOf("hold"), ["hold", { fraction: 0 }]);
  assert.deepEqual(s.lastOf("stats"), ["stats", false]);
});

test("mala postura: avisa una sola vez al cumplirse el retardo, con banner, mensaje, sonido, stats y notificación", () => {
  const s = setup({ settings: { delaySeconds: 5 } });
  s.monitor.state.baseline = { ...BASE };
  s.monitor.state.lastFrameAt = s.clock.t;

  // 50 fotogramas (0..4900 ms de mala postura): todavía en cuenta atrás
  for (let i = 0; i < 50; i++) s.step(BAD_NECK);
  // step() avanza antes de evaluar, así que el primero fija badSince y el 50º lleva 4900 ms
  assert.equal(s.of("alert").length, 0);
  assert.equal(s.monitor.state.alerting, false);
  assert.deepEqual(s.lastOf("badge"), ["badge", "warn", "Postura mejorable"]);
  assert.deepEqual(s.lastOf("message"), ["message", ISSUE_TEXT.neckDrop]);
  assert.equal(s.monitor.state.showingIssue, true);
  assert.equal(s.of("hold")[0][1].tone, "warn");
  assert.equal(s.of("hold")[0][1].fraction, 0);
  assert.ok(s.lastOf("hold")[1].fraction > 0.97 && s.lastOf("hold")[1].fraction < 1);

  const before = s.mark();
  s.step(BAD_NECK); // held = 5000 ms
  const fired = s.since(before);
  assert.deepEqual(fired, [
    ["hold", { fraction: 1, tone: "bad" }],
    ["badge", "bad", "Corrige la postura"],
    ["alert", { issueKey: "neckDrop", text: ISSUE_TEXT.neckDrop }],
    ["message", ISSUE_TEXT.neckDrop],
    ["sound"],
    ["stats", true],
    ["notify", { issueKey: "neckDrop", text: ISSUE_TEXT.neckDrop }],
    ["stats", false],
  ]);
  assert.equal(s.monitor.state.alerts, 1);
  assert.equal(s.monitor.state.alerting, true);
  assert.equal(s.monitor.state.lastAlertAt, s.clock.t);
  assert.equal(s.focusStats.calls.filter((c) => c[0] === "addAlert").length, 1);
  assert.deepEqual(s.focusStats.calls.find((c) => c[0] === "addBad"), ["addBad", 100, ["neckDrop"]]);

  // Mientras siga mal no se repite hasta REALERT_MS
  const afterFirst = s.mark();
  while (s.clock.t - s.monitor.state.lastAlertAt < REALERT_MS - 100) s.step(BAD_NECK);
  assert.equal(s.since(afterFirst).filter((e) => e[0] === "alert").length, 0);
  s.step(BAD_NECK); // +REALERT_MS exactos
  assert.equal(s.since(afterFirst).filter((e) => e[0] === "alert").length, 1);
  assert.equal(s.monitor.state.alerts, 2);
});

test("el retardo usa delaySeconds del ajuste y cae a 5 s si no es un número válido", () => {
  const alertsAfter = (delaySeconds, frames) => {
    const s = setup({ settings: { delaySeconds } });
    s.monitor.state.baseline = { ...BASE };
    s.monitor.state.lastFrameAt = s.clock.t;
    for (let i = 0; i < frames; i++) s.step(BAD_NECK);
    return s.monitor.state.alerts;
  };
  assert.equal(alertsAfter(2, 20), 0); // 1900 ms
  assert.equal(alertsAfter(2, 21), 1); // 2000 ms
  assert.equal(alertsAfter(NaN, 50), 0);
  assert.equal(alertsAfter(NaN, 51), 1); // por defecto 5 s
  assert.equal(alertsAfter(0, 51), 1);
});

test("recuperación tras un aviso: la barra se encoge y a RECOVERY_MS se limpia el aviso una vez", () => {
  const s = setup({ settings: { delaySeconds: 1 } });
  s.monitor.state.baseline = { ...BASE };
  s.monitor.state.lastFrameAt = s.clock.t;
  for (let i = 0; i < 11; i++) s.step(BAD_NECK);
  assert.equal(s.monitor.state.alerting, true);
  assert.equal(s.of("clear").length, 0);

  const before = s.mark();
  s.step(BASE); // 100 ms buenos
  assert.deepEqual(s.since(before).find((e) => e[0] === "hold"), ["hold", { fraction: 1 - 100 / RECOVERY_MS }]);
  assert.equal(s.monitor.state.alerting, true);
  for (let i = 0; i < 8; i++) s.step(BASE); // 900 ms
  assert.equal(s.of("clear").length, 0);

  const beforeRecovery = s.mark();
  s.step(BASE); // 1000 ms: recuperada
  assert.deepEqual(s.since(beforeRecovery), [
    ["hold", { fraction: 0 }],
    ["clear"],
    ["message", "Bien, postura recuperada."],
    ["badge", "good", "Postura correcta"],
    ["hold", { fraction: 0 }],
    ["stats", false],
  ]);
  assert.equal(s.monitor.state.alerting, false);
  assert.equal(s.monitor.state.showingIssue, false);
  assert.equal(s.monitor.state.badSince, null);
  assert.equal(s.monitor.state.lastAlertAt, 0);
  assert.equal(s.of("clear").length, 1);
  assert.equal(s.of("alert").length, 1);
});

test("recuperación antes del aviso: mensaje 'Todo en orden' sin limpiar ningún cartel", () => {
  const s = setup({ settings: { delaySeconds: 5 } });
  s.monitor.state.baseline = { ...BASE };
  s.monitor.state.lastFrameAt = s.clock.t;
  for (let i = 0; i < 10; i++) s.step(BAD_NECK); // 1 s mal, sin aviso
  assert.equal(s.monitor.state.alerting, false);
  for (let i = 0; i < 10; i++) s.step(BASE);

  assert.deepEqual(s.of("message").at(-1), ["message", "Todo en orden, sigue así."]);
  assert.equal(s.of("clear").length, 0);
  assert.equal(s.of("alert").length, 0);
  assert.equal(s.monitor.state.badSince, null);
  assert.deepEqual(s.lastOf("badge"), ["badge", "good", "Postura correcta"]);
});

test("la tolerancia escala los umbrales (y 0/NaN caen a 1)", () => {
  const neck = { ...BASE, neck: 0.6 }; // desviación 0.20: mala a 1, buena a 1.5
  const badnessAt = (tolerance, metrics) => {
    const s = setup({ settings: { tolerance }, timer: { running: false } });
    s.monitor.state.baseline = { ...BASE };
    s.step(metrics);
    return s.lastOf("badge")[2];
  };
  assert.equal(badnessAt(1, neck), "Postura mejorable");
  assert.equal(badnessAt(1.5, neck), "Postura correcta");
  assert.equal(badnessAt(0.5, { ...BASE, neck: 0.68 }), "Postura mejorable"); // 0.093 > 0.08
  assert.equal(badnessAt(1, { ...BASE, neck: 0.68 }), "Postura correcta");
  assert.equal(badnessAt(NaN, neck), "Postura mejorable");
  assert.equal(badnessAt(0, neck), "Postura mejorable");
});

test("solo cuenta y avisa cuando monitoringActive(); si no, muestra el estado sin acumular", () => {
  const cases = [
    { name: "temporizador parado", options: { timer: { running: false } } },
    { name: "fase de descanso", options: { timer: { phase: "break" } } },
    { name: "cámara apagada", options: { cameraOn: false } },
  ];
  for (const { name, options } of cases) {
    const s = setup({ settings: { delaySeconds: 1 }, ...options });
    s.monitor.state.baseline = { ...BASE };
    assert.equal(s.monitor.monitoringActive(), false, name);

    for (let i = 0; i < 30; i++) s.step(BAD_NECK);
    assert.deepEqual(s.focusStats.calls, Array.from({ length: 30 }, () => ["clearActiveIssues"]), name);
    assert.equal(s.of("alert").length, 0, name);
    assert.equal(s.of("sound").length, 0, name);
    assert.equal(s.of("stats").length, 0, name);
    assert.equal(s.monitor.state.badMs, 0, name);
    assert.equal(s.monitor.state.alerts, 0, name);
    assert.equal(s.monitor.state.badSince, null, name);
    assert.deepEqual(s.lastOf("badge"), ["badge", "warn", "Postura mejorable"], name);
    assert.deepEqual(s.lastOf("hold"), ["hold", { fraction: 0 }], name);

    s.step(BASE);
    assert.deepEqual(s.lastOf("badge"), ["badge", "good", "Postura correcta"], name);
  }
});

test("monitoringActive combina cámara, temporizador en marcha, fase de enfoque y baseline", () => {
  const s = setup();
  assert.equal(s.monitor.monitoringActive(), false); // sin baseline
  s.monitor.state.baseline = { ...BASE };
  assert.equal(s.monitor.monitoringActive(), true);
  s.timer.running = false;
  assert.equal(s.monitor.monitoringActive(), false);
  s.timer.running = true;
  s.timer.phase = "break";
  assert.equal(s.monitor.monitoringActive(), false);
  s.timer.phase = "focus";
  s.camera.on = false;
  assert.equal(s.monitor.monitoringActive(), false);
});

test("evaluate acota dt a 200 ms entre fotogramas", () => {
  const s = setup();
  s.monitor.state.baseline = { ...BASE };
  s.monitor.state.lastFrameAt = s.clock.t;
  s.step(BASE, 5_000); // pausa larga: cuenta como máximo 200 ms
  assert.equal(s.monitor.state.goodMs, 200);
  assert.deepEqual(s.focusStats.calls, [["addGood", 200]]);
});

test("acumula en la instancia real de focus-stats (addBad/addGood/addAlert)", () => {
  const clock = { t: 10_000 };
  const focusStats = createFocusStats(() => clock.t);
  const s = setup({ focusStats, settings: { delaySeconds: 1 } });
  s.monitor.state.baseline = { ...BASE };
  s.monitor.state.lastFrameAt = s.clock.t;

  for (let i = 0; i < 11; i++) s.step(BAD_NECK); // 1 s mal → 1 aviso
  for (let i = 0; i < 5; i++) s.step(BASE);
  assert.equal(focusStats.badMs, 1100);
  assert.equal(focusStats.goodMs, 500);
  assert.equal(focusStats.alerts, 1);
  assert.deepEqual(focusStats.issues, { neck: 1, shoulders: 0, tilt: 0, distance: 0 });
});

test("varias incidencias a la vez: avisa de la más grave y focus-stats cuenta cada una una sola vez mientras sigue activa", () => {
  const focusStats = createFocusStats(() => 10_000);
  const s = setup({ focusStats, settings: { delaySeconds: 1 } });
  s.monitor.state.baseline = { ...BASE };
  s.monitor.state.lastFrameAt = s.clock.t;
  const both = { ...BASE, neck: 0.54, width: 0.7 }; // proximity (2,24x) más grave que neckDrop (1,75x)
  const onlyNeck = { ...BASE, neck: 0.54 };

  for (let i = 0; i < 11; i++) s.step(both); // 1 s → aviso
  assert.equal(s.of("alert").length, 1);
  assert.deepEqual(s.of("alert")[0][1], { issueKey: "proximity", text: ISSUE_TEXT.proximity });
  assert.deepEqual(focusStats.issues, { neck: 1, shoulders: 0, tilt: 0, distance: 1 });

  s.step(onlyNeck); // proximity corregida, neckDrop sigue activa: no se recuenta
  assert.deepEqual(focusStats.issues, { neck: 1, shoulders: 0, tilt: 0, distance: 1 });
  s.step(both); // proximity reaparece: es una incidencia nueva
  assert.deepEqual(focusStats.issues, { neck: 1, shoulders: 0, tilt: 0, distance: 2 });

  s.step(BASE); // un fotograma bueno limpia las incidencias activas
  s.step(both);
  assert.deepEqual(focusStats.issues, { neck: 2, shoulders: 0, tilt: 0, distance: 3 });
  assert.equal(focusStats.alerts, 1);
});

/* ── Avisos ────────────────────────────────────────────────────────────── */

test("raiseAlert llama a cada callback una vez, en orden, y acumula el aviso", () => {
  const s = setup();
  s.monitor.raiseAlert("slump");

  const text = ISSUE_TEXT.slump;
  assert.deepEqual(s.events, [
    ["alert", { issueKey: "slump", text }],
    ["message", text],
    ["sound"],
    ["stats", true],
    ["notify", { issueKey: "slump", text }],
  ]);
  assert.deepEqual(s.focusStats.calls, [["addAlert"]]);
  assert.equal(s.monitor.state.alerts, 1);
  assert.equal(s.monitor.state.alerting, true);
  assert.equal(s.monitor.state.showingIssue, true);
});

test("clearAlert llama a onClear una vez y desactiva el aviso", () => {
  const s = setup();
  s.monitor.state.alerting = true;
  s.monitor.clearAlert();
  assert.deepEqual(s.events, [["clear"]]);
  assert.equal(s.monitor.state.alerting, false);
});

test("handleNotDetected: badge 'No te veo' y, pasados 3 s, mensaje + fin del tramo malo + limpia aviso", () => {
  const s = setup();
  const state = s.monitor.state;
  state.lastSeenAt = s.clock.t;
  state.badSince = 123;
  state.alerting = true;

  s.clock.t += 3000;
  s.monitor.handleNotDetected(s.clock.t); // exactamente 3000: aún no
  assert.equal(state.lastFrameAt, s.clock.t);
  assert.deepEqual(s.events, [
    ["hold", { fraction: 0 }],
    ["badge", "idle", "No te veo"],
  ]);
  assert.deepEqual(s.focusStats.calls, [["clearActiveIssues"]]);
  assert.equal(state.badSince, 123);
  assert.equal(state.alerting, true);

  s.events.length = 0;
  s.clock.t += 1;
  s.monitor.handleNotDetected(s.clock.t);
  assert.deepEqual(s.events, [
    ["hold", { fraction: 0 }],
    ["badge", "idle", "No te veo"],
    ["message", "No detecto tu cabeza y hombros. Colócate frente a la cámara."],
    ["clear"],
  ]);
  assert.equal(state.badSince, null);
  assert.equal(state.alerting, false);
});

/* ── Calibración ───────────────────────────────────────────────────────── */

test("startCalibration exige motor listo y no reentra mientras se calibra", async () => {
  const notReady = setup();
  notReady.monitor.startCalibration();
  assert.deepEqual(notReady.events, []);
  assert.equal(notReady.monitor.state.calibrating, false);

  const s = await readySetup();
  s.monitor.startCalibration();
  assert.equal(s.monitor.state.calibrating, true);
  assert.equal(s.monitor.state.calibEndsAt, s.clock.t + 4000);
  assert.deepEqual(s.events, [
    ["calibStart", { hint: "Siéntate recto y mira a la pantalla" }],
    ["clear"],
    ["badge", "idle", "Calibrando…"],
    ["message", "Estos son los puntos que voy a medir: orejas, nariz y hombros."],
  ]);
  s.events.length = 0;
  s.monitor.startCalibration();
  assert.deepEqual(s.events, []);
});

test("startCalibration con la cámara apagada la enciende primero y calibra solo si arranca", async () => {
  const ok = await readySetup({ cameraOn: false });
  ok.monitor.startCalibration();
  assert.equal(ok.monitor.state.calibrating, false); // aún esperando a la cámara
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ok.of("startCamera"), [["startCamera"]]);
  assert.equal(ok.monitor.state.calibrating, true);
  assert.equal(ok.of("calibStart").length, 1);

  const denied = await readySetup({ cameraOn: false, startCamera: async () => false });
  denied.monitor.startCalibration();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(denied.monitor.state.calibrating, false);
  assert.deepEqual(denied.events, []);
});

test("handleCalibration: cuenta atrás, pistas y muestreo solo en los últimos 3 s", async () => {
  const s = await readySetup();
  s.monitor.startCalibration();
  s.events.length = 0;
  const end = s.monitor.state.calibEndsAt;
  const progress = (left, usable = true) => {
    s.monitor.handleCalibration(GOOD_LANDMARKS, usable, end - left);
    return s.lastOf("calibProgress")[1];
  };

  assert.deepEqual(progress(3500), { count: 4, hint: "Siéntate recto y mira a la pantalla" });
  assert.equal(s.monitor.state.calibSamples.length, 0);
  assert.deepEqual(progress(3000), { count: 3, hint: "Siéntate recto y mira a la pantalla" });
  assert.equal(s.monitor.state.calibSamples.length, 0);
  assert.deepEqual(progress(2999), { count: 3, hint: "Capturando puntos… 1 muestras" });
  assert.deepEqual(progress(1500, false), { count: 2, hint: "No te veo bien: encuadra cabeza y hombros" });
  assert.equal(s.monitor.state.calibSamples.length, 1, "un fotograma no usable no muestrea");
  assert.deepEqual(progress(100), { count: 1, hint: "Capturando puntos… 2 muestras" });
  assert.equal(s.of("calibEnd").length, 0);
});

test("calibración con muestras válidas fija el baseline, avisa y guarda vía onCalibrated", async () => {
  const s = await readySetup();
  s.monitor.startCalibration();
  s.events.length = 0;
  const start = s.clock.t;
  for (let t = 100; t <= 4000; t += 100) s.monitor.handleCalibration(GOOD_LANDMARKS, true, start + t);

  const expected = computeMetrics(GOOD_LANDMARKS, ASPECT);
  const state = s.monitor.state;
  assert.equal(state.calibrating, false);
  assert.deepEqual(state.calibSamples, []);
  for (const key of Object.keys(expected)) assert.ok(Math.abs(state.baseline[key] - expected[key]) < 1e-9, key);
  assert.deepEqual(state.smoothed, state.baseline);
  assert.notEqual(state.smoothed, state.baseline, "smoothed es una copia, no el mismo objeto");
  assert.equal(state.badSince, null);
  assert.equal(state.goodStreak, 0);
  assert.equal(state.showingIssue, false);

  assert.equal(s.of("calibEnd").length, 1);
  assert.deepEqual(s.of("calibEnd")[0], ["calibEnd", { engineReady: true }]);
  assert.equal(s.of("calibrated").length, 1);
  assert.equal(s.of("calibrated")[0][1].baseline, state.baseline);
  const tail = s.events.slice(-4).map((e) => e[0]);
  assert.deepEqual(tail, ["calibEnd", "calibrated", "badge", "message"]);
  assert.deepEqual(s.lastOf("badge"), ["badge", "good", "Postura correcta"]);
  assert.deepEqual(s.lastOf("message"), [
    "message",
    "Calibrado. Oculto la imagen y dejo solo el mapa de puntos; te avisaré si te desvías.",
  ]);
  assert.equal(s.of("calibProgress").at(-1)[1].count, 1);
});

test("calibración con pocas muestras válidas: mensaje 'No he podido verte bien' y sin baseline", async () => {
  const s = await readySetup();
  s.monitor.startCalibration();
  s.events.length = 0;
  const end = s.monitor.state.calibEndsAt;
  for (const left of [2500, 2000, 1500]) s.monitor.handleCalibration(GOOD_LANDMARKS, true, end - left);
  s.monitor.handleCalibration(null, false, end); // 3 muestras < 8

  const state = s.monitor.state;
  assert.equal(state.baseline, null);
  assert.equal(state.calibrating, false);
  assert.equal(s.of("calibrated").length, 0);
  assert.equal(s.of("calibEnd").length, 1);
  assert.deepEqual(s.of("message").at(-1), [
    "message",
    "No he podido verte bien. Asegúrate de que se vean cabeza y hombros, y vuelve a calibrar.",
  ]);
  assert.deepEqual(s.lastOf("badge"), ["badge", "idle", "Sin calibrar"]);
});

test("calibración con movimiento: mensaje 'Te has movido' y sin baseline", async () => {
  const s = await readySetup();
  s.monitor.startCalibration();
  s.events.length = 0;
  const end = s.monitor.state.calibEndsAt;
  const swaying = [GOOD_LANDMARKS, makeLandmarks({ earY: 0.25 })];
  for (let i = 0; i < 20; i++) {
    s.monitor.handleCalibration(swaying[i % 2], true, end - 2900 + i * 100);
  }
  s.monitor.handleCalibration(swaying[0], true, end);

  assert.equal(s.monitor.state.baseline, null);
  assert.equal(s.of("calibrated").length, 0);
  assert.deepEqual(s.of("message").at(-1), [
    "message",
    "Te has movido durante la calibración. Quédate quieto y vuelve a intentarlo.",
  ]);
  assert.deepEqual(s.lastOf("badge"), ["badge", "idle", "Sin calibrar"]);
});

test("cancelCalibration vacía las muestras y avisa con el estado del motor", async () => {
  const notReady = setup();
  notReady.monitor.state.calibrating = true;
  notReady.monitor.state.calibSamples = [{}, {}];
  notReady.monitor.cancelCalibration();
  assert.equal(notReady.monitor.state.calibrating, false);
  assert.deepEqual(notReady.monitor.state.calibSamples, []);
  assert.deepEqual(notReady.events, [["calibEnd", { engineReady: false }]]);

  const s = await readySetup();
  s.monitor.cancelCalibration();
  assert.deepEqual(s.events, [["calibEnd", { engineReady: true }]]);
});

/* ── Bucle de inferencia y rAF ─────────────────────────────────────────── */

test("start() programa el bucle y stop() cancela el rAF pendiente (una sola vez)", async () => {
  const s = await readySetup();
  s.monitor.start();
  assert.equal(s.rafs.pending.size, 1);
  const firstId = [...s.rafs.pending.keys()][0];
  s.frame();
  assert.equal(s.rafs.pending.size, 1, "cada fotograma reprograma el siguiente");
  const currentId = [...s.rafs.pending.keys()][0];
  assert.notEqual(currentId, firstId);

  s.monitor.stop();
  assert.deepEqual(s.rafs.cancelled, [currentId]);
  assert.equal(s.rafs.pending.size, 0);
  s.monitor.stop();
  assert.deepEqual(s.rafs.cancelled, [currentId], "stop() es idempotente");
});

test("el bucle no se reprograma si la cámara está apagada", async () => {
  const s = await readySetup({ cameraOn: false });
  s.monitor.start();
  assert.equal(s.rafs.pending.size, 0);
  s.monitor.stop();
  assert.deepEqual(s.rafs.cancelled, []);
});

/* Simula el navegador: en cada fotograma se ejecutan TODOS los rAF pendientes. */
function tickAll(s, ms = 100) {
  s.clock.t += ms;
  s.video.currentTime += ms / 1000;
  const callbacks = [...s.rafs.pending.values()];
  s.rafs.pending.clear();
  for (const callback of callbacks) callback();
}

test("start() es idempotente: varios start() dejan UN solo bucle y stop() lo cancela entero", async () => {
  const vision = fakeVision({ frames: () => GOOD_LANDMARKS });
  const s = await readySetup({ vision });

  s.monitor.start();
  const firstId = [...s.rafs.pending.keys()][0];
  s.monitor.start(); // p. ej. botón de cámara + tecla C con el permiso pendiente
  assert.equal(s.rafs.pending.size, 1, "un solo rAF pendiente tras dos start()");
  assert.deepEqual(s.rafs.cancelled, [firstId], "el segundo start() cancela el rAF del primero");

  const detectionsAfterStarts = vision.calls.detect.length;
  for (let i = 0; i < 5; i++) {
    tickAll(s);
    assert.equal(s.rafs.pending.size, 1, "cada fotograma reprograma exactamente un rAF (no hay dos cadenas)");
  }
  assert.equal(vision.calls.detect.length, detectionsAfterStarts + 5, "una inferencia por fotograma");

  s.monitor.start();
  s.monitor.start();
  assert.equal(s.rafs.pending.size, 1);

  s.monitor.stop();
  assert.equal(s.rafs.pending.size, 0, "stop() no deja ningún rAF vivo");
  const detections = vision.calls.detect.length;
  tickAll(s); // no hay nada que ejecutar
  assert.equal(vision.calls.detect.length, detections, "tras stop() no se infiere más");
  s.monitor.stop();
});

test("start() tras apagarse la cámara no cancela un rAF que ya disparó (id obsoleto)", async () => {
  const s = await readySetup();
  s.monitor.start();
  s.camera.on = false;
  tickAll(s); // el bucle ve la cámara apagada y termina sin reprogramar
  assert.equal(s.rafs.pending.size, 0);

  s.camera.on = true;
  s.rafs.cancelled.length = 0;
  s.monitor.start();
  assert.deepEqual(s.rafs.cancelled, [], "no hay ningún rAF pendiente que cancelar");
  assert.equal(s.rafs.pending.size, 1);
});

test("start() reinicia lastFrameAt, lastSeenAt y lastVideoTime", async () => {
  const vision = fakeVision({ frames: () => GOOD_LANDMARKS });
  const s = await readySetup({ vision });
  s.clock.t = 50_000;
  s.video.currentTime = 7;
  s.monitor.start();
  assert.equal(s.monitor.state.lastFrameAt, 50_000);
  assert.equal(s.monitor.state.lastSeenAt, 50_000);
  assert.equal(vision.calls.detect.length, 1);

  // Con lastVideoTime = -1, start() procesa el fotograma aunque currentTime no haya cambiado
  s.monitor.stop();
  s.clock.t += 1000;
  s.monitor.start();
  assert.equal(vision.calls.detect.length, 2);
  assert.equal(s.monitor.state.lastFrameAt, 51_000);
});

test("el bucle respeta INFER_INTERVAL, readyState y currentTime repetido", async () => {
  const vision = fakeVision({ frames: () => GOOD_LANDMARKS });
  const s = await readySetup({ vision });
  const detections = () => vision.calls.detect.length;

  s.video.readyState = 1;
  s.monitor.start();
  s.frame(100);
  assert.equal(detections(), 0, "vídeo sin datos suficientes");

  s.video.readyState = 4;
  s.frame(100);
  assert.equal(detections(), 1);
  const lastProcessedTime = s.video.currentTime;

  s.frame(INFER_INTERVAL - 1); // el vídeo avanza, pero han pasado menos de INFER_INTERVAL ms
  assert.equal(detections(), 1, "demasiado pronto");

  s.clock.t += 1; // ya han pasado INFER_INTERVAL ms desde la última inferencia
  s.video.currentTime = lastProcessedTime; // mismo fotograma de vídeo
  s.frame(0);
  assert.equal(detections(), 1, "mismo currentTime");

  s.frame(INFER_INTERVAL);
  assert.equal(detections(), 2);
  assert.equal(vision.calls.detect.at(-1).video, s.video);
  assert.equal(vision.calls.detect.at(-1).timestamp, s.clock.t);
});

test("el bucle no evalúa si el motor aún no está listo", () => {
  const vision = fakeVision({ frames: () => GOOD_LANDMARKS });
  const s = setup({ vision });
  s.monitor.start();
  s.frame();
  assert.equal(vision.calls.detect.length, 0);
  assert.deepEqual(s.drawn, []);
});

test("un error de detectForVideo se registra y no rompe el bucle", async () => {
  const vision = fakeVision();
  vision.landmarker.detectForVideo = () => {
    throw new Error("GPU perdida");
  };
  const s = await readySetup({ vision });
  s.monitor.start();
  assert.equal(s.logs.filter((l) => l[0] === "error").length, 1);
  s.frame();
  assert.equal(s.logs.filter((l) => l[0] === "error").length, 2);
  assert.equal(s.logs.at(-1)[1].message, "GPU perdida");
  assert.deepEqual(s.drawn, []);
  assert.equal(s.rafs.pending.size, 1, "sigue programado");
});

test("bucle: sin persona → 'No te veo'; con landmarks poco visibles también", async () => {
  let landmarks = null;
  const vision = fakeVision({ frames: () => landmarks });
  const s = await readySetup({ vision });
  s.monitor.state.baseline = { ...BASE };
  s.monitor.start();

  s.frame();
  assert.deepEqual(s.lastOf("badge"), ["badge", "idle", "No te veo"]);
  assert.equal(s.drawn.at(-1).landmarks, null);

  landmarks = makeLandmarks({ visibility: 0.1 });
  s.frame();
  assert.deepEqual(s.lastOf("badge"), ["badge", "idle", "No te veo"]);
  assert.equal(s.drawn.at(-1).landmarks, null, "no se dibujan landmarks no fiables");
  assert.equal(s.monitor.state.smoothed, null);
});

test("bucle: durante la calibración los fotogramas van a handleCalibration, no a evaluate", async () => {
  const vision = fakeVision({ frames: () => GOOD_LANDMARKS });
  const s = await readySetup({ vision });
  s.monitor.startCalibration();
  s.monitor.start();
  s.events.length = 0;
  s.frame();

  assert.equal(s.of("calibProgress").length, 1);
  assert.equal(s.of("hold").length, 0);
  assert.equal(s.monitor.state.smoothed, null);
  assert.equal(s.drawn.at(-1).snapshot.calibrating, true);
});

test("bucle completo: buena postura → mala con aviso tras el retardo → recuperación", async () => {
  let landmarks = GOOD_LANDMARKS;
  const vision = fakeVision({ frames: () => landmarks });
  const s = await readySetup({ vision, settings: { delaySeconds: 2 } });
  s.monitor.state.baseline = computeMetrics(GOOD_LANDMARKS, ASPECT);
  s.monitor.start();

  for (let i = 0; i < 10; i++) s.frame();
  assert.equal(s.monitor.state.alerts, 0);
  assert.deepEqual(s.lastOf("badge"), ["badge", "good", "Postura correcta"]);
  assert.ok(s.monitor.state.goodMs > 0);

  landmarks = BAD_LANDMARKS;
  for (let i = 0; i < 40; i++) s.frame();
  assert.equal(s.monitor.state.alerts, 1);
  assert.equal(s.of("alert").length, 1);
  assert.equal(s.of("sound").length, 1);
  assert.equal(s.of("notify").length, 1);
  assert.equal(s.monitor.state.alerting, true);
  assert.deepEqual(s.lastOf("badge"), ["badge", "bad", "Corrige la postura"]);

  landmarks = GOOD_LANDMARKS;
  for (let i = 0; i < 40; i++) s.frame();
  assert.equal(s.monitor.state.alerting, false);
  assert.equal(s.of("clear").length, 1);
  assert.deepEqual(s.of("message").at(-1), ["message", "Bien, postura recuperada."]);
  assert.deepEqual(s.lastOf("badge"), ["badge", "good", "Postura correcta"]);
  assert.equal(s.monitor.state.alerts, 1);
});

test("bucle: tras un aviso, 3 s sin detectar limpian el aviso, cortan el tramo malo y piden colocarse", async () => {
  let landmarks = BAD_LANDMARKS;
  const vision = fakeVision({ frames: () => landmarks });
  const s = await readySetup({ vision, settings: { delaySeconds: 1 } });
  s.monitor.state.baseline = computeMetrics(GOOD_LANDMARKS, ASPECT);
  s.monitor.start();
  for (let i = 0; i < 30; i++) s.frame();
  assert.equal(s.monitor.state.alerting, true);
  assert.notEqual(s.monitor.state.badSince, null);

  landmarks = null;
  const before = s.mark();
  for (let i = 0; i < 25; i++) s.frame(); // 2,5 s desde la última vez que se te vio
  assert.equal(s.monitor.state.alerting, true, "aún dentro de los 3 s de gracia");
  assert.notEqual(s.monitor.state.badSince, null);
  assert.equal(s.since(before).filter((e) => e[0] === "clear" || e[0] === "message").length, 0);
  assert.deepEqual(s.lastOf("badge"), ["badge", "idle", "No te veo"]);

  for (let i = 0; i < 6; i++) s.frame(); // > 3 s
  assert.equal(s.monitor.state.alerting, false);
  assert.equal(s.monitor.state.badSince, null);
  assert.ok(s.since(before).some((e) => e[0] === "clear"));
  assert.deepEqual(s.of("message").at(-1), [
    "message",
    "No detecto tu cabeza y hombros. Colócate frente a la cámara.",
  ]);
  assert.equal(s.monitor.state.alerts, 1, "no detectar no cuenta como aviso nuevo");
});

test("bucle: suaviza con el dt real desde el último fotograma evaluado, acotado a 500 ms", async () => {
  const vision = fakeVision({ frames: () => BAD_LANDMARKS });
  const s = await readySetup({ vision, timer: { running: false } });
  s.monitor.state.baseline = { ...BASE };
  s.monitor.state.smoothed = { ...BASE };
  s.monitor.start(); // procesa un primer fotograma con dt = 0
  const metrics = computeMetrics(BAD_LANDMARKS, ASPECT);

  const first = { ...s.monitor.state.smoothed };
  s.frame(2_000); // pausa larga: dt se acota a 500 ms
  assert.deepEqual(s.monitor.state.smoothed, smooth(first, metrics, 500));

  const second = { ...s.monitor.state.smoothed };
  s.frame(100);
  assert.deepEqual(s.monitor.state.smoothed, smooth(second, metrics, 100));
});

/* ── Camino caliente sin asignaciones: reutilización de objetos entre fotogramas ── */

test("getSettings se lee UNA vez por fotograma inferido y se comparte entre draw y evaluate", async () => {
  let reads = 0;
  const cfg = { tolerance: 1, delaySeconds: 5, showSkeleton: true, showHud: true, hideVideo: false };
  const vision = fakeVision({ frames: () => GOOD_LANDMARKS });
  const s = await readySetup({ vision, getSettings: () => (reads++, cfg) });
  s.monitor.state.baseline = computeMetrics(GOOD_LANDMARKS, ASPECT);

  s.monitor.start();
  for (let i = 0; i < 10; i++) s.frame();
  assert.equal(vision.calls.detect.length, 11);
  assert.equal(reads, vision.calls.detect.length, "una lectura por inferencia (antes eran dos: draw y evaluate)");
  assert.ok(s.drawn.length >= 11 && s.drawn.every((d) => d.state.tolerance === 1));
});

test("evaluate y draw usan los ajustes que reciben y solo leen getSettings cuando se llama sin ellos", () => {
  let reads = 0;
  const cfg = { tolerance: 1, delaySeconds: 5, showSkeleton: true, showHud: true, hideVideo: false };
  const s = setup({ getSettings: () => (reads++, cfg), timer: { running: false } });
  s.monitor.state.baseline = { ...BASE };

  s.step(BAD_NECK); // sin ajustes explícitos: lee getSettings
  assert.equal(reads, 1);
  assert.deepEqual(s.lastOf("badge"), ["badge", "warn", "Postura mejorable"]);

  s.clock.t += 100;
  s.monitor.evaluate(BAD_NECK, s.clock.t, { tolerance: 100, delaySeconds: 5 }); // con ajustes: no lee
  assert.equal(reads, 1);
  assert.deepEqual(s.lastOf("badge"), ["badge", "good", "Postura correcta"], "usa la tolerancia recibida");

  s.monitor.draw(GOOD_LANDMARKS, { tolerance: 7, showSkeleton: false, showHud: true, hideVideo: true });
  assert.equal(reads, 1);
  assert.equal(s.drawn.at(-1).snapshot.tolerance, 7);
  s.monitor.draw(GOOD_LANDMARKS);
  assert.equal(reads, 2);
});

test("bucle: smoothed se actualiza en sitio (mismo objeto), sin tocar baseline ni las métricas crudas", async () => {
  const vision = fakeVision({ frames: () => BAD_LANDMARKS });
  const s = await readySetup({ vision, timer: { running: false } });
  const baseline = { ...BASE };
  s.monitor.state.baseline = baseline;
  s.monitor.state.smoothed = { ...BASE };
  const smoothedRef = s.monitor.state.smoothed;

  s.monitor.start();
  for (let i = 0; i < 20; i++) s.frame();

  assert.equal(s.monitor.state.smoothed, smoothedRef, "el mismo objeto de estado en todos los fotogramas");
  assert.deepEqual(baseline, BASE, "baseline no se muta");
  assert.equal(s.monitor.state.baseline, baseline);
  // Y avanza hacia las métricas del fotograma actual (no queda congelado en el valor inicial)
  const target = computeMetrics(BAD_LANDMARKS, ASPECT);
  assert.ok(Math.abs(smoothedRef.neck - target.neck) < Math.abs(BASE.neck - target.neck));
  assert.ok(Math.abs(smoothedRef.neck - target.neck) < 0.02, "tras 20 fotogramas ya casi ha convergido");
  assert.deepEqual(Object.keys(smoothedRef), Object.keys(BASE));
});

test("bucle: si smoothed fuera el MISMO objeto que baseline se separa en vez de mutarlo", async () => {
  const vision = fakeVision({ frames: () => BAD_LANDMARKS });
  const s = await readySetup({ vision, timer: { running: false } });
  const shared = { ...BASE };
  s.monitor.state.baseline = shared;
  s.monitor.state.smoothed = shared; // alias (p. ej. asignado desde la consola de depuración)

  s.monitor.start();
  for (let i = 0; i < 5; i++) s.frame();

  assert.deepEqual(s.monitor.state.baseline, BASE, "la calibración de referencia queda intacta");
  assert.notEqual(s.monitor.state.smoothed, s.monitor.state.baseline);
  assert.notDeepEqual(s.monitor.state.smoothed, BASE, "smoothed sí avanza");
});

test("bucle: la primera vez smoothed se crea como copia de las métricas y no comparte objeto con ningún buffer", async () => {
  const vision = fakeVision({ frames: () => GOOD_LANDMARKS });
  const s = await readySetup({ vision });
  assert.equal(s.monitor.state.smoothed, null);
  s.monitor.start();
  const first = s.monitor.state.smoothed;
  assert.deepEqual(first, computeMetrics(GOOD_LANDMARKS, ASPECT));
  s.frame();
  assert.equal(s.monitor.state.smoothed, first, "a partir de ahí se reutiliza");
});

test("las muestras de calibración son objetos independientes (no un buffer compartido)", async () => {
  const vision = fakeVision({ frames: () => GOOD_LANDMARKS });
  const s = await readySetup({ vision });
  s.monitor.startCalibration();
  s.monitor.start();
  for (let i = 0; i < 38; i++) s.frame(); // hasta pasar el margen de 1 s y muestrear
  const samples = s.monitor.state.calibSamples;
  assert.ok(samples.length >= 3, `hay muestras (${samples.length})`);
  assert.equal(new Set(samples).size, samples.length, "cada muestra es su propio objeto");
});

test("la barra de espera a cero es un objeto compartido e inmutable; las demás cargas son objetos nuevos", async () => {
  const s = setup();
  s.monitor.state.baseline = { ...BASE };
  s.monitor.state.lastFrameAt = s.clock.t;
  s.timer.running = false;
  s.step(BASE);
  s.step(BASE);
  const zeros = s.of("hold").map((e) => e[1]);
  assert.equal(zeros.length, 2);
  assert.deepEqual(zeros, [{ fraction: 0 }, { fraction: 0 }]);
  assert.equal(zeros[0], zeros[1], "misma constante");
  assert.ok(Object.isFrozen(zeros[0]), "inmutable: ningún consumidor puede corromperla");

  const bad = setup({ settings: { delaySeconds: 5 } });
  bad.monitor.state.baseline = { ...BASE };
  bad.monitor.state.lastFrameAt = bad.clock.t;
  bad.step(BAD_NECK);
  bad.step(BAD_NECK);
  const [h1, h2] = bad.of("hold").map((e) => e[1]);
  assert.notEqual(h1, h2, "con progreso real cada aviso lleva su propio valor");
  assert.ok(h2.fraction > h1.fraction);
});

/* ── Dibujo ────────────────────────────────────────────────────────────── */

test("draw pasa a drawOverlay el ctx, el tamaño del canvas y el estado reutilizado", () => {
  const s = setup({ settings: { tolerance: NaN, showSkeleton: false, showHud: true, hideVideo: true } });
  s.badge.state = "warn";
  s.monitor.state.baseline = { ...BASE };
  s.monitor.state.smoothed = { ...BAD_NECK };
  s.canvas.width = 800;
  s.canvas.height = 600;

  s.monitor.draw(GOOD_LANDMARKS);
  s.monitor.draw(null);

  assert.equal(s.drawn.length, 2);
  const [first, second] = s.drawn;
  assert.equal(first.ctx, s.ctx);
  assert.equal(first.w, 800);
  assert.equal(first.h, 600);
  assert.equal(first.landmarks, GOOD_LANDMARKS);
  assert.equal(second.landmarks, null);
  assert.equal(first.state, second.state, "un único objeto de estado reutilizado");
  assert.deepEqual(first.snapshot, {
    badgeState: "warn",
    showSkeleton: false,
    showHud: true,
    hideVideo: true,
    calibrating: false,
    baseline: s.monitor.state.baseline,
    smoothed: s.monitor.state.smoothed,
    tolerance: 1,
  });
});

test("draw con el overlay real acepta el estado sin lanzar", () => {
  const target = { measureText: (t) => ({ width: t.length * 6 }) };
  const ctx = new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop] : () => {}),
    set: (t, prop, value) => ((t[prop] = value), true),
  });
  const s = setup();
  const real = createPostureMonitor({
    video: s.video,
    canvas: s.canvas,
    ctx,
    timer: s.timer,
    focusStats: s.focusStats,
    isCameraOn: () => true,
    getSettings: () => ({ tolerance: 1, showSkeleton: true, showHud: true, hideVideo: false }),
    getBadgeState: () => "good",
  });
  real.state.baseline = { ...BASE };
  real.state.smoothed = { ...BASE };
  assert.doesNotThrow(() => real.draw(GOOD_LANDMARKS));
  assert.doesNotThrow(() => real.draw(null));
});

/* ── Estado compartido ─────────────────────────────────────────────────── */

test("monitor.state es un único objeto escribible con los campos originales", () => {
  const s = setup();
  assert.equal(s.monitor.state, s.monitor.state);
  assert.deepEqual(Object.keys(s.monitor.state), [
    "baseline", "smoothed", "badSince", "goodStreak", "lastAlertAt", "alerting", "showingIssue",
    "alerts", "goodMs", "badMs", "lastFrameAt", "lastSeenAt", "calibrating", "calibSamples", "calibEndsAt",
  ]);
  // Escritura directa (como hace window.postavaDebug.setBaseline y saveSettings/loadSettings)
  s.monitor.state.baseline = { ...BASE };
  s.monitor.state.smoothed = { ...BASE };
  s.monitor.state.lastFrameAt = s.clock.t;
  assert.equal(s.monitor.monitoringActive(), true);
  s.monitor.evaluate(BASE, s.clock.t + 100);
  assert.equal(s.monitor.state.goodMs, 100);
});

test("todos los callbacks son opcionales: un flujo completo sin ninguno no lanza", async () => {
  const s = setup();
  const quiet = createPostureMonitor({
    video: s.video,
    canvas: s.canvas,
    ctx: s.ctx,
    timer: s.timer,
    focusStats: s.focusStats,
    isCameraOn: () => true,
    mediapipe: fakeVision({ frames: () => BAD_LANDMARKS }).mediapipe,
    clock: () => s.clock.t,
    requestFrame: () => 1,
    cancelFrame: () => {},
    drawOverlay: () => {},
    logger: { info: () => {}, error: () => {} },
  });
  await quiet.initEngine();
  quiet.startCalibration();
  quiet.cancelCalibration();
  quiet.state.baseline = { ...BASE };
  quiet.state.lastFrameAt = s.clock.t;
  for (let i = 1; i <= 60; i++) quiet.evaluate(BAD_NECK, s.clock.t + i * 100);
  assert.equal(quiet.state.alerts, 1);
  quiet.handleNotDetected(s.clock.t + 10_000);
  quiet.raiseAlert("slump");
  quiet.clearAlert();
  quiet.draw(null);
  quiet.start();
  quiet.stop();
  assert.equal(quiet.state.alerting, false);
});

/* ── Privacidad y aislamiento ──────────────────────────────────────────── */

test("el módulo no toca la red: ni con un fetch global falso durante un flujo completo", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error("el monitor de postura no debe usar la red");
  };
  try {
    let landmarks = GOOD_LANDMARKS;
    const vision = fakeVision({ frames: () => landmarks });
    const s = await readySetup({ vision, settings: { delaySeconds: 1 } });
    s.monitor.start();
    s.monitor.startCalibration();
    for (let i = 0; i < 45; i++) s.frame(); // calibra
    assert.ok(s.monitor.state.baseline, "calibró");
    landmarks = BAD_LANDMARKS;
    for (let i = 0; i < 30; i++) s.frame();
    landmarks = null;
    for (let i = 0; i < 40; i++) s.frame();
    s.monitor.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
});

test("los landmarks no llegan a ningún callback ni al log: solo a drawOverlay", async () => {
  let landmarks = GOOD_LANDMARKS;
  const vision = fakeVision({ frames: () => landmarks });
  const s = await readySetup({ vision, settings: { delaySeconds: 1 } });
  s.monitor.start();
  s.monitor.startCalibration();
  for (let i = 0; i < 45; i++) s.frame();
  landmarks = BAD_LANDMARKS;
  for (let i = 0; i < 30; i++) s.frame();

  const serialized = JSON.stringify([s.events, s.logs]);
  for (const sentinel of ["0.50123456", "0.83217", "visibility", "landmarks", '"x"']) {
    assert.ok(!serialized.includes(sentinel), `filtrado en callbacks: ${sentinel}`);
  }
  const seen = new Set();
  const containsLandmarks = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (value === GOOD_LANDMARKS || value === BAD_LANDMARKS) return true;
    return Object.values(value).some(containsLandmarks);
  };
  assert.equal(containsLandmarks(s.events), false);
  assert.ok(s.drawn.some((d) => d.landmarks === GOOD_LANDMARKS || d.landmarks === BAD_LANDMARKS));
});

test("el código fuente no usa DOM, window, fetch ni otras vías de red y solo importa posture.js y overlay.js", () => {
  const raw = readFileSync(new URL("../posture-monitor.js", import.meta.url), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  for (const forbidden of [
    /\bdocument\b/, /\bwindow\b/, /\bfetch\b/, /\bXMLHttpRequest\b/, /\bWebSocket\b/,
    /\bsendBeacon\b/, /\bEventSource\b/, /\blocalStorage\b/, /\bsessionStorage\b/,
    /\bel\.[a-zA-Z]/, /\bquerySelector/, /\bgetElementById\b/, /\bnavigator\b/,
  ]) {
    assert.doesNotMatch(code, forbidden);
  }
  const imports = [...raw.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["./overlay.js", "./posture.js"]);
});
