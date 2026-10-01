import assert from "node:assert/strict";
import test from "node:test";
import { createStatsQueue, accountScopedQueueKey } from "../stats-queue.js";

const PAYLOAD_KEYS = [
  "alerts", "badMs", "completed", "durationMinutes", "expectedUserId",
  "goodMs", "id", "issues", "issuesUnit", "startedAt", "type",
].sort();

function makeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
  };
}

function focusFor(accountId) {
  return {
    accountId,
    startedAt: "2026-01-01T10:00:00.000Z",
    elapsedMs: 25 * 60_000,
    goodMs: 1200000.4,
    badMs: 300000.6,
    alerts: 2,
    issues: { neck: 1, shoulders: 0, tilt: 1, distance: 0 },
  };
}

// account: { id } | null ; puede ser una función para cambiarla en caliente.
function setup({ account = { id: "u1" }, responses = [], storage = makeStorage(), importAuth, fetchImpl } = {}) {
  const state = { account, calls: [], events: [], warns: [], uuid: 0 };
  const queue = createStatsQueue({
    fetch: fetchImpl ?? (async (url, init) => {
      state.calls.push({ url, init, body: JSON.parse(init.body) });
      const next = responses.length ? responses.shift() : { ok: true, status: 200 };
      if (next instanceof Error) throw next;
      return next;
    }),
    storage,
    importAuth: importAuth ?? (async () => ({
      loadAuth: async () => ({
        restore: async () => (typeof state.account === "function" ? state.account() : state.account),
      }),
    })),
    onStatus: (e) => state.events.push(e),
    randomUUID: () => `id-${++state.uuid}`,
    warn: (...args) => state.warns.push(args),
  });
  return { queue, state, storage };
}

const ok = { ok: true, status: 200 };
const fail = (status) => ({ ok: false, status });
const lastError = (state) => state.events.filter((e) => e.type === "error").at(-1)?.message;
const stored = (storage, id) => JSON.parse(storage.getItem(accountScopedQueueKey(id)));

test("éxito 200: envía el payload con el contrato de red y vacía la cola", async () => {
  const { queue, state, storage } = setup();
  await queue.recordCompletedFocus(focusFor("u1"));
  assert.equal(state.calls.length, 1);
  const { url, init, body } = state.calls[0];
  assert.equal(url, "/api/stats/sessions");
  assert.equal(init.method, "POST");
  assert.equal(init.credentials, "same-origin");
  assert.deepEqual(init.headers, { "Content-Type": "application/json" });
  assert.deepEqual(Object.keys(body).sort(), PAYLOAD_KEYS);
  assert.equal(body.expectedUserId, "u1");
  assert.equal(body.goodMs, 1200000);
  assert.equal(body.durationMinutes, 25);
  assert.equal(body.id, "id-1");
  assert.deepEqual(stored(storage, "u1"), []);
  assert.deepEqual(queue.getPending(), []);
  assert.deepEqual(state.events.map((e) => e.type), ["saving", "clear"]);
  assert.equal(state.events[0].message, "Guardando estadísticas…");
});

test("el payload nunca contiene user_id ni campos de cámara", async () => {
  const { queue, state } = setup();
  await queue.recordCompletedFocus(focusFor("u1"));
  const serialized = JSON.stringify(state.calls[0].body).toLowerCase();
  assert.ok(!serialized.includes("user_id"));
  assert.ok(!/landmark|video|frame/.test(serialized));
});

test("focus sin cuenta vinculada no genera envío ni cola", async () => {
  const { queue, state, storage } = setup();
  await queue.recordCompletedFocus(focusFor(null));
  assert.equal(state.calls.length, 0);
  assert.equal(state.events.length, 0);
  assert.equal(storage.data.size, 0);
});

test("401: la sesión se conserva en cola y en storage con mensaje de sesión caducada", async () => {
  const { queue, state, storage } = setup({ responses: [fail(401)] });
  await queue.recordCompletedFocus(focusFor("u1"));
  assert.equal(state.calls.length, 1);
  assert.equal(stored(storage, "u1").length, 1);
  assert.equal(queue.getPending().length, 1);
  assert.equal(lastError(state), "La sesión de tu cuenta ha caducado. Tus sesiones pendientes se conservarán para reintentar.");
  // Reintento manual posterior con éxito reenvía la misma sesión (mismo id).
  await queue.retry();
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[1].body.id, state.calls[0].body.id);
  assert.deepEqual(stored(storage, "u1"), []);
  assert.equal(state.events.at(-1).type, "clear");
});

test("409 (cuenta distinta): la sesión se descarta y no se reintenta", async () => {
  const { queue, state, storage } = setup({ responses: [fail(409)] });
  await queue.recordCompletedFocus(focusFor("u1"));
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].body.expectedUserId, "u1");
  assert.deepEqual(stored(storage, "u1"), []);
  assert.deepEqual(queue.getPending(), []);
  assert.equal(state.warns.length, 1);
  assert.match(state.warns[0][0], /no reintentable \(409\): id-1/);
  assert.equal(state.events.at(-1).type, "clear");
});

test("400: también se descarta; se continúa con la siguiente sesión", async () => {
  const pre = [
    { id: "a", expectedUserId: "u1" },
    { id: "b", expectedUserId: "u1" },
  ];
  const storage = makeStorage({ [accountScopedQueueKey("u1")]: JSON.stringify(pre) });
  const { queue, state } = setup({ storage, responses: [fail(400), ok] });
  await queue.resumePending();
  assert.deepEqual(state.calls.map((c) => c.body.id), ["a", "b"]);
  assert.deepEqual(stored(storage, "u1"), []);
});

test("5xx: se conserva la cola y se informa; el reintento la envía", async () => {
  const { queue, state, storage } = setup({ responses: [fail(503)] });
  await queue.recordCompletedFocus(focusFor("u1"));
  assert.equal(stored(storage, "u1").length, 1);
  assert.equal(lastError(state), "No se pudo guardar la sesión. Tus sesiones pendientes se conservarán para reintentar.");
  await queue.retry();
  assert.deepEqual(stored(storage, "u1"), []);
});

test("red caída (fetch lanza): se conserva la cola con el mensaje del error", async () => {
  const { queue, state, storage } = setup({ responses: [new TypeError("Failed to fetch")] });
  await queue.recordCompletedFocus(focusFor("u1"));
  assert.equal(stored(storage, "u1").length, 1);
  assert.equal(lastError(state), "Failed to fetch Tus sesiones pendientes se conservarán para reintentar.");
});

test("un fallo transitorio corta el drenaje y conserva las sesiones siguientes en orden", async () => {
  const pre = ["a", "b", "c"].map((id) => ({ id, expectedUserId: "u1" }));
  const storage = makeStorage({ [accountScopedQueueKey("u1")]: JSON.stringify(pre) });
  const { queue, state } = setup({ storage, responses: [ok, fail(500)] });
  await queue.resumePending();
  assert.deepEqual(state.calls.map((c) => c.body.id), ["a", "b"]);
  assert.deepEqual(stored(storage, "u1").map((s) => s.id), ["b", "c"]);
});

test("retry concurrente se ignora mientras hay un envío en curso", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const { queue } = setup({
    fetchImpl: async (url, init) => { calls.push(init.body); await gate; return ok; },
  });
  const first = queue.recordCompletedFocus(focusFor("u1"));
  await new Promise((r) => setTimeout(r, 0));
  await queue.retry();
  release();
  await first;
  assert.equal(calls.length, 1);
});

test("cambio de cuenta: la sesión de A no se envía ni se mezcla con la cola de B", async () => {
  const { queue, state, storage } = setup({ responses: [new TypeError("offline")] });
  await queue.recordCompletedFocus(focusFor("u1"));
  assert.equal(stored(storage, "u1").length, 1);

  state.account = { id: "u2" };
  await queue.resumePending();
  assert.equal(state.calls.length, 1, "no se envía nada como B");
  assert.deepEqual(queue.getPending(), []);
  assert.equal(storage.getItem(accountScopedQueueKey("u2")), null);
  assert.equal(stored(storage, "u1").length, 1, "la cola de A queda intacta");

  state.account = { id: "u1" };
  await queue.resumePending();
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[1].body.expectedUserId, "u1");
  assert.deepEqual(stored(storage, "u1"), []);
});

test("sesión de la cuenta A completada cuando la cuenta activa es B: va a la cola de A y no se envía", async () => {
  const { queue, state, storage } = setup({ account: { id: "u2" } });
  await queue.resumePending(); // cuenta activa conocida: u2
  await queue.recordCompletedFocus(focusFor("u1"));
  assert.equal(state.calls.length, 0);
  assert.equal(stored(storage, "u1").length, 1);
  assert.equal(storage.getItem(accountScopedQueueKey("u2")), null);
  assert.equal(lastError(state), "Esta sesión pertenece a otra cuenta. Inicia sesión con esa cuenta para enviarla.");
});

test("la cola de A cargada para B se filtra: solo entradas con expectedUserId propio e id string", async () => {
  const dirty = [
    { id: "ok", expectedUserId: "u1" },
    { id: "otra", expectedUserId: "u2" },
    { id: 7, expectedUserId: "u1" },
    null,
  ];
  const storage = makeStorage({ [accountScopedQueueKey("u1")]: JSON.stringify(dirty) });
  const { queue, state } = setup({ storage });
  await queue.resumePending();
  assert.deepEqual(state.calls.map((c) => c.body.id), ["ok"]);
});

test("la cuenta cambia durante el drenaje: se detiene y avisa", async () => {
  const pre = ["a", "b"].map((id) => ({ id, expectedUserId: "u1" }));
  const storage = makeStorage({ [accountScopedQueueKey("u1")]: JSON.stringify(pre) });
  const { queue, state } = setup({
    storage,
    fetchImpl: async (url, init) => { state.calls.push(JSON.parse(init.body)); state.account = { id: "u2" }; return ok; },
  });
  await queue.resumePending();
  assert.deepEqual(state.calls.map((c) => c.id), ["a"]);
  assert.match(lastError(state), /^La cuenta cambió\. Inicia sesión con la cuenta original para reintentar\./);
  assert.deepEqual(stored(storage, "u1").map((s) => s.id), ["b"]);
});

test("invitado (sin cuenta): retry pide iniciar sesión y no hay red ni storage", async () => {
  const { queue, state, storage } = setup({ account: null });
  assert.equal(await queue.resolveAccount(), null);
  await queue.retry();
  assert.equal(state.calls.length, 0);
  assert.equal(storage.data.size, 0);
  assert.equal(lastError(state), "Inicia sesión para guardar tus estadísticas privadas.");
});

test("invitado: resumePending no muestra nada ni envía", async () => {
  const { queue, state } = setup({ account: { id: "" } });
  await queue.resumePending();
  assert.equal(state.calls.length, 0);
  assert.equal(state.events.length, 0);
});

test("sesión: resolveAccount devuelve el id de Clerk", async () => {
  const { queue } = setup({ account: { id: "u9" } });
  assert.equal(await queue.resolveAccount(), "u9");
});

test("JSON corrupto en storage: cola vacía, sin lanzar", async () => {
  const storage = makeStorage({ [accountScopedQueueKey("u1")]: "{no-json" });
  const { queue, state } = setup({ storage });
  await queue.resumePending();
  assert.deepEqual(queue.getPending(), []);
  assert.equal(state.calls.length, 0);
});

test("storage con valor no-array: cola vacía", async () => {
  const storage = makeStorage({ [accountScopedQueueKey("u1")]: '{"a":1}' });
  const { queue } = setup({ storage });
  await queue.resolveAccount();
  assert.deepEqual(queue.getPending(), []);
});

test("JSON corrupto al completar con cuenta no cargada: error con mensaje y sin envío", async () => {
  const storage = makeStorage({ [accountScopedQueueKey("u1")]: "{no-json" });
  const { queue, state } = setup({ storage });
  await queue.recordCompletedFocus(focusFor("u1"));
  assert.equal(state.calls.length, 0);
  assert.match(lastError(state), /Mantén esta página abierta y reintenta\.$/);
});

test("cola no-array al completar con cuenta no cargada: 'Cola de sesiones no válida'", async () => {
  const storage = makeStorage({ [accountScopedQueueKey("u1")]: '{"a":1}' });
  const { queue, state } = setup({ storage });
  await queue.recordCompletedFocus(focusFor("u1"));
  assert.equal(lastError(state), "Cola de sesiones no válida Mantén esta página abierta y reintenta.");
});

test("storage bloqueado al leer: la cola arranca vacía y el envío funciona", async () => {
  const storage = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("SecurityError"); } };
  const { queue, state } = setup({ storage });
  await queue.resolveAccount();
  assert.deepEqual(queue.getPending(), []);
  await queue.recordCompletedFocus(focusFor("u1"));
  assert.equal(state.calls.length, 1);
  // persistir falla, pero se muestra el aviso y el envío sigue.
  assert.ok(state.events.some((e) => e.type === "error" && e.message.startsWith("No se pudo guardar temporalmente")));
});

test("storage sin escritura con cuenta ya cargada y 5xx: avisa y conserva en memoria", async () => {
  const storage = { getItem: () => null, setItem() { throw new Error("QuotaExceeded"); } };
  const { queue, state } = setup({ storage, responses: [fail(500)] });
  await queue.resolveAccount();
  await queue.recordCompletedFocus(focusFor("u1"));
  assert.equal(queue.getPending().length, 1);
  const messages = state.events.filter((e) => e.type === "error").map((e) => e.message);
  assert.ok(messages[0].startsWith("No se pudo guardar temporalmente el envío fallido."));
});

test("storage bloqueado con cuenta ajena: error 'Mantén esta página abierta'", async () => {
  const storage = { getItem() { throw new Error("SecurityError"); }, setItem() {} };
  const { queue, state } = setup({ storage, account: { id: "u2" } });
  await queue.resumePending();
  await queue.recordCompletedFocus(focusFor("u1"));
  assert.equal(lastError(state), "SecurityError Mantén esta página abierta y reintenta.");
});

test("loadAuth que lanza: resumePending no propaga; retry muestra el error", async () => {
  const importAuth = async () => ({ loadAuth: async () => { throw new Error("clerk roto"); } });
  const { queue, state } = setup({ importAuth });
  await queue.resumePending();
  assert.equal(state.calls.length, 0);
  await queue.retry();
  assert.equal(lastError(state), "clerk roto Tus sesiones pendientes se conservarán para reintentar.");
});

test("import del adaptador falla: modo anónimo con aviso, sin cuenta ni red", async () => {
  const importAuth = async () => { throw new Error("bundle bloqueado"); };
  const { queue, state, storage } = setup({ importAuth });
  assert.equal(await queue.resolveAccount(), null);
  await queue.resumePending();
  await queue.recordCompletedFocus(focusFor("u1"));
  assert.equal(state.calls.length, 0);
  assert.equal(storage.getItem(accountScopedQueueKey("u1")) !== null, true, "la sesión se guarda en su cola local");
  assert.equal(lastError(state), "Esta sesión pertenece a otra cuenta. Inicia sesión con esa cuenta para enviarla.");
  assert.ok(state.warns.length >= 1);
  assert.equal(state.warns[0][0], "Bundle de cuenta no disponible; se continúa en modo anónimo.");
});

test("el import del adaptador se memoiza (una sola carga)", async () => {
  let imports = 0;
  const importAuth = async () => { imports++; return { loadAuth: async () => ({ restore: async () => ({ id: "u1" }) }) }; };
  const { queue } = setup({ importAuth });
  await queue.resolveAccount();
  await queue.resolveAccount();
  await queue.retry();
  assert.equal(imports, 1);
});
