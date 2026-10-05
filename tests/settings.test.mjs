import test from "node:test";
import assert from "node:assert/strict";
import { STORE_KEY, writeSettings, readSettings } from "../settings.js";

function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

test("la clave de almacenamiento no cambia", () => {
  assert.equal(STORE_KEY, "postava.v1");
});

test("roundtrip de ajustes", () => {
  const s = fakeStorage();
  const data = { focus: 25, brk: 5, sound: true, baseline: { neck: 0.3 } };
  writeSettings(data, s);
  assert.deepEqual(readSettings(s), data);
  assert.equal(s.getItem("postava.v1"), JSON.stringify(data));
});

test("sin datos guardados devuelve null", () => {
  assert.equal(readSettings(fakeStorage()), null);
});

test("JSON corrupto devuelve null sin lanzar", () => {
  assert.equal(readSettings(fakeStorage({ "postava.v1": "{no-json" })), null);
});

test("storage bloqueado: no lanza al leer ni escribir", () => {
  const blocked = {
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("QuotaExceeded"); },
  };
  assert.doesNotThrow(() => writeSettings({ a: 1 }, blocked));
  assert.equal(readSettings(blocked), null);
});

test("acceso a localStorage que lanza (global bloqueado) tampoco lanza", () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("SecurityError"); },
  });
  try {
    assert.doesNotThrow(() => writeSettings({ a: 1 }));
    assert.equal(readSettings(), null);
  } finally {
    if (desc) Object.defineProperty(globalThis, "localStorage", desc);
    else delete globalThis.localStorage;
  }
});

/* ── sanitizeSettings ───────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { sanitizeSettings, NUMERIC_LIMITS, SETTINGS_DEFAULTS } from "../settings.js";

const BASELINE = { neck: 0.3, width: 1, tilt: 0, side: 0.1, chin: 0.2, shoulderY: 0.5 };

test("los límites coinciden con min/max/step de index.html", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const ids = { focus: "focusMins", brk: "breakMins", tolerance: "tolerance", delay: "delaySeconds" };
  for (const [key, id] of Object.entries(ids)) {
    const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, `falta #${id}`);
    const attr = (n) => Number(tag.match(new RegExp(`\\s${n}="([^"]+)"`))?.[1]);
    const lim = NUMERIC_LIMITS[key];
    assert.deepEqual([lim.min, lim.max, lim.step], [attr("min"), attr("max"), attr("step")], key);
    assert.equal(SETTINGS_DEFAULTS[key], attr("value"), `valor por defecto de ${key}`);
  }
});

test("valores válidos se conservan", () => {
  const raw = { focus: 30, brk: 10, tolerance: 1.3, delay: 8, sound: false, skeleton: true,
    hud: false, hideVideo: true, camOnlyRunning: false, notify: true, baseline: BASELINE };
  assert.deepEqual(sanitizeSettings(raw), raw);
});

test("números fuera de rango se acotan y la cadena numérica se coacciona", () => {
  const s = sanitizeSettings({ focus: 99999, brk: -5, tolerance: 1e9, delay: "25" });
  assert.deepEqual([s.focus, s.brk, s.tolerance, s.delay], [180, 1, 1.8, 25]);
  assert.equal(sanitizeSettings({ focus: 1e9 }).focus, 180);
});

test("redondea al paso", () => {
  const s = sanitizeSettings({ focus: 25.6, tolerance: 1.04, delay: 7.4 });
  assert.deepEqual([s.focus, s.tolerance, s.delay], [26, 1, 7]);
});

test("basura (string, null, objeto, NaN, Infinity, array, booleano) usa el valor por defecto", () => {
  for (const bad of ["abc", null, {}, [], NaN, Infinity, -Infinity, true, undefined, ""]) {
    const s = sanitizeSettings({ focus: bad, brk: bad, tolerance: bad, delay: bad });
    assert.equal(s.focus, 25, String(bad));
    assert.equal(s.brk, 5);
    assert.equal(s.tolerance, 1);
    assert.equal(s.delay, 5);
  }
});

test("booleanos solo si son booleanos; si no, por defecto", () => {
  const s = sanitizeSettings({ sound: "true", skeleton: 0, hud: null, hideVideo: 1, camOnlyRunning: {}, notify: "yes" });
  for (const k of ["sound", "skeleton", "hud", "hideVideo", "camOnlyRunning", "notify"]) {
    assert.equal(s[k], SETTINGS_DEFAULTS[k], k);
  }
});

test("claves desconocidas se descartan", () => {
  const s = sanitizeSettings({ focus: 20, evil: 1, __proto__: { x: 1 }, constructor: 5 });
  assert.deepEqual(Object.keys(s).sort(), Object.keys(sanitizeSettings({})).sort());
  assert.equal("evil" in s, false);
});

test("objeto parcial, null, no objeto: ajustes por defecto completos", () => {
  const defaults = sanitizeSettings({});
  assert.deepEqual(sanitizeSettings(null), defaults);
  assert.deepEqual(sanitizeSettings("x"), defaults);
  assert.deepEqual(sanitizeSettings([1, 2]), defaults);
  assert.deepEqual(sanitizeSettings(42), defaults);
  assert.equal(sanitizeSettings({ focus: 40 }).focus, 40);
  assert.equal(sanitizeSettings({ focus: 40 }).brk, 5);
  assert.equal(defaults.baseline, null);
});

test("baseline inválido o incompleto es null; válido se copia solo con sus claves", () => {
  assert.equal(sanitizeSettings({ baseline: { neck: 1 } }).baseline, null);
  assert.equal(sanitizeSettings({ baseline: { ...BASELINE, neck: "1" } }).baseline, null);
  assert.equal(sanitizeSettings({ baseline: { ...BASELINE, tilt: NaN } }).baseline, null);
  assert.equal(sanitizeSettings({ baseline: 5 }).baseline, null);
  const b = sanitizeSettings({ baseline: { ...BASELINE, extra: 1 } }).baseline;
  assert.deepEqual(b, BASELINE);
});

test("JSON corrupto o sin almacenamiento + sanitize da ajustes por defecto", () => {
  const defaults = sanitizeSettings({});
  assert.deepEqual(sanitizeSettings(readSettings(fakeStorage({ "postava.v1": "{no" }))), defaults);
  assert.deepEqual(sanitizeSettings(readSettings(fakeStorage())), defaults);
});
