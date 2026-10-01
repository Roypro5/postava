import { test } from "node:test";
import assert from "node:assert/strict";
import {
  keyPointsVisible,
  computeMetrics,
  metricReport,
  findIssues,
  KEY_POINTS,
  smooth,
  SMOOTH_TAU_MS,
  calibrationSpread,
  validateCalibrationSamples,
} from "../posture.js";

/* Construye un array de 33 landmarks con los puntos clave en una postura
   "neutra" razonable, para poder testear visibilidad y métricas sin cámara. */
function makeLandmarks(overrides = {}) {
  const lm = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.5, visibility: 1 }));
  lm[0] = { x: 0.5, y: 0.3, visibility: 1 };   // NOSE
  lm[7] = { x: 0.42, y: 0.32, visibility: 1 }; // L_EAR
  lm[8] = { x: 0.58, y: 0.32, visibility: 1 }; // R_EAR
  lm[11] = { x: 0.4, y: 0.5, visibility: 1 };  // L_SHOULDER
  lm[12] = { x: 0.6, y: 0.5, visibility: 1 };  // R_SHOULDER
  for (const [i, patch] of Object.entries(overrides)) {
    lm[i] = { ...lm[i], ...patch };
  }
  return lm;
}

test("keyPointsVisible: landmarks con NaN no se consideran visibles", () => {
  const lm = makeLandmarks({ 0: { x: NaN, y: 0.3, visibility: 1 } });
  assert.equal(keyPointsVisible(lm), false);

  const lmY = makeLandmarks({ 11: { x: 0.4, y: NaN, visibility: 1 } });
  assert.equal(keyPointsVisible(lmY), false);
});

test("keyPointsVisible: visibility no finita se trata como dato ausente, no como número", () => {
  // Si visibility=NaN contara como número, Math.min lo propagaría y min>umbral sería false;
  // en cambio, se debe ignorar y evaluar según el resto de puntos (que sí tienen visibility).
  const lm = makeLandmarks({ 7: { x: 0.42, y: 0.32, visibility: NaN } });
  assert.equal(keyPointsVisible(lm), true);
});

test("keyPointsVisible: landmarks válidos dentro del encuadre son visibles", () => {
  const lm = makeLandmarks();
  assert.equal(keyPointsVisible(lm), true);
});

test("keyPointsVisible: puntos fuera del encuadre no son visibles", () => {
  const lm = makeLandmarks({ 12: { x: 1.5, y: 0.5, visibility: 1 } });
  assert.equal(keyPointsVisible(lm), false);
});

test("keyPointsVisible: falta un punto clave o landmarks ausentes", () => {
  assert.equal(keyPointsVisible(null), false);
  const lm = makeLandmarks();
  lm[KEY_POINTS[0]] = null;
  assert.equal(keyPointsVisible(lm), false);
});

test("metricReport/findIssues: detecta cuello hundido respecto a la calibración", () => {
  const baseline = computeMetrics(makeLandmarks());
  // Encorvado: la cabeza se acerca a la línea de hombros (menor separación oreja-hombro).
  const slouched = computeMetrics(
    makeLandmarks({
      0: { x: 0.5, y: 0.44, visibility: 1 },
      7: { x: 0.42, y: 0.46, visibility: 1 },
      8: { x: 0.58, y: 0.46, visibility: 1 },
    })
  );

  const report = metricReport(slouched, baseline);
  const neckDrop = report.find((r) => r.key === "neckDrop");
  assert.ok(neckDrop);
  assert.equal(neckDrop.exceeded, true);

  const issues = findIssues(slouched, baseline);
  assert.ok(issues.some((i) => i.key === "neckDrop"));
});

test("computeMetrics: devuelve null si faltan landmarks o si no son finitos", () => {
  assert.equal(computeMetrics(null), null);

  const lmMissing = makeLandmarks();
  lmMissing[KEY_POINTS[0]] = null;
  assert.equal(computeMetrics(lmMissing), null);

  const lmNaN = makeLandmarks({ 11: { x: NaN, y: 0.5, visibility: 1 } });
  assert.equal(computeMetrics(lmNaN), null);
});

test("metricReport: sin baseline o sin métricas devuelve lista vacía", () => {
  assert.deepEqual(metricReport(null, null), []);
  const m = computeMetrics(makeLandmarks());
  assert.deepEqual(metricReport(m, null), []);
});

test("smooth: sin `prev` devuelve `next` tal cual", () => {
  const next = { neck: 1, width: 2, tilt: 3, side: 4, chin: 5, shoulderY: 6 };
  assert.deepEqual(smooth(null, next, 66), next);
});

test("smooth: a dt nominal (INFER_INTERVAL) reproduce el alpha fijo 0.3 de antes", () => {
  const prev = { neck: 0, width: 0, tilt: 0, side: 0, chin: 0, shoulderY: 0 };
  const next = { neck: 1, width: 1, tilt: 0, side: 1, chin: 1, shoulderY: 1 };
  const out = smooth(prev, next, 66);
  assert.ok(Math.abs(out.neck - 0.3) < 1e-6, `esperaba ~0.3, salió ${out.neck}`);
});

test("smooth: con dt más pequeño suaviza más que a dt nominal", () => {
  const prev = { neck: 0, width: 0, tilt: 0, side: 0, chin: 0, shoulderY: 0 };
  const next = { neck: 1, width: 1, tilt: 0, side: 1, chin: 1, shoulderY: 1 };
  const outNominal = smooth(prev, next, 66);
  const outSmallDt = smooth(prev, next, 10);
  assert.ok(
    outSmallDt.neck < outNominal.neck,
    `con dt pequeño debería acercarse menos a next: ${outSmallDt.neck} vs ${outNominal.neck}`
  );
});

test("smooth: con dt más grande se acerca más a next (tras una pausa larga)", () => {
  const prev = { neck: 0, width: 0, tilt: 0, side: 0, chin: 0, shoulderY: 0 };
  const next = { neck: 1, width: 1, tilt: 0, side: 1, chin: 1, shoulderY: 1 };
  const outNominal = smooth(prev, next, 66);
  const outLongDt = smooth(prev, next, 1000);
  assert.ok(outLongDt.neck > outNominal.neck);
  assert.ok(outLongDt.neck <= 1);
});

test("SMOOTH_TAU_MS: es un número positivo derivado del alpha legado", () => {
  assert.ok(Number.isFinite(SMOOTH_TAU_MS));
  assert.ok(SMOOTH_TAU_MS > 0);
});

/* Genera muestras de calibración a partir de una postura base, con un
   desplazamiento opcional en cada punto para simular movimiento. */
function makeCalibSamples(count, jitter = 0) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    // Alterna el signo para que el jitter no sea un sesgo constante, sino
    // dispersión real alrededor de la media.
    const sign = i % 2 === 0 ? 1 : -1;
    const lm = makeLandmarks({
      0: { x: 0.5, y: 0.3 + sign * jitter, visibility: 1 },
      7: { x: 0.42 + sign * jitter, y: 0.32 + sign * jitter, visibility: 1 },
      8: { x: 0.58 - sign * jitter, y: 0.32 + sign * jitter, visibility: 1 },
      11: { x: 0.4 - sign * jitter, y: 0.5 + sign * jitter, visibility: 1 },
      12: { x: 0.6 + sign * jitter, y: 0.5 + sign * jitter, visibility: 1 },
    });
    samples.push(computeMetrics(lm));
  }
  return samples;
}

test("validateCalibrationSamples: pocas muestras falla por insuficiencia", () => {
  const samples = makeCalibSamples(3, 0);
  const result = validateCalibrationSamples(samples);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "insufficient");
});

test("validateCalibrationSamples: muestras estables (quieto) pasan", () => {
  const samples = makeCalibSamples(20, 0);
  const result = validateCalibrationSamples(samples);
  assert.deepEqual(result, { ok: true });
});

test("validateCalibrationSamples: muestras con movimiento fallan", () => {
  const samples = makeCalibSamples(20, 0.05);
  const result = validateCalibrationSamples(samples);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "movement");
});

test("calibrationSpread: nula con menos de 2 muestras, cero cuando no hay dispersión", () => {
  assert.equal(calibrationSpread([]), null);
  assert.equal(calibrationSpread(makeCalibSamples(1, 0)), null);

  const spread = calibrationSpread(makeCalibSamples(10, 0));
  assert.ok(Math.abs(spread.neck) < 1e-9);
  assert.ok(Math.abs(spread.width) < 1e-9);
  assert.ok(Math.abs(spread.tilt) < 1e-9);
  assert.ok(Math.abs(spread.shoulderY) < 1e-9);
});
