import { test } from "node:test";
import assert from "node:assert/strict";
import { keyPointsVisible, computeMetrics, metricReport, findIssues, KEY_POINTS } from "../posture.js";

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
