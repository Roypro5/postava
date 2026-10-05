import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import express from "express";
import { CLERK_PROXY_PATH, clerkProxyMiddleware } from "../server/middlewares/clerkProxyMiddleware.mjs";

// El "Clerk" es un servidor local; la clave es un valor inerte de prueba.
const SECRET = "sk_test_proxy_limits_are_captured_locally";

async function withProxy(upstreamHandler, options, run) {
  const upstream = http.createServer(upstreamHandler);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const app = express();
  app.use(
    CLERK_PROXY_PATH,
    clerkProxyMiddleware({
      isProduction: true,
      secretKey: SECRET,
      target: `http://127.0.0.1:${upstream.address().port}`,
      ...options,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(server.address().port);
  } finally {
    for (const s of [server, upstream]) {
      s.closeAllConnections?.();
      await new Promise((resolve) => s.close(resolve));
    }
  }
}

const get = (port, path) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        res.on("error", reject);
      })
      .on("error", reject);
  });

test("proxy de Clerk: un upstream que no responde da 504 JSON", async () => {
  await withProxy(() => { /* nunca responde */ }, { upstreamTimeoutMs: 100 }, async (port) => {
    const res = await get(port, `${CLERK_PROXY_PATH}/v1/client`);
    assert.equal(res.status, 504);
    assert.match(res.headers["content-type"], /application\/json/);
    assert.deepEqual(JSON.parse(res.body), { error: "UPSTREAM_TIMEOUT" });
  });
});

test("proxy de Clerk: un upstream que se queda a mitad de la respuesta da 504 JSON", async () => {
  const handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }); // chunked, sin content-length
    res.write('{"a":');
  };
  await withProxy(handler, { upstreamTimeoutMs: 100 }, async (port) => {
    const res = await get(port, `${CLERK_PROXY_PATH}/v1/client`);
    assert.equal(res.status, 504);
    assert.deepEqual(JSON.parse(res.body), { error: "UPSTREAM_TIMEOUT" });
  });
});

test("proxy de Clerk: una respuesta sin content-length por encima del tope da 502 JSON", async () => {
  const handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("x".repeat(600));
    res.end("y".repeat(600));
  };
  await withProxy(handler, { maxBufferedBytes: 1000 }, async (port) => {
    const res = await get(port, `${CLERK_PROXY_PATH}/v1/client`);
    assert.equal(res.status, 502);
    assert.deepEqual(JSON.parse(res.body), { error: "UPSTREAM_TOO_LARGE" });
  });
});

test("proxy de Clerk: por debajo del tope y del tiempo, la respuesta pasa intacta", async () => {
  const handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"ok":');
    res.end("true}");
  };
  await withProxy(handler, { maxBufferedBytes: 1000, upstreamTimeoutMs: 1000 }, async (port) => {
    const res = await get(port, `${CLERK_PROXY_PATH}/v1/client`);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
  });
});

test("proxy de Clerk: un upstream caído da 502 JSON", async () => {
  await withProxy(() => {}, { target: "http://127.0.0.1:1" }, async (port) => {
    const res = await get(port, `${CLERK_PROXY_PATH}/v1/client`);
    assert.equal(res.status, 502);
    assert.deepEqual(JSON.parse(res.body), { error: "UPSTREAM_ERROR" });
  });
});

test("proxy de Clerk: una respuesta 200 con keep-alive no genera error pasado el timeout", async () => {
  const handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"ok":');
    res.end("true}");
  };
  await withProxy(handler, { upstreamTimeoutMs: 100 }, async (port) => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const once1 = () => new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: `${CLERK_PROXY_PATH}/v1/client`, agent }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }).on("error", reject);
    });
    assert.equal((await once1()).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = await once1();
    assert.equal(second.status, 200);
    assert.deepEqual(JSON.parse(second.body), { ok: true });
    agent.destroy();
  });
});

test("proxy de Clerk: un cuerpo con content-length mayor que el tope pasa intacto (streaming)", async () => {
  const payload = "z".repeat(5000);
  const handler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "content-length": String(payload.length) });
    res.end(payload);
  };
  await withProxy(handler, { maxBufferedBytes: 1000 }, async (port) => {
    const res = await get(port, `${CLERK_PROXY_PATH}/v1/client`);
    assert.equal(res.status, 200);
    assert.equal(res.body, payload);
  });
});
