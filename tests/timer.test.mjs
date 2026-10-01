import assert from "node:assert/strict";
import test from "node:test";
import { createTimer } from "../timer.js";

const MIN = 60_000;

function setup(settings = { focusMins: "25", breakMins: "5" }) {
  const clock = { t: 1_000_000, advance(ms) { clock.t += ms; } };
  const events = [];
  const cfg = { ...settings };
  const timer = createTimer({
    getSettings: () => cfg,
    now: () => clock.t,
    onPhase: (e) => events.push(["phase", e.phase]),
    onTick: () => events.push(["tick"]),
    onPhaseEnd: (e) => events.push(["end", e.from, e.skipped]),
    onComplete: (e) => events.push(["complete", e.from, e.to, e.skipped]),
  });
  return { clock, events, cfg, timer };
}

test("estado inicial", () => {
  const { timer } = setup();
  assert.equal(timer.phase, "focus");
  assert.equal(timer.running, false);
  assert.equal(timer.remaining, 25 * MIN);
  assert.equal(timer.total, 25 * MIN);
  assert.equal(timer.session, 1);
  assert.equal(timer.completed, 0);
});

test("phaseDurationMs aplica valores por defecto y límites (1-180 enfoque, 1-60 descanso)", () => {
  const { timer, cfg } = setup();
  assert.equal(timer.phaseDurationMs("focus"), 25 * MIN);
  assert.equal(timer.phaseDurationMs("break"), 5 * MIN);
  Object.assign(cfg, { focusMins: "", breakMins: "0" });
  assert.equal(timer.phaseDurationMs("focus"), 25 * MIN);
  assert.equal(timer.phaseDurationMs("break"), 5 * MIN);
  Object.assign(cfg, { focusMins: "500", breakMins: "500" });
  assert.equal(timer.phaseDurationMs("focus"), 180 * MIN);
  assert.equal(timer.phaseDurationMs("break"), 60 * MIN);
  Object.assign(cfg, { focusMins: "-4", breakMins: "-4" });
  assert.equal(timer.phaseDurationMs("focus"), 1 * MIN);
  assert.equal(timer.phaseDurationMs("break"), 1 * MIN);
  Object.assign(cfg, { focusMins: "12", breakMins: "3" });
  assert.equal(timer.phaseDurationMs("focus"), 12 * MIN);
  assert.equal(timer.phaseDurationMs("break"), 3 * MIN);
});

test("setPhase fija total/remaining/endAt y notifica onPhase", () => {
  const { timer, clock, events } = setup();
  timer.setPhase("break", true);
  assert.equal(timer.phase, "break");
  assert.equal(timer.total, 5 * MIN);
  assert.equal(timer.remaining, 5 * MIN);
  assert.equal(timer.endAt, clock.t + 5 * MIN);
  assert.equal(timer.running, true);
  assert.deepEqual(events, [["phase", "break"]]);
});

test("start fija endAt y running; tick calcula remaining desde endAt", () => {
  const { timer, clock } = setup();
  timer.start();
  assert.equal(timer.running, true);
  assert.equal(timer.endAt, clock.t + 25 * MIN);
  clock.advance(10_000);
  timer.tick();
  assert.equal(timer.remaining, 25 * MIN - 10_000);
});

test("tick con el temporizador parado no cambia remaining pero sí notifica onTick", () => {
  const { timer, clock, events } = setup();
  clock.advance(5000);
  timer.tick();
  assert.equal(timer.remaining, 25 * MIN);
  assert.deepEqual(events, [["tick"]]);
});

test("ciclo enfoque -> descanso (autoinicio) -> enfoque (parado), con sesión y completados", () => {
  const { timer, clock, events } = setup();
  timer.start();
  clock.advance(25 * MIN);
  timer.tick();
  assert.equal(timer.phase, "break");
  assert.equal(timer.running, true);
  assert.equal(timer.completed, 1);
  assert.equal(timer.session, 1);
  assert.equal(timer.remaining, 5 * MIN);
  assert.equal(timer.endAt, clock.t + 5 * MIN);

  clock.advance(5 * MIN);
  timer.tick();
  assert.equal(timer.phase, "focus");
  assert.equal(timer.running, false);
  assert.equal(timer.session, 2);
  assert.equal(timer.completed, 1);
  assert.equal(timer.remaining, 25 * MIN);

  assert.deepEqual(events, [
    ["end", "focus", false], ["phase", "break"], ["complete", "focus", "break", false],
    ["end", "break", false], ["phase", "focus"], ["complete", "break", "focus", false],
  ]);
});

test("onPhaseEnd se dispara antes del cambio de estado y onComplete después", () => {
  const seen = [];
  let timer;
  timer = createTimer({
    getSettings: () => ({ focusMins: "1", breakMins: "1" }),
    now: () => 0,
    onPhaseEnd: () => seen.push(["end", timer.phase, timer.completed]),
    onComplete: () => seen.push(["complete", timer.phase, timer.completed]),
  });
  timer.completePhase();
  assert.deepEqual(seen, [["end", "focus", 0], ["complete", "break", 1]]);
});

test("no hay descanso largo: cada ciclo usa el descanso normal y suma una sesión", () => {
  const { timer, clock } = setup({ focusMins: "1", breakMins: "1" });
  timer.setPhase("focus"); // como en el arranque de app.js
  for (let i = 1; i <= 9; i++) {
    timer.start();
    clock.advance(MIN);
    timer.tick();
    assert.equal(timer.phase, "break");
    assert.equal(timer.total, MIN);
    assert.equal(timer.completed, i);
    assert.equal(timer.session, i);
    clock.advance(MIN);
    timer.tick();
    assert.equal(timer.phase, "focus");
    assert.equal(timer.session, i + 1);
  }
});

test("pausa y reanudación: sin deriva y endAt recalculado al reanudar", () => {
  const { timer, clock } = setup();
  timer.start();
  clock.advance(60_000);
  timer.tick();
  timer.pause();
  assert.equal(timer.running, false);
  const frozen = timer.remaining;
  assert.equal(frozen, 24 * MIN);

  clock.advance(10 * MIN); // en pausa el tiempo no corre
  timer.tick();
  assert.equal(timer.remaining, frozen);

  timer.start();
  assert.equal(timer.endAt, clock.t + 24 * MIN);
  clock.advance(30_000);
  timer.tick();
  assert.equal(timer.remaining, 24 * MIN - 30_000);
});

test("ticks irregulares no acumulan deriva: remaining depende solo de endAt", () => {
  const { timer, clock } = setup();
  timer.start();
  const endAt = timer.endAt;
  for (const step of [250, 700, 251, 1900, 250]) {
    clock.advance(step);
    timer.tick();
    assert.equal(timer.endAt, endAt);
    assert.equal(timer.remaining, endAt - clock.t);
  }
});

test("salto de reloj hacia adelante (pestaña en segundo plano) completa la fase en el siguiente tick", () => {
  const { timer, clock } = setup();
  timer.start();
  clock.advance(3 * 60 * MIN); // muy por encima de la duración
  timer.tick();
  assert.equal(timer.phase, "break");
  assert.equal(timer.completed, 1);
  assert.equal(timer.remaining, 5 * MIN);
  assert.equal(timer.endAt, clock.t + 5 * MIN); // el descanso arranca desde "ahora"
});

test("salto de reloj parcial: remaining refleja el tiempo real transcurrido", () => {
  const { timer, clock } = setup();
  timer.start();
  clock.advance(20 * MIN);
  timer.tick();
  assert.equal(timer.remaining, 5 * MIN);
  assert.equal(timer.phase, "focus");
});

test("skip desde enfoque: pasa a descanso sin contar completado", () => {
  const { timer, events } = setup();
  timer.start();
  timer.skip();
  assert.equal(timer.phase, "break");
  assert.equal(timer.running, true);
  assert.equal(timer.completed, 0);
  assert.deepEqual(events.filter((e) => e[0] !== "phase"), [
    ["end", "focus", true], ["complete", "focus", "break", true],
  ]);
});

test("skip desde descanso: sube sesión, vuelve a enfoque parado", () => {
  const { timer } = setup();
  timer.setPhase("break", true);
  timer.skip();
  assert.equal(timer.phase, "focus");
  assert.equal(timer.running, false);
  assert.equal(timer.session, 2);
  assert.equal(timer.completed, 0);
});

test("start con remaining agotado restaura la duración de la fase", () => {
  const { timer, clock } = setup();
  timer.remaining = 0;
  timer.start();
  assert.equal(timer.remaining, 25 * MIN);
  assert.equal(timer.endAt, clock.t + 25 * MIN);
});

test("reset vuelve a sesión 1, completados 0, enfoque parado", () => {
  const { timer, clock } = setup();
  timer.start();
  clock.advance(25 * MIN);
  timer.tick();
  timer.reset();
  assert.equal(timer.phase, "focus");
  assert.equal(timer.running, false);
  assert.equal(timer.session, 1);
  assert.equal(timer.completed, 0);
  assert.equal(timer.remaining, 25 * MIN);
});

test("cambiar la duración con el reloj parado y llamar a setPhase reinicia remaining", () => {
  const { timer, cfg } = setup();
  cfg.focusMins = "10";
  timer.setPhase(timer.phase);
  assert.equal(timer.total, 10 * MIN);
  assert.equal(timer.remaining, 10 * MIN);
});

test("sin callbacks ni getSettings no lanza y usa Date.now por defecto", () => {
  const timer = createTimer();
  timer.setPhase("focus");
  const before = Date.now();
  timer.start();
  assert.ok(timer.endAt >= before + 25 * MIN);
  timer.tick();
  timer.skip();
  assert.equal(timer.phase, "break");
});
