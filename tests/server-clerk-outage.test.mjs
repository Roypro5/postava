import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { APP_SESSION_COOKIE, createPresenceValue } from "../server/session-cookie.mjs";

/* ── Una caída de Clerk no debe cerrar la sesión de nadie ─────────────────────────
   auth-adapter.js llama a clerk.signOut() ante cada 401 de /api/auth/session. Si el servidor respondiera 401
   cuando NO PUEDE comprobar la sesión (Clerk caído), toda persona con la página abierta quedaría desconectada.
   El SDK no lanza cuando no puede cargar las claves de firma (JWKS): devuelve la petición como "sin sesión", con
   un motivo en los datos de depuración del objeto de autenticación. server.mjs distingue ese motivo (503) de
   "no hay sesión" (401).

   Sin red: sin CLERK_JWT_KEY el SDK pide las claves a Clerk, y aquí esa petición la atiende un fetch falso que
   sirve (o no) la clave pública de un par RSA local. Ninguna cuenta real, ningún correo. Va en un archivo aparte
   porque el SDK fija CLERK_JWT_KEY al crear su cliente y este archivo necesita que no esté.                    */

process.env.CLERK_TELEMETRY_DISABLED ??= "1";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: "jwk" });
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const jwks = { mode: "ok", registeredKids: new Set(), requests: 0 };
const outbound = [];
globalThis.fetch = async (url) => {
  const target = String(url);
  outbound.push(target);
  if (!target.endsWith("/v1/jwks")) throw new TypeError(`llamada inesperada a Clerk en el test: ${target}`);
  jwks.requests++;
  switch (jwks.mode) {
    case "network-error":
      throw new TypeError("fetch failed: los tests no tienen red");
    case "empty":
      return jsonResponse({ keys: [] });
    case "other-key":
      return jsonResponse({ keys: [{ ...publicJwk, kid: "ins_de_otra_instancia", alg: "RS256", use: "sig" }] });
    default:
      return jsonResponse({ keys: [...jwks.registeredKids].map((kid) => ({ ...publicJwk, kid, alg: "RS256", use: "sig" })) });
  }
};

const VALID_PK = `pk_test_${Buffer.from("test.clerk.accounts.dev$").toString("base64").replace(/=+$/, "")}`;
const PRESENCE_SECRET = randomBytes(36).toString("base64url");
Object.assign(process.env, {
  CLERK_SECRET_KEY: "sk_test_00000000000000000000000000000000",
  CLERK_PUBLISHABLE_KEY: VALID_PK,
  CLERK_API_URL: "http://127.0.0.1:1",
  SESSION_SECRET: PRESENCE_SECRET,
});
delete process.env.CLERK_JWT_KEY;
delete process.env.CLERK_IS_SATELLITE;
delete process.env.VITE_CLERK_PROXY_URL;

const { createApp } = await import("../server.mjs");

const SUB = "user_2abcDEF1234567";
const SID = "sess_2abcDEF1234567";
const nowSeconds = () => Math.floor(Date.now() / 1000);
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Un usuario con sesión: su JWT (con un kid propio, para no compartir la caché de claves del SDK) y sus cookies. */
function signedInUser(port, kid) {
  jwks.registeredKids.add(kid);
  const iat = nowSeconds();
  const header = b64url({ alg: "RS256", typ: "JWT", kid });
  const payload = b64url({ sub: SUB, sid: SID, azp: `http://127.0.0.1:${port}`, iss: "https://test.clerk.accounts.dev", iat, nbf: iat, exp: iat + 300 });
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey).toString("base64url");
  return {
    cookie: [
      `__session=${header}.${payload}.${signature}`,
      `__client_uat=${iat - 60}`,
      "__clerk_db_jwt=dvb_test",
      `${APP_SESSION_COOKIE}=${createPresenceValue(SID, true, PRESENCE_SECRET)}`,
    ].join("; "),
  };
}

async function withApp(run) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  const store = { async getStats() { return { days: [], habitDistribution: [] }; }, async saveSession() { return true; } };
  const server = createApp({ store }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await run({ port: server.address().port, warnings: () => warnings.filter((line) => line.startsWith("[auth]")) });
  } finally {
    console.warn = originalWarn;
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }
}

function request(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const framed = body ? { ...headers, "content-length": String(Buffer.byteLength(body)) } : headers;
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: framed }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const sessionBody = () =>
  JSON.stringify({
    id: "4b2de3a2-e6c2-4f8b-9d01-217e26ec8766",
    expectedUserId: SUB,
    type: "focus",
    completed: true,
    durationMinutes: 25,
    startedAt: new Date().toISOString(),
    goodMs: 900_000,
    badMs: 300_000,
    issues: { neck: 2, shoulders: 1, tilt: 0, distance: 1 },
    issuesUnit: "count",
    alerts: 2,
  });

function assertUnavailable(res, label) {
  assert.equal(res.status, 503, label);
  assert.deepEqual(JSON.parse(res.body), { error: "AUTH_UNAVAILABLE" }, label);
  assert.match(res.headers["retry-after"] ?? "", /^[1-9]\d{0,3}$/, label);
}

test("si Clerk no puede darle las claves de firma al SDK, las rutas privadas dan 503 (no 401) y al volver Clerk la misma sesión vale", async () => {
  await withApp(async ({ port, warnings }) => {
    const user = signedInUser(port, "ins_test_lista_vacia");
    const origin = `http://127.0.0.1:${port}`;

    jwks.mode = "empty"; // Clerk responde, pero sin ninguna clave de firma
    const routes = [
      ["GET", "/api/auth/session"],
      ["GET", "/api/account"],
      ["GET", "/api/stats"],
      ["POST", "/api/stats/sessions"],
    ];
    for (const [method, path] of routes) {
      const res = await request(port, path, {
        method,
        headers: { ...user, origin, "content-type": "application/json" },
        body: method === "POST" ? sessionBody() : undefined,
      });
      assertUnavailable(res, `${method} ${path}`);
      assert.equal(res.headers["set-cookie"], undefined, `${method} ${path}`);
    }
    const page = await request(port, "/stats", { headers: user });
    assert.equal(page.status, 503);
    assert.equal(page.headers.location, undefined, "no se manda a iniciar sesión a quien ya la tiene");
    assert.equal(page.headers["cache-control"], "private, no-store");
    assert.match(page.body, /Servicio de cuentas no disponible/);

    // Lo público y el cierre de sesión local siguen funcionando durante la caída.
    assert.equal((await request(port, "/", { headers: user })).status, 200);
    const logout = await request(port, "/api/auth/session", { method: "DELETE", headers: { ...user, origin } });
    assert.equal(logout.status, 204);

    // El operador lo ve una vez (con el motivo y la pista de CLERK_JWT_KEY), sin cookies, JWT ni claves.
    assert.equal(warnings().length, 1, warnings().join("\n"));
    assert.match(warnings()[0], /could not be reached to verify a session/);
    assert.match(warnings()[0], /CLERK_JWT_KEY/);
    assert.match(warnings()[0], /503/);
    assert.doesNotMatch(warnings()[0], /__session|eyJ|sk_test|pk_test|127\.0\.0\.1/);

    // Clerk vuelve: las mismas cookies dan acceso. Con un 401 el navegador habría cerrado la sesión de Clerk por el camino.
    jwks.mode = "ok";
    const back = await request(port, "/api/account", { headers: user });
    assert.equal(back.status, 200);
    assert.deepEqual(JSON.parse(back.body), { userId: SUB });
    assert.equal((await request(port, "/api/stats", { headers: user })).status, 200);
  });
});

test("con Clerk inalcanzable (error de red) ocurre lo mismo", { timeout: 60_000 }, async () => {
  await withApp(async ({ port, warnings }) => {
    const user = signedInUser(port, "ins_test_sin_red");
    jwks.mode = "network-error";
    const before = jwks.requests;
    // Una sola petición: el SDK reintenta la descarga de claves con espera exponencial (varios segundos).
    const res = await request(port, "/api/auth/session", { headers: user });
    assertUnavailable(res, "GET /api/auth/session");
    assert.ok(jwks.requests > before, "el SDK sí intentó llegar a Clerk (a través del fetch falso)");
    assert.equal(warnings().length, 1, warnings().join("\n"));
    assert.match(warnings()[0], /could not be reached/);
  });
});

test("un JWT que Clerk no reconoce (kid desconocido, Clerk sano) sigue siendo un 401 normal: ahí sí no hay sesión", async () => {
  await withApp(async ({ port, warnings }) => {
    const user = signedInUser(port, "ins_test_desconocido");
    jwks.mode = "other-key"; // Clerk responde bien, pero con las claves de otra instancia
    const res = await request(port, "/api/auth/session", { headers: user });
    assert.equal(res.status, 401);
    assert.deepEqual(JSON.parse(res.body), { error: "SESSION_REQUIRED" });
    assert.equal(res.headers["retry-after"], undefined);
    const page = await request(port, "/stats", { headers: user });
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, "/sign-in?redirect=/stats");
    assert.deepEqual(warnings(), [], "no es una caída de Clerk: sin avisos");
  });
});

test("solo las peticiones con cookie de sesión pueden ser 'Clerk no ha podido verificar': un invitado no provoca avisos ni 503", async () => {
  await withApp(async ({ port, warnings }) => {
    jwks.mode = "empty";
    const before = jwks.requests;
    const res = await request(port, "/api/auth/session");
    assert.equal(res.status, 401);
    assert.deepEqual(JSON.parse(res.body), { error: "SESSION_REQUIRED" });
    assert.equal(jwks.requests, before, "sin cookie de sesión no hay nada que verificar y no se llama a Clerk");
    assert.deepEqual(warnings(), []);
    jwks.mode = "ok";
  });
});
