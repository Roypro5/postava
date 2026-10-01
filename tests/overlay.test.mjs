import test from "node:test";
import assert from "node:assert/strict";
import { drawOverlay } from "../overlay.js";
import { LM, metricReport } from "../posture.js";

/* ctx falso: registra las llamadas a métodos y acepta cualquier asignación de propiedades */
function fakeCtx() {
  const calls = [];
  const target = { measureText: (t) => ({ width: t.length * 6 }) };
  const ctx = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      return (...args) => void calls.push([prop, ...args]);
    },
    set(t, prop, value) {
      t[prop] = value;
      return true;
    },
  });
  return { ctx, calls };
}

function state(overrides = {}) {
  return {
    badgeState: "good",
    showSkeleton: true,
    showHud: true,
    hideVideo: false,
    calibrating: false,
    baseline: null,
    smoothed: null,
    tolerance: 1,
    ...overrides,
  };
}

const baseline = { neck: 0.3, width: 1, tilt: 0, side: 0, chin: 0.2, shoulderY: 0.7 };

function landmarks() {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }));
  lm[LM.L_SHOULDER] = { x: 0.6, y: 0.7, visibility: 0.9 };
  lm[LM.R_SHOULDER] = { x: 0.4, y: 0.7, visibility: 0.9 };
  lm[LM.L_EAR] = { x: 0.55, y: 0.4, visibility: 0.9 };
  lm[LM.R_EAR] = { x: 0.45, y: 0.4, visibility: 0.9 };
  return lm;
}

const names = (calls) => calls.map((c) => c[0]);

test("landmarks nulos y sin HUD: solo limpia el lienzo", () => {
  const { ctx, calls } = fakeCtx();
  drawOverlay(ctx, 640, 480, null, state({ showHud: false }));
  assert.deepEqual(calls, [["clearRect", 0, 0, 640, 480]]);
});

test("landmarks vacíos y nulos no lanzan (calibrating true/false)", () => {
  for (const calibrating of [true, false]) {
    for (const lms of [null, undefined, []]) {
      const { ctx } = fakeCtx();
      assert.doesNotThrow(() =>
        drawOverlay(ctx, 640, 480, lms, state({ calibrating, baseline })),
      );
    }
  }
});

test("modo mapa dibuja fondo salvo durante la calibración", () => {
  const off = fakeCtx();
  drawOverlay(off.ctx, 640, 480, null, state({ hideVideo: true, showHud: false }));
  assert.ok(names(off.calls).includes("fillRect"));
  const on = fakeCtx();
  drawOverlay(on.ctx, 640, 480, null, state({ hideVideo: true, calibrating: true, showHud: false }));
  assert.deepEqual(names(on.calls), ["clearRect"]);
});

test("esqueleto: se dibuja con el interruptor o al calibrar, y no sin ellos", () => {
  const draws = (s) => {
    const { ctx, calls } = fakeCtx();
    drawOverlay(ctx, 640, 480, landmarks(), state({ showHud: false, ...s }));
    return calls.length;
  };
  assert.equal(draws({ showSkeleton: false }), 1);
  assert.ok(draws({ showSkeleton: true }) > 10);
  assert.ok(draws({ showSkeleton: false, calibrating: true }) > 10);
});

test("HUD sin calibrar y con calibración", () => {
  const texts = (s) => {
    const { ctx, calls } = fakeCtx();
    drawOverlay(ctx, 640, 480, null, state(s));
    return calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  };
  assert.deepEqual(texts({}), ["POSE · SIN CALIBRAR"]);
  const withRows = texts({ baseline, smoothed: { ...baseline, neck: 0.31 } });
  assert.equal(withRows[0], "POSE · LIVE");
  assert.ok(withRows.length > 1);
});

test("etiquetas de calibración añaden el nombre; REF·CALIB aparece con baseline", () => {
  const texts = (calibrating) => {
    const { ctx, calls } = fakeCtx();
    drawOverlay(ctx, 640, 480, landmarks(), state({ showHud: false, calibrating, baseline }));
    return calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  };
  assert.ok(texts(true).includes("nariz"));
  assert.ok(!texts(false).includes("nariz"));
  assert.ok(texts(false).includes("REF·CALIB"));
});

test("estado de badge desconocido usa el color 'good'", () => {
  const strokes = (badgeState) => {
    const { ctx } = fakeCtx();
    drawOverlay(ctx, 640, 480, landmarks(), state({ badgeState, showHud: false }));
    return ctx.strokeStyle;
  };
  assert.doesNotThrow(() => strokes(undefined));
  assert.doesNotThrow(() => strokes("bad"));
});

test("landmarks parciales (solo algunos puntos) no lanzan", () => {
  const { ctx } = fakeCtx();
  const partial = [];
  partial[LM.NOSE] = { x: 0.5, y: 0.3 };
  assert.doesNotThrow(() => drawOverlay(ctx, 640, 480, partial, state({ calibrating: true, baseline })));
});

/* ── Sin asignaciones por fotograma: constantes reutilizadas y sin fugas de estado ── */

test("los arrays de setLineDash son constantes de módulo: el mismo objeto en cada fotograma", () => {
  const dashes = () => {
    const { ctx, calls } = fakeCtx();
    drawOverlay(ctx, 640, 480, landmarks(), state({ showHud: false, baseline }));
    return calls.filter((c) => c[0] === "setLineDash").map((c) => c[1]);
  };
  const [neck1, ref1] = dashes();
  const [neck2, ref2] = dashes();
  assert.deepEqual(neck1, [5, 5]);
  assert.deepEqual(ref1, [6, 8]);
  assert.equal(neck2, neck1, "vector de cuello: mismo array entre fotogramas");
  assert.equal(ref2, ref1, "línea de referencia: mismo array entre fotogramas");
});

test("el dibujo es una función del estado: repetir un fotograma da las mismas llamadas aunque se intercalen otros", () => {
  const record = (lms, s) => {
    const { ctx, calls } = fakeCtx();
    drawOverlay(ctx, 640, 480, lms, s);
    return calls;
  };
  const frameA = () => record(landmarks(), state({ baseline, smoothed: { ...baseline, neck: 0.24 } }));
  const frameB = () => record(null, state({ showHud: true, hideVideo: true }));
  const frameC = () => record(landmarks(), state({ calibrating: true, baseline, smoothed: { ...baseline, chin: 0.28 }, badgeState: "bad" }));

  const a1 = frameA();
  const b1 = frameB();
  const c1 = frameC();
  assert.deepEqual(frameA(), a1);
  assert.deepEqual(frameC(), c1);
  assert.deepEqual(frameB(), b1);
  assert.deepEqual(frameA(), a1, "ni el HUD, ni las etiquetas, ni las fuentes memorizadas arrastran estado");
});

test("HUD: las filas del informe no se arrastran entre fotogramas (con, sin y otra vez con calibración)", () => {
  const texts = (s) => {
    const { ctx, calls } = fakeCtx();
    drawOverlay(ctx, 640, 480, null, state(s));
    return calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  };
  const withRows = texts({ baseline, smoothed: { ...baseline, neck: 0.24 } });
  assert.equal(withRows[0], "POSE · LIVE");
  assert.equal(withRows.length, 1 + 6 * 2, "cabecera + código y porcentaje de las 6 métricas");

  assert.deepEqual(texts({}), ["POSE · SIN CALIBRAR"], "sin calibrar no quedan filas de antes");
  assert.deepEqual(texts({ baseline, smoothed: null }), ["POSE · SIN CALIBRAR"]);
  assert.deepEqual(texts({ baseline, smoothed: { ...baseline, neck: 0.24 } }), withRows);
});

test("HUD: el porcentaje se formatea como siempre (relleno a 4, negativos y valores enormes)", () => {
  const percentLabels = (smoothed) => {
    const { ctx, calls } = fakeCtx();
    drawOverlay(ctx, 640, 480, null, state({ baseline, smoothed }));
    const texts = calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
    return texts.filter((t) => t.endsWith("%"));
  };
  const expected = (smoothed) =>
    metricReport(smoothed, baseline, 1).map((row) => `${Math.round(row.ratio * 100)}%`.padStart(4));

  for (const smoothed of [
    { ...baseline },                        // todo a 0 %
    { ...baseline, neck: 0.24 },            // 125 %
    { ...baseline, chin: 0.28 },            // 50 %
    { ...baseline, neck: 0.36 },            // negativo: -125 %
    { ...baseline, neck: -50, width: 90 },  // > 999 %: no pasa por la memoria de textos
  ]) {
    const labels = percentLabels(smoothed);
    assert.deepEqual(labels, expected(smoothed));
    assert.equal(labels.length, 6);
  }
  assert.deepEqual(percentLabels({ ...baseline }), ["  0%", "  0%", "  0%", "  0%", "  0%", "  0%"]);
  assert.equal(percentLabels({ ...baseline, chin: 0.28 })[4], " 50%");
});

test("las etiquetas de calibración (dos líneas) y las normales (una) mantienen su texto y su orden", () => {
  const labelTexts = (calibrating) => {
    const { ctx, calls } = fakeCtx();
    drawOverlay(ctx, 640, 480, landmarks(), state({ showHud: false, calibrating }));
    return calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
  };
  assert.deepEqual(labelTexts(false), ["NOSE·00", "EAR·07", "EAR·08", "SHLD·11", "SHLD·12"]);
  assert.deepEqual(labelTexts(true), [
    "NOSE·00", "nariz", "EAR·07", "oreja", "EAR·08", "oreja", "SHLD·11", "hombro", "SHLD·12", "hombro",
  ]);
});
