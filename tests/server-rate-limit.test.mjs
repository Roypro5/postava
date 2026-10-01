import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { createApp } from "../server.mjs";

// El SDK de Clerk envía telemetría a sus servidores con claves pk_test: en tests no debe salir nada a la red.
process.env.CLERK_TELEMETRY_DISABLED ??= "1";
// Claves inertes de prueba: ninguna instancia real de Clerk se contacta desde estos tests.
process.env.CLERK_SECRET_KEY ??= "sk_test_00000000000000000000000000000000";
process.env.CLERK_PUBLISHABLE_KEY ??= `pk_test_${Buffer.from("test.clerk.accounts.dev$")
  .toString("base64")
  .replace(/=+$/, "")}`;

const LIMIT = 60;

/** `trustProxyHops` se lee al crear la app: se fija TRUST_PROXY_HOPS solo durante createApp(). */
async function startServer({ hops }) {
  const original = process.env.TRUST_PROXY_HOPS;
  process.env.TRUST_PROXY_HOPS = String(hops);
  let app;
  try {
    app = createApp();
  } finally {
    if (original === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = original;
  }
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    }),
  };
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, headers }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      })
      .on("error", reject);
  });
}

async function withServer(options, run) {
  const { port, close } = await startServer(options);
  try {
    await run(port);
  } finally {
    await close();
  }
}

/** Pide `path` hasta obtener 429 (máximo `limit + 5` intentos) y devuelve cuántas se aceptaron antes. */
async function callUntilLimited(port, path, headersFor = () => ({}), limit = LIMIT) {
  let accepted = 0;
  for (let i = 0; i < limit + 5; i++) {
    const res = await get(port, path, headersFor(i));
    if (res.status === 429) return { accepted, limited: res };
    // Sin cuenta ni cookie de presencia, estas rutas privadas contestan 401 y nunca llegan a 429 sin límite.
    assert.equal(res.status, 401, `${path} intento ${i}`);
    accepted += 1;
  }
  return { accepted, limited: null };
}

for (const path of ["/api/auth/session", "/api/account", "/api/stats"]) {
  test(`GET ${path} tiene límite por llamador: ${LIMIT} por minuto y luego 429 con Retry-After`, async () => {
    await withServer({ hops: 1 }, async (port) => {
      const { accepted, limited } = await callUntilLimited(port, path, () => ({ "x-forwarded-for": "198.51.100.1" }));
      assert.equal(accepted, LIMIT);
      assert.ok(limited, `se esperaba un 429 en ${path}`);
      assert.match(limited.headers["retry-after"], /^\d+$/);
      assert.ok(Number(limited.headers["retry-after"]) >= 1);
      assert.deepEqual(JSON.parse(limited.body), { error: "RATE_LIMITED" });
      assert.equal(limited.headers["cache-control"], "no-store");
    });
  });
}

test("con trust proxy, cada IP real tiene su propio cupo: agotar el de una no bloquea a las demás", async () => {
  await withServer({ hops: 1 }, async (port) => {
    const noisy = await callUntilLimited(port, "/api/stats", () => ({ "x-forwarded-for": "198.51.100.1" }));
    assert.ok(noisy.limited);

    // Otro cliente detrás del mismo proxy (mismo socket 127.0.0.1) sigue pasando, en todas las rutas.
    for (const path of ["/api/stats", "/api/account", "/api/auth/session"]) {
      const res = await get(port, path, { "x-forwarded-for": "198.51.100.2" });
      assert.equal(res.status, 401, path);
    }
    // Y sin X-Forwarded-For (petición directa al servidor) tampoco comparte cubo con la IP ruidosa.
    assert.equal((await get(port, "/api/stats")).status, 401);
  });
});

test("con trust proxy, escribir X-Forwarded-For no permite escoger cubo: manda la IP que añadió el proxy", async () => {
  await withServer({ hops: 1 }, async (port) => {
    // Cada petición inventa una IP distinta a la izquierda; el proxy de confianza añade siempre la real a la derecha.
    const { accepted, limited } = await callUntilLimited(
      port,
      "/api/account",
      (i) => ({ "x-forwarded-for": `10.0.0.${i}, 203.0.113.77` }),
    );
    assert.equal(accepted, LIMIT);
    assert.ok(limited, "falsear el X-Forwarded-For no debe evitar el límite");
  });
});

test("sin saltos de confianza (TRUST_PROXY_HOPS=0) X-Forwarded-For se ignora por completo", async () => {
  await withServer({ hops: 0 }, async (port) => {
    const { accepted, limited } = await callUntilLimited(
      port,
      "/api/auth/session",
      (i) => ({ "x-forwarded-for": `10.0.0.${i}` }),
    );
    assert.equal(accepted, LIMIT);
    assert.ok(limited, "con hops=0 todas las peticiones cuentan contra la IP del socket");
  });
});

test("los cupos de lectura son independientes entre sí y de las rutas estáticas", async () => {
  await withServer({ hops: 1 }, async (port) => {
    const headers = { "x-forwarded-for": "198.51.100.9" };
    assert.ok((await callUntilLimited(port, "/api/stats", () => headers)).limited);

    // /api/stats agotado no toca el cupo de sesión.
    assert.equal((await get(port, "/api/auth/session", headers)).status, 401);
    // Las rutas de sesión comparten cupo entre sí (el cliente pregunta una vez por carga de página).
    const session = await callUntilLimited(port, "/api/auth/session", () => headers, LIMIT - 1);
    assert.equal(session.accepted, LIMIT - 1);
    assert.equal((await get(port, "/api/account", headers)).status, 429);

    // Los estáticos no llevan límite: muy por encima de 60 peticiones desde la misma IP.
    for (let i = 0; i < LIMIT + 20; i++) {
      const res = await get(port, "/theme.js", headers);
      assert.equal(res.status, 200, `estático intento ${i}`);
    }
  });
});
