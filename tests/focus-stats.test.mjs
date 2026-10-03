import assert from "node:assert/strict";
import test from "node:test";
import { createFocusStats } from "../focus-stats.js";
import { bindFocusAccount, completedFocusPayload } from "../stats-session.js";
import { validateSessionPayload } from "../server/stats-store.mjs";

function fakeClock(start = Date.parse("2026-01-15T11:00:00.000Z")) {
  const clock = { t: start, now: () => clock.t, advance: (ms) => { clock.t += ms; } };
  return clock;
}

test("estado inicial vacío", () => {
  const stats = createFocusStats(fakeClock().now);
  assert.equal(stats.accountId, null);
  assert.equal(stats.startedAt, null);
  assert.equal(stats.activeSince, null);
  assert.equal(stats.elapsedMs, 0);
  assert.deepEqual(stats.issues, { neck: 0, shoulders: 0, tilt: 0, distance: 0 });
  assert.equal(stats.activeIssueKeys.size, 0);
});

test("begin fija startedAt (ISO) y activeSince una sola vez; stop acumula elapsedMs", () => {
  const clock = fakeClock();
  const stats = createFocusStats(clock.now);
  stats.begin();
  assert.equal(stats.startedAt, "2026-01-15T11:00:00.000Z");
  clock.advance(60_000);
  stats.begin(); // no-op mientras está activo
  assert.equal(stats.activeSince, Date.parse("2026-01-15T11:00:00.000Z"));
  clock.advance(30_000);
  stats.stop();
  assert.equal(stats.elapsedMs, 90_000);
  assert.equal(stats.activeSince, null);
  stats.stop(); // idempotente
  assert.equal(stats.elapsedMs, 90_000);
});

test("pausa y reanudación acumulan solo el tiempo activo y conservan startedAt", () => {
  const clock = fakeClock();
  const stats = createFocusStats(clock.now);
  stats.begin();
  clock.advance(10_000);
  stats.stop();
  clock.advance(500_000); // pausa: no cuenta
  stats.begin();
  assert.equal(stats.startedAt, "2026-01-15T11:00:00.000Z");
  clock.advance(5_000);
  stats.stop();
  assert.equal(stats.elapsedMs, 15_000);
});

test("stop no acumula tiempo negativo si el reloj retrocede", () => {
  const clock = fakeClock();
  const stats = createFocusStats(clock.now);
  stats.begin();
  clock.advance(-5_000);
  stats.stop();
  assert.equal(stats.elapsedMs, 0);
});

test("addBad cuenta cada incidencia nueva por categoría y no recuenta las persistentes", () => {
  const stats = createFocusStats(fakeClock().now);
  stats.addBad(100, ["neckDrop", "sideLean"]);
  stats.addBad(100, ["neckDrop", "sideLean"]); // siguen activas
  assert.deepEqual(stats.issues, { neck: 1, shoulders: 1, tilt: 0, distance: 0 });
  stats.addBad(100, ["neckDrop", "proximity", "shoulderTilt"]);
  assert.deepEqual(stats.issues, { neck: 1, shoulders: 1, tilt: 1, distance: 1 });
  assert.equal(stats.badMs, 300);
  // chinDown y slump también son "neck"
  stats.addBad(50, ["chinDown"]);
  assert.equal(stats.issues.neck, 2);
  stats.addBad(50, ["desconocida"]);
  assert.deepEqual(stats.issues, { neck: 2, shoulders: 1, tilt: 1, distance: 1 });
});

test("addGood acumula goodMs y limpia las incidencias activas (se recuentan al reaparecer)", () => {
  const stats = createFocusStats(fakeClock().now);
  stats.addBad(100, ["slump"]);
  stats.addGood(200);
  assert.equal(stats.goodMs, 200);
  assert.equal(stats.activeIssueKeys.size, 0);
  stats.addBad(100, ["slump"]);
  assert.equal(stats.issues.neck, 2);
  stats.clearActiveIssues();
  assert.equal(stats.activeIssueKeys.size, 0);
});

test("addAlert incrementa alerts", () => {
  const stats = createFocusStats(fakeClock().now);
  stats.addAlert();
  stats.addAlert();
  assert.equal(stats.alerts, 2);
});

test("reset devuelve todo al estado inicial (incluido accountId y el Set)", () => {
  const clock = fakeClock();
  const stats = createFocusStats(clock.now);
  bindFocusAccount(stats, "user_abcdefgh1234");
  stats.begin();
  clock.advance(1000);
  stats.addBad(100, ["neckDrop"]);
  stats.addGood(50);
  stats.addAlert();
  stats.stop();
  stats.reset();
  assert.equal(stats.accountId, null);
  assert.equal(stats.startedAt, null);
  assert.equal(stats.activeSince, null);
  assert.equal(stats.elapsedMs, 0);
  assert.equal(stats.goodMs, 0);
  assert.equal(stats.badMs, 0);
  assert.equal(stats.alerts, 0);
  assert.deepEqual(stats.issues, { neck: 0, shoulders: 0, tilt: 0, distance: 0 });
  assert.equal(stats.activeIssueKeys.size, 0);
});

test("reset crea un objeto issues nuevo (un payload previo no se altera)", () => {
  const stats = createFocusStats(fakeClock().now);
  stats.addBad(10, ["neckDrop"]);
  const snap = stats.snapshot();
  stats.reset();
  stats.addBad(10, ["neckDrop"]);
  assert.equal(snap.issues.neck, 1);
});

test("bindFocusAccount solo asigna cuenta antes de empezar el bloque", () => {
  const stats = createFocusStats(fakeClock().now);
  bindFocusAccount(stats, "user_a");
  assert.equal(stats.accountId, "user_a");
  stats.begin();
  bindFocusAccount(stats, "user_b");
  assert.equal(stats.accountId, "user_a");
});

test("con 0 muestras el payload no divide por cero y da 1 minuto mínimo", () => {
  const clock = fakeClock();
  const stats = createFocusStats(clock.now);
  bindFocusAccount(stats, "user_abcdefgh1234");
  stats.begin();
  clock.advance(1000);
  stats.stop();
  const p = completedFocusPayload(stats, "3f2b8c1e-9d4a-4b6e-8a1f-2c3d4e5f6a7b");
  assert.equal(p.goodMs, 0);
  assert.equal(p.badMs, 0);
  assert.equal(p.durationMinutes, 1);
  assert.ok(Number.isFinite(p.goodMs) && Number.isFinite(p.badMs));
});

test("el payload redondea goodMs/badMs y es válido para el servidor", () => {
  const clock = fakeClock();
  const stats = createFocusStats(clock.now);
  bindFocusAccount(stats, "user_abcdefgh1234");
  stats.begin();
  stats.addGood(600000.4);
  stats.addBad(300000.6, ["neckDrop", "proximity"]);
  stats.addAlert();
  clock.advance(1_500_000);
  stats.stop();
  const p = completedFocusPayload(stats, "3f2b8c1e-9d4a-4b6e-8a1f-2c3d4e5f6a7b");
  assert.equal(p.goodMs, 600000);
  assert.equal(p.badMs, 300001);
  assert.equal(p.durationMinutes, 25);
  assert.deepEqual(p.issues, { neck: 1, shoulders: 0, tilt: 0, distance: 1 });
  assert.ok(validateSessionPayload(p, clock.now() + 1000));
});

test("snapshot: datos puros compatibles con completedFocusPayload y sin coordenadas", () => {
  const clock = fakeClock();
  const stats = createFocusStats(clock.now);
  bindFocusAccount(stats, "user_abcdefgh1234");
  stats.begin();
  stats.addBad(100, ["sideLean"]);
  clock.advance(2000);
  stats.stop();
  const snap = stats.snapshot();
  assert.deepEqual(Object.keys(snap).sort(), [
    "accountId", "alerts", "badMs", "elapsedMs", "goodMs", "issues", "startedAt",
  ]);
  for (const value of Object.values(snap)) assert.notEqual(typeof value, "function");
  assert.equal(JSON.stringify(snap).includes("landmark"), false);
  assert.deepEqual(completedFocusPayload(snap, "id-1"), completedFocusPayload(stats, "id-1"));
  snap.issues.neck = 99; // es una copia
  assert.equal(stats.issues.neck, 0);
});

test("sin accountId (invitado) no hay payload", () => {
  const stats = createFocusStats(fakeClock().now);
  stats.begin();
  assert.equal(completedFocusPayload(stats, "id-1"), null);
});

test("stop(capMs): una suspensión del equipo no infla el tiempo de enfoque", () => {
  let t = 1_000_000;
  const stats = createFocusStats(() => t);
  stats.begin();
  t += 10 * 60_000;
  stats.stop(25 * 60_000); // dentro del tope: se respeta
  assert.equal(stats.elapsedMs, 10 * 60_000);
  stats.begin();
  t += 8 * 3_600_000; // portátil dormido 8 h
  stats.stop(25 * 60_000);
  assert.equal(stats.elapsedMs, 25 * 60_000, "acotado al total planificado");
  assert.equal(completedFocusPayload({ ...stats.snapshot(), accountId: "u" }, "i").durationMinutes, 25);
});

test("stop() sin tope conserva el comportamiento anterior", () => {
  let t = 1000;
  const stats = createFocusStats(() => t);
  stats.begin();
  t += 3_600_000;
  stats.stop();
  assert.equal(stats.elapsedMs, 3_600_000);
});

test("stop(capMs, atMs) cierra en el instante dado sin contar el tiempo dormido", () => {
  let t = 1_000_000;
  const stats = createFocusStats(() => t);
  stats.begin();
  const lastTick = t + 4 * 60_000;
  t += 9 * 3_600_000; // despierta 9 h después
  stats.stop(25 * 60_000, lastTick);
  assert.equal(stats.elapsedMs, 4 * 60_000);
  assert.equal(stats.activeSince, null);
});

test("stop(capMs, atMs) con atMs anterior al inicio no resta tiempo", () => {
  let t = 5_000;
  const stats = createFocusStats(() => t);
  stats.begin();
  stats.stop(Infinity, 1_000);
  assert.equal(stats.elapsedMs, 0);
});
