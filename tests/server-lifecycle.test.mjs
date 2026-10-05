import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";

process.env.CLERK_TELEMETRY_DISABLED ??= "1";

const { createApp, createGracefulShutdown } = await import("../server.mjs");

async function withApp(run) {
  const server = createApp({ store: {} }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }
}

const get = (port, path, method = "GET") =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });

test("GET /healthz: 200 {ok:true}, sin caché y sin sesión", async () => {
  await withApp(async (port) => {
    const res = await get(port, "/healthz");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal((await get(port, "/healthz", "HEAD")).status, 200);
  });
});

test("una ruta /api/* desconocida responde 404 JSON", async () => {
  await withApp(async (port) => {
    const res = await get(port, "/api/no-existe");
    assert.equal(res.status, 404);
    assert.match(res.headers["content-type"], /application\/json/);
    assert.deepEqual(JSON.parse(res.body), { error: "not_found" });
    // Lo que no es API sigue igual.
    assert.equal((await get(port, "/no-existe")).status, 404);
  });
});

function fakeProc() {
  const handlers = new Map();
  return {
    exits: [],
    on(signal, fn) { handlers.set(signal, fn); },
    emit(signal) { handlers.get(signal)?.(); },
    exit(code) { this.exits.push(code); },
    handlers,
  };
}
const quietLog = { log() {}, error() {} };

test("cierre ordenado: server.close, conexiones inactivas, recursos y exit(0), en ese orden", async () => {
  const order = [];
  const server = {
    close(cb) { order.push("close"); setImmediate(() => { order.push("closed"); cb(); }); },
    closeIdleConnections() { order.push("idle"); },
  };
  const proc = fakeProc();
  const { shutdown } = createGracefulShutdown({
    server, proc, log: quietLog,
    closeResources: async () => { order.push("pool"); },
  });
  await shutdown("SIGTERM");
  assert.deepEqual(order, ["close", "idle", "closed", "pool"]);
  assert.deepEqual(proc.exits, [0]);
});

test("cierre ordenado: es idempotente y install() engancha SIGTERM y SIGINT", async () => {
  let closes = 0;
  const server = { close(cb) { closes++; cb(); } };
  const proc = fakeProc();
  const graceful = createGracefulShutdown({ server, proc, log: quietLog });
  graceful.install();
  assert.deepEqual([...proc.handlers.keys()].sort(), ["SIGBREAK", "SIGINT", "SIGTERM"]);
  proc.emit("SIGINT");
  await graceful.shutdown();
  await graceful.shutdown();
  assert.equal(closes, 1);
  assert.deepEqual(proc.exits, [0]);
});

test("cierre ordenado: si cerrar el pool falla, sale con código 1", async () => {
  const server = { close(cb) { cb(); } };
  const proc = fakeProc();
  await createGracefulShutdown({
    server, proc, log: quietLog,
    closeResources: async () => { throw new Error("boom"); },
  }).shutdown();
  assert.deepEqual(proc.exits, [1]);
});

test("cierre ordenado: si una petición no termina, el temporizador fuerza exit(1)", async () => {
  const server = { close() { /* nunca llama al callback: petición colgada */ } };
  const proc = fakeProc();
  createGracefulShutdown({ server, proc, log: quietLog, timeoutMs: 20 }).shutdown();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(proc.exits, [1]);
});

test("cierre ordenado con un servidor real: espera la petición en vuelo", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const server = http.createServer(async (_req, res) => { await gate; res.end("hecho"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const inflight = get(port, "/");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const proc = fakeProc();
  const done = createGracefulShutdown({ server, proc, log: quietLog }).shutdown();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(proc.exits, [], "no sale mientras haya una petición en vuelo");
  release();
  assert.equal((await inflight).body, "hecho");
  await done;
  assert.deepEqual(proc.exits, [0]);
});

test("cierre ordenado: una segunda señal durante el cierre fuerza exit(1) al instante", async () => {
  const server = { close() { /* petición colgada */ } };
  const proc = fakeProc();
  createGracefulShutdown({ server, proc, log: quietLog, timeoutMs: 5000 }).install();
  proc.emit("SIGINT");
  assert.deepEqual(proc.exits, []);
  proc.emit("SIGINT");
  assert.deepEqual(proc.exits, [1]);
});

test("cierre ordenado con clientes keep-alive: sale con 0 y cierra recursos antes del timeout", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const server = http.createServer(async (req, res) => {
    if (req.url === "/slow") await gate;
    res.end("ok");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  const call = (path) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, agent }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.headers));
    }).on("error", reject);
  });
  await call("/fast"); // deja un socket keep-alive inactivo
  const slow = call("/slow");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const proc = fakeProc();
  let resourcesClosed = false;
  const done = createGracefulShutdown({
    server, proc, log: quietLog, timeoutMs: 3000,
    closeResources: async () => { resourcesClosed = true; },
  }).shutdown();
  await new Promise((resolve) => setTimeout(resolve, 30));
  release();
  await slow;
  await done;
  agent.destroy();
  assert.equal(resourcesClosed, true);
  assert.deepEqual(proc.exits, [0]);
});

test("cierre ordenado: las respuestas posteriores al inicio del cierre llevan Connection: close", async () => {
  let listener;
  const server = {
    prependListener(event, fn) { if (event === "request") listener = fn; },
    close(cb) { cb(); },
  };
  const proc = fakeProc();
  await createGracefulShutdown({ server, proc, log: quietLog }).shutdown();
  const set = {};
  listener({}, { headersSent: false, setHeader: (k, v) => { set[k] = v; } });
  assert.deepEqual(set, { Connection: "close" });
});
