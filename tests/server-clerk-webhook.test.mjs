import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { createApp } from "../server.mjs";
import {
  generateSvixHeaders,
  parseSigningSecret,
  verifySvixSignature,
} from "../server/clerk-webhook.mjs";

const TEST_SECRET = "whsec_MfKQ9r81RDuGnxq2Y5epA5dm4z1evNMo"; // 32 random bytes in base64 with whsec_

function request({ port, method = "POST", path = "/api/webhooks/clerk", headers = {}, body = "" }) {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    const reqHeaders = {
      "Content-Type": "application/json",
      "Content-Length": String(bodyBuf.length),
      ...headers,
    };
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            // not json
          }
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw });
        });
      },
    );
    req.on("error", reject);
    req.end(bodyBuf);
  });
}

function createFakeStore() {
  const users = new Map();
  return {
    seed(userId, count = 1) {
      users.set(userId, count);
    },
    async deleteAll(userId) {
      const count = users.get(userId) ?? 0;
      users.delete(userId);
      return count;
    },
    getUserCount(userId) {
      return users.get(userId) ?? 0;
    },
  };
}

async function withApp(options, fn) {
  const app = createApp(options);
  const server = app.listen(0);
  await once(server, "listening");
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ---------------------------------------------------------------------------
// Unit tests: parseSigningSecret y verifySvixSignature
// ---------------------------------------------------------------------------

test("parseSigningSecret: decodifica secretos con o sin prefijo whsec_", () => {
  const rawBase64 = Buffer.from("testsecret1234567890123456789012").toString("base64");
  const withPrefix = `whsec_${rawBase64}`;
  assert.deepEqual(parseSigningSecret(withPrefix), Buffer.from(rawBase64, "base64"));
  assert.deepEqual(parseSigningSecret(rawBase64), Buffer.from(rawBase64, "base64"));
  assert.throws(() => parseSigningSecret(""), /SECRET_REQUIRED/);
});

test("parseSigningSecret: tolera espacios y saltos de línea alrededor del secreto", () => {
  const rawBase64 = Buffer.from("testsecret1234567890123456789012").toString("base64");
  const withWhitespace = `  \n whsec_${rawBase64} \t `;
  assert.deepEqual(parseSigningSecret(withWhitespace), Buffer.from(rawBase64, "base64"));
});

test("verifySvixSignature: rechaza svix-timestamp no numérico o con sufijos", () => {
  const payload = "{}";
  const headers = generateSvixHeaders({ payload, secret: TEST_SECRET });
  headers["svix-timestamp"] = "1728900000abc";
  const res = verifySvixSignature({ payload, headers, secret: TEST_SECRET });
  assert.equal(res.valid, false);
  assert.equal(res.reason, "INVALID_TIMESTAMP");
});

test("verifySvixSignature: valida una firma correcta con prefijo whsec_", () => {
  const payload = JSON.stringify({ type: "user.deleted", data: { id: "user_test123" } });
  const headers = generateSvixHeaders({ payload, secret: TEST_SECRET });
  const res = verifySvixSignature({ payload, headers, secret: TEST_SECRET });
  assert.equal(res.valid, true);
});

test("verifySvixSignature: acepta múltiples firmas en svix-signature si al menos una coincide", () => {
  const payload = JSON.stringify({ type: "ping" });
  const validHeaders = generateSvixHeaders({ payload, secret: TEST_SECRET });
  const multiHeaders = {
    ...validHeaders,
    "svix-signature": `v1,bogusSignature== ${validHeaders["svix-signature"]} v2,ignoreThis`,
  };
  const res = verifySvixSignature({ payload, headers: multiHeaders, secret: TEST_SECRET });
  assert.equal(res.valid, true);
});

test("verifySvixSignature: falla si faltan cabeceras requeridas", () => {
  const payload = "{}";
  const res1 = verifySvixSignature({ payload, headers: {}, secret: TEST_SECRET });
  assert.equal(res1.valid, false);
  assert.equal(res1.reason, "MISSING_HEADERS");

  const headers = generateSvixHeaders({ payload, secret: TEST_SECRET });
  delete headers["svix-id"];
  const res2 = verifySvixSignature({ payload, headers, secret: TEST_SECRET });
  assert.equal(res2.valid, false);
  assert.equal(res2.reason, "MISSING_HEADERS");
});

test("verifySvixSignature: falla si el timestamp excede la tolerancia", () => {
  const payload = "{}";
  const now = 1000000000;
  // 301 segundos en el pasado
  const headers = generateSvixHeaders({
    payload,
    secret: TEST_SECRET,
    timestamp: Math.floor(now / 1000) - 301,
  });
  const res = verifySvixSignature({
    payload,
    headers,
    secret: TEST_SECRET,
    now: () => now,
    toleranceSeconds: 300,
  });
  assert.equal(res.valid, false);
  assert.equal(res.reason, "TIMESTAMP_OUT_OF_RANGE");
});

test("verifySvixSignature: falla si el secreto no coincide", () => {
  const payload = "{}";
  const otherSecret = "whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const headers = generateSvixHeaders({ payload, secret: otherSecret });
  const res = verifySvixSignature({ payload, headers, secret: TEST_SECRET });
  assert.equal(res.valid, false);
  assert.equal(res.reason, "SIGNATURE_MISMATCH");
});

test("verifySvixSignature: falla si el cuerpo fue alterado", () => {
  const original = JSON.stringify({ a: 1 });
  const headers = generateSvixHeaders({ payload: original, secret: TEST_SECRET });
  const tampered = JSON.stringify({ a: 2 });
  const res = verifySvixSignature({ payload: tampered, headers, secret: TEST_SECRET });
  assert.equal(res.valid, false);
  assert.equal(res.reason, "SIGNATURE_MISMATCH");
});

// ---------------------------------------------------------------------------
// Integration tests: POST /api/webhooks/clerk
// ---------------------------------------------------------------------------

test("POST /api/webhooks/clerk: user.deleted borra las sesiones del usuario de forma idempotente", async () => {
  const store = createFakeStore();
  store.seed("user_2NNEq95Xl5V8k78y91Z3abcdef", 4);

  await withApp({ store, webhookSecret: TEST_SECRET }, async (port) => {
    const payload = JSON.stringify({
      data: { id: "user_2NNEq95Xl5V8k78y91Z3abcdef", object: "user" },
      object: "event",
      type: "user.deleted",
    });
    const headers = generateSvixHeaders({ payload, secret: TEST_SECRET });

    // Primer borrado: 4 sesiones eliminadas
    const res1 = await request({ port, headers, body: payload });
    assert.equal(res1.status, 200);
    assert.equal(res1.headers["cache-control"], "no-store");
    assert.deepEqual(res1.body, { received: true, deleted: 4 });
    assert.equal(store.getUserCount("user_2NNEq95Xl5V8k78y91Z3abcdef"), 0);

    // Segundo borrado (reintento de Clerk): 0 sesiones, 200 OK (idempotente)
    const res2 = await request({ port, headers, body: payload });
    assert.equal(res2.status, 200);
    assert.deepEqual(res2.body, { received: true, deleted: 0 });
  });
});

test("POST /api/webhooks/clerk: eventos distintos a user.deleted se ignoran con 200 OK", async () => {
  const store = createFakeStore();
  store.seed("user_target", 3);

  await withApp({ store, webhookSecret: TEST_SECRET }, async (port) => {
    const payload = JSON.stringify({
      data: { id: "user_target" },
      type: "user.created",
    });
    const headers = generateSvixHeaders({ payload, secret: TEST_SECRET });

    const res = await request({ port, headers, body: payload });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { received: true, ignored: true });
    // No borró las sesiones
    assert.equal(store.getUserCount("user_target"), 3);
  });
});

test("POST /api/webhooks/clerk: rechaza firma inválida con 400", async () => {
  const store = createFakeStore();
  await withApp({ store, webhookSecret: TEST_SECRET }, async (port) => {
    const payload = JSON.stringify({ type: "user.deleted", data: { id: "user_fake" } });
    const headers = {
      "svix-id": "msg_test",
      "svix-timestamp": String(Math.floor(Date.now() / 1000)),
      "svix-signature": "v1,invalidBase64Signature==",
    };
    const res = await request({ port, headers, body: payload });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "INVALID_SIGNATURE");
  });
});

test("POST /api/webhooks/clerk: rechaza payload con user_id mal formado con 400", async () => {
  const store = createFakeStore();
  await withApp({ store, webhookSecret: TEST_SECRET }, async (port) => {
    const payload = JSON.stringify({
      data: { id: "not_a_valid_clerk_user_id" },
      type: "user.deleted",
    });
    const headers = generateSvixHeaders({ payload, secret: TEST_SECRET });

    const res = await request({ port, headers, body: payload });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "INVALID_USER_ID");
  });
});

test("POST /api/webhooks/clerk: responde 503 si CLERK_WEBHOOK_SIGNING_SECRET no está configurado", async () => {
  const store = createFakeStore();
  // webhookSecret: undefined
  await withApp({ store, webhookSecret: undefined }, async (port) => {
    const payload = JSON.stringify({ type: "user.deleted", data: { id: "user_abc" } });
    const headers = generateSvixHeaders({ payload, secret: TEST_SECRET });

    const res = await request({ port, headers, body: payload });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, "WEBHOOK_UNCONFIGURED");
  });
});

test("POST /api/webhooks/clerk: responde 503 si el store lanza error al borrar", async () => {
  const errorStore = {
    async deleteAll() {
      const err = new Error("connection to server was lost");
      err.code = "ECONNREFUSED";
      throw err;
    },
  };

  await withApp({ store: errorStore, webhookSecret: TEST_SECRET }, async (port) => {
    const payload = JSON.stringify({
      data: { id: "user_valid12345678" },
      type: "user.deleted",
    });
    const headers = generateSvixHeaders({ payload, secret: TEST_SECRET });

    const res = await request({ port, headers, body: payload });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, "STATS_UNAVAILABLE");
  });
});

test("POST /api/webhooks/clerk: aplica rate limit por IP (120 req/min)", async () => {
  const store = createFakeStore();
  await withApp({ store, webhookSecret: TEST_SECRET }, async (port) => {
    const payload = JSON.stringify({ type: "user.created" });
    const headers = generateSvixHeaders({ payload, secret: TEST_SECRET });

    // Hacemos peticiones rápidas superando el límite
    // Para no hacer 121 peticiones secuenciales lentas, lanzamos en paralelo
    const requests = Array.from({ length: 125 }, () => request({ port, headers, body: payload }));
    const responses = await Promise.all(requests);

    const okCount = responses.filter((r) => r.status === 200).length;
    const rateLimited = responses.filter((r) => r.status === 429);

    assert.equal(okCount, 120);
    assert.equal(rateLimited.length, 5);
    assert.ok(rateLimited[0].headers["retry-after"]);
    assert.equal(rateLimited[0].body.error, "RATE_LIMITED");
  });
});

test("POST /api/webhooks/clerk: rechaza payload con JSON sintácticamente inválido pero con firma correcta con 400", async () => {
  const store = createFakeStore();
  await withApp({ store, webhookSecret: TEST_SECRET }, async (port) => {
    const payload = "{ not a valid json";
    const headers = generateSvixHeaders({ payload, secret: TEST_SECRET });

    const res = await request({ port, headers, body: payload });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "INVALID_JSON");
  });
});

test("POST /api/webhooks/clerk: rechaza array como payload raíz con 400", async () => {
  const store = createFakeStore();
  await withApp({ store, webhookSecret: TEST_SECRET }, async (port) => {
    const payload = JSON.stringify([{ type: "user.deleted" }]);
    const headers = generateSvixHeaders({ payload, secret: TEST_SECRET });

    const res = await request({ port, headers, body: payload });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "INVALID_PAYLOAD");
  });
});

test("POST /api/webhooks/clerk: rechaza payloads superiores al límite de 32kb con 413", async () => {
  const store = createFakeStore();
  await withApp({ store, webhookSecret: TEST_SECRET }, async (port) => {
    const bigPayload = JSON.stringify({ type: "ping", padding: "x".repeat(33 * 1024) });
    const headers = generateSvixHeaders({ payload: bigPayload, secret: TEST_SECRET });

    const res = await request({ port, headers, body: bigPayload });
    assert.equal(res.status, 413);
  });
});
