import assert from "node:assert/strict";
import test from "node:test";
import { createLogThrottle } from "../server/log-throttle.mjs";

// Reloj falso: el intervalo real es de un minuto y estas pruebas no esperan.
function clock(start = 1_000) {
  let time = start;
  return { now: () => time, advance: (ms) => { time += ms; }, set: (ms) => { time = ms; } };
}

test("la primera vez se registra; dentro del intervalo se omite y se cuenta lo omitido", () => {
  const c = clock();
  const admit = createLogThrottle({ intervalMs: 60_000, now: c.now });

  assert.deepEqual(admit("a"), { log: true, suppressed: 0 });
  c.advance(1);
  assert.equal(admit("a").log, false);
  c.advance(30_000);
  assert.equal(admit("a").log, false);
  c.advance(29_998); // justo antes de cumplirse el minuto desde el primer registro
  assert.equal(admit("a").log, false);
});

test("pasado el intervalo vuelve a registrar (una caída persistente sigue viéndose) e indica cuántas omitió", () => {
  const c = clock();
  const admit = createLogThrottle({ intervalMs: 60_000, now: c.now });

  assert.equal(admit("a").log, true);
  for (let i = 0; i < 4; i++) {
    c.advance(1_000);
    assert.equal(admit("a").log, false);
  }
  c.advance(60_000);
  assert.deepEqual(admit("a"), { log: true, suppressed: 4 });
  // Y el contador empieza de nuevo.
  c.advance(1_000);
  assert.deepEqual(admit("a"), { log: false, suppressed: 1 });
  c.advance(60_000);
  assert.deepEqual(admit("a"), { log: true, suppressed: 1 });
});

test("el intervalo se cuenta desde el último registro, no desde el último intento", () => {
  const c = clock();
  const admit = createLogThrottle({ intervalMs: 60_000, now: c.now });
  assert.equal(admit("a").log, true);
  // Un intento cada 20 s: si el intervalo se reiniciara con cada intento, nunca volvería a registrar.
  const logged = [];
  for (let i = 0; i < 9; i++) {
    c.advance(20_000);
    logged.push(admit("a").log);
  }
  assert.deepEqual(logged, [false, false, true, false, false, true, false, false, true]);
});

test("cada clave lleva su propia cuenta: una no silencia a otra", () => {
  const c = clock();
  const admit = createLogThrottle({ intervalMs: 60_000, now: c.now });
  assert.equal(admit("secret-key-missing").log, true);
  assert.equal(admit("secret-key-missing").log, false);
  assert.equal(admit("clerk-error").log, true, "otro motivo se registra aunque el primero esté silenciado");
  assert.equal(admit("clerk-error").log, false);
  assert.equal(admit("secret-key-missing").log, false);
});

test("si el reloj retrocede no se queda callado hasta alcanzar la hora anterior", () => {
  const c = clock(1_000_000);
  const admit = createLogThrottle({ intervalMs: 60_000, now: c.now });
  assert.equal(admit("a").log, true);
  c.set(10); // un ajuste del reloj de horas hacia atrás
  assert.equal(admit("a").log, true);
  c.advance(1);
  assert.equal(admit("a").log, false);
});

test("por defecto usa el reloj monotónico y un minuto de intervalo", () => {
  const admit = createLogThrottle();
  assert.equal(admit("a").log, true);
  assert.equal(admit("a").log, false);
  assert.equal(admit("b").log, true);
});
