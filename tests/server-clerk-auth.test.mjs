import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { APP_SESSION_COOKIE, createPresenceValue } from "../server/session-cookie.mjs";

/* ── Control positivo de la autenticación, sin red y sin cuentas reales ─────────
   Los demás tests del servidor prueban que SIN sesión se niega el acceso; eso no demuestra que CON sesión se
   conceda (un servidor que negara siempre también lo pasaría). Aquí sí hay una sesión válida:

   - Se genera un par RSA local. La clave pública se entrega al SDK como CLERK_JWT_KEY, con lo que verifica los
     JWT de sesión sin pedir claves a Clerk, y el JWT de sesión se firma aquí con la clave privada.
   - Ninguna llamada sale del proceso: fetch se sustituye ANTES de cargar el servidor (el SDK guarda el fetch
     global al importarse) y solo apunta al registro; CLERK_API_URL va a un puerto cerrado de loopback por si
     algún día el SDK dejase de usarlo. Las claves de Clerk son marcadores inertes; no existe ninguna cuenta.
   - El almacén de estadísticas es un doble en memoria: no hay base de datos.                                  */

process.env.CLERK_TELEMETRY_DISABLED ??= "1";

const outbound = [];
globalThis.fetch = async (url) => {
  outbound.push(String(url));
  throw new TypeError("fetch failed: los tests no tienen red");
};

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const VALID_PK = `pk_test_${Buffer.from("test.clerk.accounts.dev$").toString("base64").replace(/=+$/, "")}`;
const SECRET = "sk_test_00000000000000000000000000000000";
const PRESENCE_SECRET = randomBytes(36).toString("base64url");
Object.assign(process.env, {
  CLERK_SECRET_KEY: SECRET,
  CLERK_PUBLISHABLE_KEY: VALID_PK,
  CLERK_JWT_KEY: publicKey.export({ type: "spki", format: "pem" }),
  CLERK_API_URL: "http://127.0.0.1:1",
  SESSION_SECRET: PRESENCE_SECRET,
});
delete process.env.CLERK_IS_SATELLITE;
delete process.env.VITE_CLERK_PROXY_URL;

const { createApp } = await import("../server.mjs");

const SUB = "user_2abcDEF1234567";
const SID = "sess_2abcDEF1234567";
const KID = "ins_test_local";
const nowSeconds = () => Math.floor(Date.now() / 1000);
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** JWT de sesión con la forma que Clerk emite (RS256, kid, sub, sid, azp, iss, iat/nbf/exp). */
function sessionJwt(port, { sub = SUB, sid = SID, key = privateKey, iat = nowSeconds(), nbf = iat, exp = iat + 300 } = {}) {
  const header = b64url({ alg: "RS256", typ: "JWT", kid: KID });
  const payload = b64url({ sub, sid, azp: `http://127.0.0.1:${port}`, iss: "https://test.clerk.accounts.dev", iat, nbf, exp });
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(key).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/** Las cookies que enviaría el navegador: las de Clerk (instancia de desarrollo) y, si se pide, la de presencia. */
function cookies(
  port,
  { jwt = sessionJwt(port), presence = createPresenceValue(SID, true, PRESENCE_SECRET), clientUat = nowSeconds() - 60 } = {},
) {
  const parts = [`__session=${jwt}`, `__client_uat=${clientUat}`, "__clerk_db_jwt=dvb_test"];
  if (presence) parts.push(`${APP_SESSION_COOKIE}=${presence}`);
  return parts.join("; ");
}

function fakeStore() {
  const calls = [];
  return {
    calls,
    async getStats(userId, period) {
      calls.push(["getStats", userId, period]);
      return { days: [], habitDistribution: [] };
    },
    async saveSession(userId, session) {
      calls.push(["saveSession", userId, session.id]);
      return true;
    },
  };
}

async function withApp(run) {
  const store = fakeStore();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  const server = createApp({ store }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await run({ port: server.address().port, store, warnings });
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

const sessionPayload = (overrides = {}) => ({
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
  ...overrides,
});

const PRIVATE_API = [
  ["GET", "/api/auth/session"],
  ["GET", "/api/account"],
  ["GET", "/api/stats"],
  ["GET", "/api/stats?days=30"],
  ["POST", "/api/stats/sessions"],
];

function privateRequest(port, [method, path], headers) {
  const same = { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", ...headers };
  return request(port, path, {
    method,
    headers: same,
    body: method === "POST" ? JSON.stringify(sessionPayload()) : undefined,
  });
}

test("control positivo: con Clerk bien configurado, un JWT de sesión válido y la cookie de presencia firmada se concede el acceso", async () => {
  await withApp(async ({ port, store, warnings }) => {
    const headers = { cookie: cookies(port) };

    const session = await request(port, "/api/auth/session", { headers });
    assert.equal(session.status, 200);
    assert.deepEqual(JSON.parse(session.body), { userId: SUB, sessionId: SID, remember: true });

    const account = await request(port, "/api/account", { headers });
    assert.equal(account.status, 200);
    assert.deepEqual(JSON.parse(account.body), { userId: SUB });

    const week = await request(port, "/api/stats", { headers });
    assert.equal(week.status, 200);
    assert.deepEqual(JSON.parse(week.body), { days: [], habitDistribution: [] });
    assert.equal((await request(port, "/api/stats?days=30", { headers })).status, 200);

    const save = await request(port, "/api/stats/sessions", {
      method: "POST",
      headers: { ...headers, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
      body: JSON.stringify(sessionPayload()),
    });
    assert.equal(save.status, 201);

    // Regla 3: el usuario sale del JWT verificado por el servidor, en las lecturas y en la escritura.
    assert.deepEqual(store.calls, [
      ["getStats", SUB, 7],
      ["getStats", SUB, 30],
      ["saveSession", SUB, "4b2de3a2-e6c2-4f8b-9d01-217e26ec8766"],
    ]);

    const page = await request(port, "/stats", { headers });
    assert.equal(page.status, 200);
    assert.equal(page.body, readFileSync(new URL("../stats.html", import.meta.url), "utf8"));
    assert.equal(page.headers["cache-control"], "private, no-store");

    assert.deepEqual(warnings.filter((line) => line.startsWith("[auth]")), []);
    assert.deepEqual(outbound, [], "ninguna llamada a Clerk: la verificación es local");
  });
});

// Clerk solo corre en las rutas privadas (ver server-public-routes.test.mjs); aquí se comprueba que, con las
// cabeceras que manda un navegador de verdad, quien sí tiene sesión sigue entrando donde debe.
test("control positivo con cabeceras de navegador: la sesión válida abre /stats (navegación) y la API (fetch)", async () => {
  await withApp(async ({ port, store }) => {
    outbound.length = 0;
    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
    const navigation = {
      cookie: cookies(port),
      "user-agent": userAgent,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
    };
    const page = await request(port, "/stats", { headers: navigation });
    assert.equal(page.status, 200);
    assert.equal(page.body, readFileSync(new URL("../stats.html", import.meta.url), "utf8"));
    assert.equal(page.headers["cache-control"], "private, no-store");

    const fetchHeaders = {
      cookie: cookies(port),
      "user-agent": userAgent,
      accept: "application/json",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    };
    for (const path of ["/api/auth/session", "/api/account", "/api/stats"]) {
      assert.equal((await request(port, path, { headers: fetchHeaders })).status, 200, path);
    }
    // Y el cierre local de sesión no lleva Clerk, tampoco con sesión.
    const logout = await request(port, "/api/auth/session", {
      method: "DELETE",
      headers: { ...navigation, origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(logout.status, 204);
    assert.equal(logout.headers["x-clerk-auth-status"], undefined);
    assert.deepEqual(store.calls, [["getStats", SUB, 7]]);
    assert.deepEqual(outbound, [], "la verificación es local: ninguna llamada a Clerk");
  });
});

test("el usuario nunca viene del body: un userId en la petición se rechaza y otro expectedUserId da 409", async () => {
  await withApp(async ({ port, store }) => {
    const headers = { cookie: cookies(port), origin: `http://127.0.0.1:${port}`, "content-type": "application/json" };
    const post = (payload) => request(port, "/api/stats/sessions", { method: "POST", headers, body: JSON.stringify(payload) });

    assert.equal((await post({ ...sessionPayload(), userId: "user_otraCuenta123" })).status, 400);
    assert.equal((await post({ ...sessionPayload(), user_id: "user_otraCuenta123" })).status, 400);
    const other = await post(sessionPayload({ expectedUserId: "user_otraCuenta123" }));
    assert.equal(other.status, 409);
    assert.deepEqual(JSON.parse(other.body), { error: "ACCOUNT_CHANGED" });
    assert.deepEqual(store.calls, [], "ninguna de las tres llegó al almacén");
  });
});

test("el alta de la cookie de presencia sale del JWT verificado: POST /api/auth/session y luego las rutas privadas", async () => {
  await withApp(async ({ port }) => {
    const jwt = sessionJwt(port);
    const set = await request(port, "/api/auth/session", {
      method: "POST",
      headers: { cookie: cookies(port, { jwt, presence: null }), origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
      body: JSON.stringify({ remember: false }),
    });
    assert.equal(set.status, 204);
    const cookie = String(set.headers["set-cookie"]).split(";")[0];
    assert.ok(cookie.startsWith(`${APP_SESSION_COOKIE}=`));

    const account = await request(port, "/api/account", {
      headers: { cookie: `__session=${jwt}; __client_uat=${nowSeconds() - 60}; __clerk_db_jwt=dvb_test; ${cookie}` },
    });
    assert.equal(account.status, 200);
    assert.deepEqual(JSON.parse(account.body), { userId: SUB });
  });
});

/** Regla 4: hacen falta las dos cosas. Cada caso tiene algo válido y algo que falla. */
test("con un JWT válido pero SIN cookie de presencia (o con una que no vale) no se accede a nada privado", async () => {
  const validJwtCases = [
    ["sin cookie de presencia", () => null],
    ["presencia de otra sesión de Clerk", () => createPresenceValue("sess_otra_sesion", true, PRESENCE_SECRET)],
    ["presencia firmada con otro secreto", () => createPresenceValue(SID, true, "otro-secreto-".repeat(4))],
    ["presencia caducada", () => createPresenceValue(SID, false, PRESENCE_SECRET, Date.now() - 13 * 60 * 60 * 1000)],
    ["presencia manipulada", () => `${createPresenceValue(SID, true, PRESENCE_SECRET).slice(0, -2)}xx`],
  ];
  for (const [label, presence] of validJwtCases) {
    await withApp(async ({ port, store }) => {
      const headers = { cookie: cookies(port, { presence: presence() }) };
      for (const route of PRIVATE_API) {
        const res = await privateRequest(port, route, headers);
        assert.equal(res.status, 401, `${label}: ${route.join(" ")}`);
        assert.deepEqual(JSON.parse(res.body), { error: "SESSION_REQUIRED" }, label);
      }
      const page = await request(port, "/stats", { headers });
      assert.equal(page.status, 302, label);
      assert.equal(page.headers.location, "/sign-in?redirect=/stats", label);
      assert.deepEqual(store.calls, [], `${label}: nada llegó al almacén`);
    });
  }
});

test("con la cookie de presencia bien pero un JWT que no vale (otra clave, caducado, aún no activo) tampoco se accede", async () => {
  await withApp(async ({ port, store }) => {
    const now = nowSeconds();
    const bad = {
      "firmado con otra clave": { jwt: sessionJwt(port, { key: otherKeyPair.privateKey }) },
      // __client_uat anterior a la emisión, para que se juzgue la caducidad y no el desfase con la cookie de Clerk.
      "caducado": { jwt: sessionJwt(port, { iat: now - 600, exp: now - 300 }), clientUat: now - 700 },
      "todavía no activo (nbf en el futuro)": { jwt: sessionJwt(port, { nbf: now + 3600 }) },
    };
    for (const [label, options] of Object.entries(bad)) {
      const headers = { cookie: cookies(port, options) };
      for (const route of PRIVATE_API) {
        const res = await privateRequest(port, route, headers);
        assert.equal(res.status, 401, `${label}: ${route.join(" ")}`);
      }
    }
    assert.deepEqual(store.calls, []);
  });
});

test("con la petición marcada como no disponible NO se accede aunque el JWT y la presencia sean válidos: 503, no 401", async () => {
  await withApp(async ({ port, store, warnings }) => {
    const headers = { cookie: cookies(port) };
    assert.equal((await request(port, "/api/account", { headers })).status, 200, "antes de la caída");

    const failures = {
      // El SDK lanza en cada petición (un satélite sin dominio): el modo de fallo que se puede provocar sin red.
      "el SDK de Clerk lanza": () => { process.env.CLERK_IS_SATELLITE = "true"; return () => delete process.env.CLERK_IS_SATELLITE; },
      "sin clave secreta de Clerk": () => { process.env.CLERK_SECRET_KEY = "   "; return () => { process.env.CLERK_SECRET_KEY = SECRET; }; },
    };
    for (const [label, breakClerk] of Object.entries(failures)) {
      const repair = breakClerk();
      try {
        for (const route of PRIVATE_API) {
          const res = await privateRequest(port, route, headers);
          assert.equal(res.status, 503, `${label}: ${route.join(" ")}`);
          assert.deepEqual(JSON.parse(res.body), { error: "AUTH_UNAVAILABLE" }, label);
          assert.match(res.headers["retry-after"], /^\d+$/, label);
        }
        const page = await request(port, "/stats", { headers });
        assert.equal(page.status, 503, label);
        assert.equal(page.headers.location, undefined, label);
        // Lo público y el cierre de sesión local no dependen de Clerk.
        assert.equal((await request(port, "/")).status, 200, label);
        const logout = await request(port, "/api/auth/session", {
          method: "DELETE",
          headers: { ...headers, origin: `http://127.0.0.1:${port}` },
        });
        assert.equal(logout.status, 204, label);
      } finally {
        repair();
      }
      // La caída pasó: las mismas credenciales vuelven a valer (el 503 no invalidó nada).
      const back = await request(port, "/api/account", { headers });
      assert.equal(back.status, 200, `${label}: tras la caída`);
    }
    assert.deepEqual(store.calls, [], "durante la caída no se leyó ni se escribió nada");
    assert.equal(warnings.filter((line) => line.startsWith("[auth]")).length, 2, "un aviso por motivo, no por petición");
  });
});

/* ── Authorization: solo cuentan las cookies ────────────────────────────────────
   El cliente es del mismo origen y va con cookies (replit.md); ningún módulo suyo envía Authorization, y clerk-js
   solo lo usa hacia analítica de terceros. @clerk/express, en cambio, lo lee antes que las cookies y, con un
   prefijo de token de máquina (mt_, oat_, ak_), llama a la API de Clerk en cada petición, también en las públicas. */

test("una cabecera Authorization con prefijo de token de máquina no provoca ninguna llamada a Clerk, ni en rutas públicas", async () => {
  await withApp(async ({ port }) => {
    outbound.length = 0;
    for (const token of ["mt_0123456789abcdef", "oat_0123456789abcdef", "ak_0123456789abcdef"]) {
      for (const path of ["/", "/api/auth/config", "/api/account", "/api/stats", "/no-existe"]) {
        await request(port, path, { headers: { authorization: `Bearer ${token}` } });
      }
    }
    // Sin el prefijo "Bearer" el SDK también toma el valor como token.
    await request(port, "/api/auth/config", { headers: { authorization: "ak_0123456789abcdef" } });
    assert.deepEqual(outbound, [], "el SDK no debe llegar a llamar a la API de Clerk");
  });
});

test("Authorization no autentica: un JWT de sesión válido en Bearer, sin cookie __session, no da acceso", async () => {
  await withApp(async ({ port, store }) => {
    const jwt = sessionJwt(port);
    const presence = `${APP_SESSION_COOKIE}=${createPresenceValue(SID, true, PRESENCE_SECRET)}`;
    for (const route of PRIVATE_API) {
      const res = await privateRequest(port, route, { authorization: `Bearer ${jwt}`, cookie: presence });
      assert.equal(res.status, 401, route.join(" "));
    }
    assert.deepEqual(store.calls, []);
  });
});

test("una cabecera Authorization ajena no rompe una sesión de cookies válida (el SDK la preferiría a las cookies)", async () => {
  await withApp(async ({ port }) => {
    for (const authorization of ["Bearer basura", "Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyX2FqZW5vIn0.firma", "Basic dXNlcjpwYXNz"]) {
      const res = await request(port, "/api/account", { headers: { cookie: cookies(port), authorization } });
      assert.equal(res.status, 200, authorization);
      assert.deepEqual(JSON.parse(res.body), { userId: SUB });
    }
  });
});
