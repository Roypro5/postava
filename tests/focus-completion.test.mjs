// Invariante de estadísticas de enfoque, con los módulos REALES createTimer +
// createFocusStats (+ stats-session y stats-queue en el último caso) y solo el
// pegamento de callbacks replicado de app.js:
//   - saltar la fase (skip) NO registra estadísticas;
//   - un pomodoro completado registra UNA vez, con elapsedMs > 0 y el estado tal
//     como estaba justo antes de focusStats.reset().
//
// El cableado `onPhaseEnd` de abajo copia app.js:42-50 (y startTimer/pauseTimer/
// resetTimer, app.js:323-377) a propósito: es un test unitario rápido y sin
// globales. La versión sobre el app.js real está en app-wiring.test.mjs; si cambias
// esos callbacks en app.js, actualiza esta réplica.
import assert from "node:assert/strict";
import test from "node:test";
import { createFocusStats } from "../focus-stats.js";
import { createStatsQueue } from "../stats-queue.js";
import { bindFocusAccount, completedFocusPayload } from "../stats-session.js";
import { createTimer } from "../timer.js";

const MIN = 60_000;
const USER = "user_test12345678";

function setup({ accountId = USER, recordCompletedFocus } = {}) {
  const clock = { t: Date.UTC(2026, 0, 5, 9, 0, 0), advance(ms) { clock.t += ms; } };
  const seen = { recorded: [], clearAlert: 0, phaseEndSounds: 0 };

  const focusStats = createFocusStats(() => clock.t);
  // Como en app.js, `recordCompletedFocus` recibe el propio objeto focusStats (que se
  // reinicia justo después): el espía toma la foto en el momento de la llamada.
  const statsQueue = {
    recordCompletedFocus: recordCompletedFocus ?? ((stats) => {
      seen.recorded.push({ ...stats.snapshot(), payload: completedFocusPayload(stats, "id-de-prueba") });
    }),
  };

  const timer = createTimer({
    getSettings: () => ({ focusMins: "25", breakMins: "5" }),
    now: () => clock.t,
    onPhaseEnd: ({ from, skipped }) => {
      seen.phaseEndSounds += 1; // soundPhaseEnd()
      seen.clearAlert += 1; // monitor.clearAlert()
      if (from === "focus") {
        focusStats.stop();
        if (!skipped && focusStats.elapsedMs > 0) statsQueue.recordCompletedFocus(focusStats);
        focusStats.reset();
      }
    },
  });
  timer.setPhase("focus");

  const actions = {
    /** startTimer(): enlaza la cuenta al empezar el bloque y arranca temporizador y métricas. */
    start() {
      if (timer.phase === "focus" && !focusStats.startedAt) bindFocusAccount(focusStats, accountId);
      timer.start();
      if (timer.phase === "focus") focusStats.begin();
    },
    /** pauseTimer() */
    pause() {
      if (timer.phase === "focus") focusStats.stop();
      timer.pause();
    },
    /** resetTimer() */
    reset() {
      focusStats.stop();
      focusStats.reset();
      timer.reset();
    },
    /** Deja correr el reloj y da el tick del intervalo de 250 ms. */
    elapse(ms) {
      clock.advance(ms);
      timer.tick();
    },
  };
  return { clock, seen, focusStats, timer, ...actions };
}

test("saltar la fase de enfoque no registra estadísticas y reinicia las métricas", () => {
  const s = setup();
  s.start();
  s.focusStats.addGood(5_000);
  s.elapse(10 * MIN);
  assert.equal(s.focusStats.elapsedMs, 0, "el bloque sigue activo: aún no se ha acumulado");

  s.timer.skip();

  assert.deepEqual(s.seen.recorded, []);
  assert.equal(s.timer.completed, 0, "un skip no cuenta como pomodoro completado");
  assert.equal(s.timer.phase, "break");
  assert.equal(s.focusStats.elapsedMs, 0);
  assert.equal(s.focusStats.goodMs, 0);
  assert.equal(s.focusStats.accountId, null);
  assert.equal(s.focusStats.startedAt, null);
});

test("saltar justo tras empezar (elapsedMs = 0) tampoco registra nada", () => {
  const s = setup();
  s.start();
  s.timer.skip();
  assert.deepEqual(s.seen.recorded, []);
});

test("un pomodoro completado registra exactamente una vez, con elapsedMs > 0", () => {
  const s = setup();
  s.start();
  s.focusStats.addGood(20 * MIN);
  s.focusStats.addBad(3 * MIN, ["neckDrop"]);
  s.focusStats.addAlert();
  s.elapse(25 * MIN);

  assert.equal(s.seen.recorded.length, 1);
  const [record] = s.seen.recorded;
  assert.equal(record.elapsedMs, 25 * MIN);
  assert.ok(record.elapsedMs > 0);
  assert.equal(record.accountId, USER);
  assert.equal(record.goodMs, 20 * MIN);
  assert.equal(record.badMs, 3 * MIN);
  assert.equal(record.alerts, 1);
  assert.deepEqual(record.issues, { neck: 1, shoulders: 0, tilt: 0, distance: 0 });
  assert.equal(record.payload.durationMinutes, 25);
  assert.equal(record.payload.expectedUserId, USER);
  assert.equal(record.startedAt, new Date(Date.UTC(2026, 0, 5, 9, 0, 0)).toISOString());

  assert.equal(s.timer.completed, 1);
  assert.equal(s.timer.phase, "break");
  assert.equal(s.focusStats.elapsedMs, 0, "las métricas se reinician tras registrar");
  assert.equal(s.focusStats.accountId, null);
});

test("ticks posteriores a completar no vuelven a registrar", () => {
  const s = setup();
  s.start();
  s.elapse(25 * MIN);
  for (let i = 0; i < 5; i++) s.elapse(250);
  assert.equal(s.seen.recorded.length, 1);
});

test("la pausa no cuenta: elapsedMs suma solo el tiempo activo", () => {
  const s = setup();
  s.start();
  s.elapse(10 * MIN);
  s.pause();
  s.clock.advance(7 * MIN); // pausado
  s.start();
  s.elapse(15 * MIN);

  assert.equal(s.seen.recorded.length, 1);
  assert.equal(s.seen.recorded[0].elapsedMs, 25 * MIN, "10 + 15 min activos, sin los 7 de pausa");
});

test("un enfoque que termina sin tiempo activo (elapsedMs = 0) no se registra", () => {
  const s = setup();
  // Temporizador en marcha pero sin `focusStats.begin()`: nunca hubo tiempo activo.
  s.timer.start();
  s.elapse(25 * MIN);
  assert.equal(s.timer.completed, 1, "el temporizador sí completó la fase");
  assert.deepEqual(s.seen.recorded, []);
});

test("el descanso, completado o saltado, nunca registra", () => {
  const s = setup();
  s.start();
  s.elapse(25 * MIN); // enfoque completado -> descanso (1 registro)
  assert.equal(s.seen.recorded.length, 1);

  s.elapse(5 * MIN); // descanso completado -> sesión 2
  assert.equal(s.timer.phase, "focus");
  assert.equal(s.timer.session, 2);
  assert.equal(s.seen.recorded.length, 1);

  s.start();
  s.timer.skip(); // enfoque 2 saltado -> descanso
  s.timer.skip(); // descanso saltado -> sesión 3
  assert.equal(s.timer.session, 3);
  assert.equal(s.seen.recorded.length, 1, "ni skip de enfoque ni de descanso añaden registros");
});

test("cada pomodoro completado parte de cero: sin arrastre del bloque anterior", () => {
  const s = setup();
  s.start();
  s.focusStats.addGood(4 * MIN);
  s.focusStats.addAlert();
  s.elapse(25 * MIN);
  s.elapse(5 * MIN); // descanso

  s.start();
  s.focusStats.addGood(1 * MIN);
  s.elapse(25 * MIN);

  assert.equal(s.seen.recorded.length, 2);
  assert.equal(s.seen.recorded[1].goodMs, 1 * MIN);
  assert.equal(s.seen.recorded[1].alerts, 0);
  assert.equal(s.seen.recorded[1].elapsedMs, 25 * MIN);
});

test("reiniciar a mitad del enfoque descarta el bloque sin registrar", () => {
  const s = setup();
  s.start();
  s.elapse(12 * MIN);
  s.reset();
  assert.deepEqual(s.seen.recorded, []);
  assert.equal(s.focusStats.elapsedMs, 0);
  assert.equal(s.timer.session, 1);
});

test("como invitado (sin cuenta) se llama al registro pero no hay payload que enviar", () => {
  const s = setup({ accountId: null });
  s.start();
  s.elapse(25 * MIN);
  assert.equal(s.seen.recorded.length, 1);
  assert.equal(s.seen.recorded[0].payload, null, "completedFocusPayload devuelve null sin cuenta");
});

test("con la cola real: el cuerpo enviado se construye antes de focusStats.reset()", async () => {
  // Si recordCompletedFocus leyera focusStats tras un await, vería el estado ya
  // reiniciado (accountId null -> ningún envío, o durationMinutes = 1). Con la cola
  // real y un fetch falso se comprueba que el payload es el del bloque completado.
  const posts = [];
  const storage = new Map();
  const queue = createStatsQueue({
    fetch: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    },
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    importAuth: async () => ({ loadAuth: async () => ({ restore: async () => ({ id: USER }) }) }),
    randomUUID: () => "3f2b8c1e-9d4a-4b6e-8a1f-2c3d4e5f6a7b",
  });
  const sent = [];
  const s = setup({
    recordCompletedFocus: (stats) => {
      const pending = queue.recordCompletedFocus(stats);
      sent.push(pending);
      return pending;
    },
  });

  s.start();
  s.focusStats.addGood(20 * MIN);
  s.elapse(25 * MIN);
  await Promise.all(sent);

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/stats/sessions");
  assert.equal(posts[0].body.expectedUserId, USER);
  assert.equal(posts[0].body.durationMinutes, 25);
  assert.equal(posts[0].body.goodMs, 20 * MIN);
  assert.equal(storage.get(`postava.stats.pending.v2:${USER}`), "[]", "cola vaciada tras el envío");

  // Y un skip posterior no añade envíos.
  s.elapse(5 * MIN);
  s.start();
  s.timer.skip();
  await Promise.all(sent);
  assert.equal(posts.length, 1);
});
