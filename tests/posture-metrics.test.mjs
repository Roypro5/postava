import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeMetrics, metricReport, findIssues, keyPointsVisible, smooth,
  averageMetrics, normalizeLineAngle, lineAngleDifference, LM, TH,
} from "../posture.js";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

function lms(over = {}) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
  lm[LM.NOSE] = { x: 0.5, y: 0.3, visibility: 1 };
  lm[LM.L_EAR] = { x: 0.42, y: 0.32, visibility: 1 };
  lm[LM.R_EAR] = { x: 0.58, y: 0.32, visibility: 1 };
  lm[LM.L_SHOULDER] = { x: 0.4, y: 0.5, visibility: 1 };
  lm[LM.R_SHOULDER] = { x: 0.6, y: 0.5, visibility: 1 };
  for (const [i, p] of Object.entries(over)) lm[i] = { ...lm[i], ...p };
  return lm;
}

test("computeMetrics: postura neutra simétrica da valores esperados", () => {
  const m = computeMetrics(lms(), 1);
  close(m.width, 0.2);
  close(m.neck, (0.5 - 0.32) / 0.2);
  close(m.chin, (0.3 - 0.32) / 0.2);
  close(m.tilt, 0);
  close(m.side, 0);
  close(m.shoulderY, 0.5);
});

test("computeMetrics: width usa la relación de aspecto", () => {
  const a = computeMetrics(lms(), 1);
  const b = computeMetrics(lms(), 2);
  close(b.width, a.width * 2);
  close(b.neck, (0.5 - 0.32) / 0.4);
  close(b.side, 0);
});

test("computeMetrics: normalización por ancho de hombros (acercarse escala todo por igual)", () => {
  const scale = (p) => ({ ...p, x: 0.5 + (p.x - 0.5) * 2, y: 0.5 + (p.y - 0.5) * 2 });
  const base = lms();
  const a = computeMetrics(base, 1);
  const b = computeMetrics(base.map(scale), 1);
  close(b.width, a.width * 2);
  close(b.neck, a.neck);
  close(b.chin, a.chin);
  close(b.side, a.side);
});

test("computeMetrics: encorvarse baja neck; barbilla abajo sube chin", () => {
  const neutral = computeMetrics(lms());
  const slouch = computeMetrics(lms({ [LM.L_EAR]: { y: 0.44 }, [LM.R_EAR]: { y: 0.44 } }));
  assert.ok(slouch.neck < neutral.neck);
  const chin = computeMetrics(lms({ [LM.NOSE]: { y: 0.42 } }));
  assert.ok(chin.chin > neutral.chin);
});

test("computeMetrics: desplazamiento lateral de cabeza da side con signo", () => {
  const right = computeMetrics(lms({ [LM.L_EAR]: { x: 0.52 }, [LM.R_EAR]: { x: 0.68 } }), 1);
  close(right.side, 0.1 / 0.2);
  const left = computeMetrics(lms({ [LM.L_EAR]: { x: 0.32 }, [LM.R_EAR]: { x: 0.48 } }), 1);
  close(left.side, -0.1 / 0.2);
});

test("computeMetrics: tilt de 45 grados y ángulos extremos quedan en [-90, 90)", () => {
  const m = computeMetrics(lms({ [LM.R_SHOULDER]: { x: 0.6, y: 0.6 }, [LM.L_SHOULDER]: { x: 0.5, y: 0.5 } }), 1);
  close(m.tilt, 45, 1e-6);
  const swapped = computeMetrics(lms({ [LM.L_SHOULDER]: { x: 0.6, y: 0.5 }, [LM.R_SHOULDER]: { x: 0.4, y: 0.5 } }), 1);
  close(swapped.tilt, 0, 1e-6);
  const vertical = computeMetrics(lms({ [LM.L_SHOULDER]: { x: 0.5, y: 0.4 }, [LM.R_SHOULDER]: { x: 0.5, y: 0.6 } }), 1);
  assert.ok(vertical.tilt >= -90 && vertical.tilt < 90);
  close(Math.abs(vertical.tilt), 90, 1e-6);
});

test("computeMetrics: hombros coincidentes (distancia 0) no producen NaN ni Infinity", () => {
  const m = computeMetrics(lms({ [LM.L_SHOULDER]: { x: 0.5, y: 0.5 }, [LM.R_SHOULDER]: { x: 0.5, y: 0.5 } }));
  for (const [k, v] of Object.entries(m)) assert.ok(Number.isFinite(v), `${k} no finito: ${v}`);
  close(m.width, 1e-4);
});

test("computeMetrics: null ante landmarks ausentes, punto clave faltante o NaN/Infinity", () => {
  assert.equal(computeMetrics(undefined), null);
  assert.equal(computeMetrics(null), null);
  assert.equal(computeMetrics([]), null);
  for (const idx of [LM.NOSE, LM.L_EAR, LM.R_EAR, LM.L_SHOULDER, LM.R_SHOULDER]) {
    const gone = lms();
    gone[idx] = undefined;
    assert.equal(computeMetrics(gone), null);
    assert.equal(computeMetrics(lms({ [idx]: { x: NaN } })), null);
    assert.equal(computeMetrics(lms({ [idx]: { y: Infinity } })), null);
  }
});

test("keyPointsVisible: frontera de visibility (estricto > 0.4) y margen de encuadre", () => {
  assert.equal(keyPointsVisible(lms({ [LM.NOSE]: { visibility: 0.4 } })), false);
  assert.equal(keyPointsVisible(lms({ [LM.NOSE]: { visibility: 0.41 } })), true);
  assert.equal(keyPointsVisible(lms({ [LM.NOSE]: { x: -0.15 } })), true);
  assert.equal(keyPointsVisible(lms({ [LM.NOSE]: { x: -0.16 } })), false);
  assert.equal(keyPointsVisible(lms({ [LM.NOSE]: { y: 1.16 } })), false);
  const lost = lms();
  lost[LM.R_SHOULDER] = undefined;
  assert.equal(keyPointsVisible(lost), false);
  const noVis = lms();
  for (const p of noVis) delete p.visibility;
  assert.equal(keyPointsVisible(noVis), true);
});

test("normalizeLineAngle / lineAngleDifference: periodo de 180 grados", () => {
  assert.equal(normalizeLineAngle(0), 0);
  assert.equal(normalizeLineAngle(90), -90);
  assert.equal(normalizeLineAngle(-90), -90);
  assert.equal(normalizeLineAngle(180), 0);
  assert.equal(normalizeLineAngle(270), -90);
  assert.equal(normalizeLineAngle(-181), -1);
  close(lineAngleDifference(89, -89), 2);
  close(lineAngleDifference(0, 180), 0);
});

test("metricReport: cada metrica se dispara por encima de su umbral y no por debajo", () => {
  const base = { neck: 1, width: 0.2, tilt: 0, side: 0, chin: 0, shoulderY: 0.5 };
  assert.equal(findIssues(base, base).length, 0);
  const cases = {
    neckDrop: { neck: 1 - TH.neckDrop * 1.1 },
    proximity: { width: 0.2 * (1 + TH.proximity * 1.1) },
    shoulderTilt: { tilt: TH.shoulderTilt * 1.1 },
    sideLean: { side: TH.sideLean * 1.1 },
    chinDown: { chin: TH.chinDown * 1.1 },
    slump: { shoulderY: 0.5 + 0.2 * TH.slump * 1.1 },
  };
  for (const [key, patch] of Object.entries(cases)) {
    const issues = findIssues({ ...base, ...patch }, base);
    assert.deepEqual(issues.map((i) => i.key), [key]);
    const half = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, base[k] + (v - base[k]) * 0.5]));
    assert.equal(findIssues({ ...base, ...half }, base).length, 0, `${key} bajo umbral`);
  }
});

test("metricReport: tolerancia escala el limite y findIssues ordena por gravedad", () => {
  const base = { neck: 1, width: 0.2, tilt: 0, side: 0, chin: 0, shoulderY: 0.5 };
  const m = { ...base, tilt: 10, side: 0.5 };
  assert.deepEqual(findIssues(m, base).map((i) => i.key), ["sideLean", "shoulderTilt"]);
  assert.deepEqual(findIssues(m, base, 2).map((i) => i.key), ["sideLean"]);
  assert.equal(findIssues(m, base, 100).length, 0);
});

test("metricReport: tilt cruzando +-90 no genera falsos avisos; baseline.neck 0 no rompe", () => {
  const base = { neck: 0, width: 0.2, tilt: 89, side: 0, chin: 0, shoulderY: 0.5 };
  const r = metricReport({ ...base, tilt: -89 }, base).find((x) => x.key === "shoulderTilt");
  close(r.value, 2);
  for (const x of metricReport(base, base)) assert.ok(Number.isFinite(x.ratio));
});

test("metricReport: metricas NaN nunca marcan exceeded", () => {
  const base = { neck: 1, width: 0.2, tilt: 0, side: 0, chin: 0, shoulderY: 0.5 };
  const m = { neck: NaN, width: NaN, tilt: NaN, side: NaN, chin: NaN, shoulderY: NaN };
  assert.equal(findIssues(m, base).length, 0);
});

test("smooth: tilt interpola por el camino corto y dt negativo no mueve el valor", () => {
  const out = smooth({ tilt: 89, a: 0 }, { tilt: -89, a: 10 }, 66);
  assert.ok(out.tilt > 89 || out.tilt < -85, `salto largo: ${out.tilt}`);
  const still = smooth({ tilt: 5, a: 1 }, { tilt: 50, a: 9 }, -10);
  close(still.tilt, 5);
  close(still.a, 1);
});

test("averageMetrics: vacio da null; promedio circular de tilt cerca de +-90", () => {
  assert.equal(averageMetrics([]), null);
  const avg = averageMetrics([{ tilt: 89, neck: 1 }, { tilt: -89, neck: 3 }]);
  close(avg.neck, 2);
  assert.ok(Math.abs(Math.abs(avg.tilt) - 90) < 1e-6);
});
