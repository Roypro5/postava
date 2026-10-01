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
