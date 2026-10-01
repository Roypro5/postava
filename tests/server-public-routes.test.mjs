import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

/* ── Regla 2: lo público no depende de Clerk, ni siquiera con claves de desarrollo ──────────────────
   Con una clave pública de DESARROLLO (pk_test_…) y la clave secreta configuradas, @clerk/express responde
   307 a toda NAVEGACIÓN de un visitante sin cookie de dev-browser, la página principal incluida, hacia
   https://<frontendApi>/v1/client/handshake (x-clerk-auth-status: handshake). Si Clerk no responde (caída,
   sin red, host inválido) la página ni carga: el Pomodoro anónimo dependería de Clerk.

   Los demás tests del servidor no lo veían porque ninguno manda cabeceras de navegador (Sec-Fetch-Dest:
   document, Accept: text/html, User-Agent Mozilla): sin ellas el SDK no considera la petición apta para el
   handshake. Aquí TODAS las peticiones las llevan.

   Sin red y sin cuentas: las claves son marcadores inertes que apuntan a un host que no existe
   (clerk.test.invalid, TLD reservado) y fetch se sustituye ANTES de cargar el servidor; cualquier llamada que
   el SDK intentara quedaría registrada en `outbound` y los tests exigen que esté vacía.                    */

process.env.CLERK_TELEMETRY_DISABLED ??= "1";

const outbound = [];
globalThis.fetch = async (url) => {
  outbound.push(String(url));
  throw new TypeError("fetch failed: los tests no tienen red");
};

const CLERK_HOST = "clerk.test.invalid";
// Misma clave que la de la reproducción: Y2xlcmsudGVzdC5pbnZhbGlkJA== es "clerk.test.invalid$".
const DEV_PUBLISHABLE_KEY = `pk_test_${Buffer.from(`${CLERK_HOST}$`).toString("base64")}`;
Object.assign(process.env, {
  CLERK_SECRET_KEY: "sk_test_placeholder_not_a_real_key",
  CLERK_PUBLISHABLE_KEY: DEV_PUBLISHABLE_KEY,
  CLERK_API_URL: "http://127.0.0.1:1",
  SESSION_SECRET: randomBytes(36).toString("base64url"),
});
delete process.env.CLERK_JWT_KEY;
delete process.env.CLERK_IS_SATELLITE;
delete process.env.VITE_CLERK_PROXY_URL;

const serverModule = await import("../server.mjs");
const { createApp } = serverModule;

/** Lo que manda Edge/Chrome al escribir una dirección: una navegación de documento. */
const BROWSER_NAVIGATION = Object.freeze({
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "es-ES,es;q=0.9",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
});

/** Lo que manda el cliente de la propia app (fetch del mismo origen) a la API. */
const BROWSER_FETCH = Object.freeze({
  "user-agent": BROWSER_NAVIGATION["user-agent"],
  accept: "application/json",
  "accept-language": "es-ES,es;q=0.9",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
});

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

/** Levanta la app en un puerto efímero de loopback y captura los console.warn (el aviso de Clerk no ensucia la salida). */
async function withApp(run, { nodeEnv } = {}) {
  const store = fakeStore();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  // El modo (producción o no) se decide al construir la app; se restaura enseguida.
  const originalEnv = process.env.NODE_ENV;
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  let server;
  try {
    server = createApp({ store }).listen(0, "127.0.0.1");
  } finally {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  }
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
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const navigate = (port, path, extraHeaders = {}, options = {}) =>
  request(port, path, { ...options, headers: { ...BROWSER_NAVIGATION, ...extraHeaders, ...options.headers } });

/** Si redirige, es dentro del propio sitio y no es un handshake; no deja cookies de Clerk. */
function assertNoClerkRedirect(res, label) {
  assert.notEqual(res.headers["x-clerk-auth-status"], "handshake", `${label}: handshake de Clerk`);
  const { location } = res.headers;
  if (location !== undefined) {
    assert.match(location, /^\/(?!\/)/, `${label}: redirige fuera del sitio (${location})`);
    assert.doesNotMatch(location, /__clerk|handshake|clerk\./i, `${label}: redirección de handshake (${location})`);
  }
  assert.doesNotMatch(String(res.headers["set-cookie"] ?? ""), /__clerk|__client_uat/i, `${label}: cookies de Clerk`);
}

/** Lo público no deja ninguna huella de Clerk: ni redirección ni cabeceras x-clerk-* (prueba de que el SDK ni corrió). */
function assertNoClerkInvolvement(res, label) {
  const clerkHeaders = Object.keys(res.headers).filter((name) => name.startsWith("x-clerk"));
  assert.deepEqual(clerkHeaders, [], `${label}: cabeceras de Clerk en la respuesta`);
  assertNoClerkRedirect(res, label);
}

/** El Location debe apuntar al host de Clerk y la respuesta ser el handshake (lo único que /stats puede hacer). */
function isClerkHandshake(res) {
  const { location } = res.headers;
  return (
    res.status === 307 &&
    res.headers["x-clerk-auth-status"] === "handshake" &&
    typeof location === "string" &&
    location.startsWith(`https://${CLERK_HOST}/v1/client/handshake?`)
  );
}

/** Rutas públicas de la página principal y de acceso, con el estado que dan hoy (200 salvo lo que redirige dentro del sitio). */
const PUBLIC_ROUTES = [
  ["/", 200],
  ["/index.html", 200],
  ["/app.js", 200],
  ["/timer.js", 200],
  ["/theme-init.js", 200],
  ["/styles.css", 200],
  ["/login.html", 302],
  ["/login", 302],
  ["/sign-in", 200],
  ["/sign-up", 200],
  ["/api/auth/config", 200],
  ["/no-existe", 404],
  ["/server.mjs", 404],
];

function assertPublicRoute(res, expectedStatus, label) {
  assertNoClerkInvolvement(res, label);
  assert.equal(res.status, expectedStatus, label);
  if (expectedStatus === 302) assert.equal(res.headers.location, "/sign-in", label);
}

/* ── Estructura: Clerk solo en las rutas privadas ─────────────────────────────────────────────── */

const CLERK_LAYER = "clerkAuthenticationMiddleware";
const PRIVATE_ROUTES = new Set([
  "GET /api/auth/session",
  "POST /api/auth/session",
  "GET /api/account",
  "GET /api/stats",
  "POST /api/stats/sessions",
  "GET /stats",
  "GET /stats.html",
]);

test("el middleware de Clerk no es global: está montado en las rutas privadas y solo en ellas", () => {
  const stack = createApp({ store: fakeStore() }).router.stack;

  const global = stack.filter((layer) => !layer.route && layer.handle?.name === CLERK_LAYER);
  assert.deepEqual(global, [], "app.use(clerkAuthentication()) vuelve a poner a Clerk delante de la página principal");

  const mounted = new Set();
  const seenRoutes = new Set();
  for (const layer of stack) {
    if (!layer.route) continue;
    const handlers = layer.route.stack;
    const position = handlers.findIndex((handler) => handler.handle.name === CLERK_LAYER);
    for (const method of Object.keys(layer.route.methods).map((m) => m.toUpperCase())) {
      for (const path of [layer.route.path].flat()) {
        seenRoutes.add(`${method} ${path}`);
        if (position < 0) continue;
        mounted.add(`${method} ${path}`);
        // Clerk va el primero (en la API, justo detrás de declararla "no navegación"): el limitador usa la
        // identidad verificada y los manejadores la leen.
        const before = handlers.slice(0, position).map((handler) => handler.handle.name);
        const expectedBefore = path.startsWith("/api/") ? ["notANavigation"] : [];
        assert.deepEqual(before, expectedBefore, `${method} ${path}: Clerk debe ir antes que el limitador y el manejador`);
      }
    }
  }
  assert.deepEqual([...mounted].sort(), [...PRIVATE_ROUTES].sort());

  // Control de vacuidad: el recorrido ve las rutas públicas que no deben llevarlo.
  for (const route of ["GET /", "GET /api/auth/config", "DELETE /api/auth/session"]) {
    assert.ok(seenRoutes.has(route), `el recorrido no vio ${route}`);
    assert.ok(!mounted.has(route), `${route} no debe pasar por Clerk`);
  }
});

/* ── Comportamiento: el sitio público con las cabeceras de un navegador real ─────────────────── */

test("con claves de desarrollo y un host de Clerk inexistente, lo público carga sin ningún handshake", async () => {
  await withApp(async ({ port, warnings }) => {
    outbound.length = 0;
    for (const [path, status] of PUBLIC_ROUTES) {
      assertPublicRoute(await navigate(port, path), status, path);
    }
    // HEAD (lo que hacen los comprobadores de salud y algunas cachés) tampoco puede acabar en Clerk.
    const head = await navigate(port, "/", {}, { method: "HEAD" });
    assertNoClerkInvolvement(head, "HEAD /");
    assert.equal(head.status, 200);

    assert.deepEqual(outbound, [], "lo público no llama a Clerk");
    assert.deepEqual(warnings.filter((line) => line.startsWith("[auth]")), [], "ni hay motivo para avisar de Clerk");
  });
});

test("el contenido de la página principal es el del Pomodoro, no una redirección ni una página de Clerk", async () => {
  await withApp(async ({ port }) => {
    const res = await navigate(port, "/");
    assert.equal(res.status, 200);
    assert.equal(res.body, readFileSync(new URL("../index.html", import.meta.url), "utf8"));
    assert.match(res.headers["content-type"], /^text\/html/);
  });
});

test("lo público tampoco llama a Clerk con una cabecera Authorization o una cookie __session falsas", async () => {
  await withApp(async ({ port, warnings }) => {
    const forgedJwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyX2ZvcmdlZCJ9.firma";
    const variants = {
      "Authorization: Bearer x": { authorization: "Bearer x" },
      "Authorization con un JWT": { authorization: `Bearer ${forgedJwt}` },
      "Authorization con prefijo de token de máquina": { authorization: "Bearer mt_0123456789abcdef" },
      "cookie __session falsa": { cookie: `__session=${forgedJwt}` },
      "cookie __session y __client_uat": { cookie: `__session=${forgedJwt}; __client_uat=1700000000` },
      "las dos a la vez": { authorization: "Bearer x", cookie: `__session=${forgedJwt}; __clerk_db_jwt=dvb_falso` },
    };
    outbound.length = 0;
    for (const [name, headers] of Object.entries(variants)) {
      for (const [path, status] of PUBLIC_ROUTES) {
        assertPublicRoute(await navigate(port, path, headers), status, `${name}: ${path}`);
      }
    }
    assert.deepEqual(outbound, [], "ninguna llamada a Clerk desde rutas públicas");
    assert.deepEqual(warnings.filter((line) => line.startsWith("[auth]")), []);
  });
});

/** Rutas de la allowlist (publicFiles) tal como están registradas en server.mjs. */
function allowlistedPaths() {
  const source = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const block = source.match(/const publicFiles = new Map\(\[([\s\S]*?)\]\);/)?.[1];
  assert.ok(block, "no se encontró el Map publicFiles en server.mjs");
  return [...block.matchAll(/\[\s*"(\/[^"]+)"\s*,\s*"([^"]+)"\s*\]/g)].map((match) => ({ path: match[1], file: match[2] }));
}

test("ninguna ruta de la allowlist de server.mjs redirige a Clerk con cabeceras de navegador", async () => {
  const entries = allowlistedPaths();
  // Control de vacuidad: el análisis llega a las rutas conocidas y no se queda corto.
  for (const known of ["/index.html", "/app.js", "/timer.js", "/theme-init.js", "/styles.css", "/stats.js", "/login.js", "/logo.svg"]) {
    assert.ok(entries.some((entry) => entry.path === known), `la lectura de la allowlist no llegó a ${known}`);
  }
  assert.ok(entries.length >= 25, `se esperaban >= 25 entradas y hay ${entries.length}`);

  await withApp(async ({ port }) => {
    outbound.length = 0;
    for (const { path, file } of entries) {
      // El bundle de Clerk se genera con esbuild al arrancar el servidor: sin build no existe y da 404.
      const built = existsSync(new URL(`../${file}`, import.meta.url));
      for (const headers of [{}, { authorization: "Bearer x" }, { cookie: "__session=falsa" }]) {
        const res = await navigate(port, path, headers);
        const label = `${path} ${JSON.stringify(headers)}`;
        assertNoClerkInvolvement(res, label);
        if (built) assert.equal(res.status, 200, label);
        else assert.ok([200, 404].includes(res.status), label);
      }
    }
    assert.deepEqual(outbound, []);
  });
});

test("DELETE /api/auth/session cierra la sesión local sin Clerk, con un navegador y con Clerk inalcanzable", async () => {
  await withApp(async ({ port }) => {
    outbound.length = 0;
    const res = await navigate(port, "/api/auth/session", { origin: `http://127.0.0.1:${port}`, cookie: "__session=falsa" }, { method: "DELETE" });
    assertNoClerkInvolvement(res, "DELETE /api/auth/session");
    assert.equal(res.status, 204);
    assert.match(String(res.headers["set-cookie"]), /Max-Age=0/);
    assert.deepEqual(outbound, []);
  });
});

test("el proxy de Clerk (/api/__clerk) sigue montado antes y no pasa por la autenticación de Clerk", async () => {
  // En producción con la clave secreta el proxy real está montado; estas peticiones las rechaza su propia guarda
  // (ruta fuera de /v1, método no permitido) sin reenviar nada a Clerk, y la guarda va antes que cualquier otro middleware.
  await withApp(
    async ({ port }) => {
      outbound.length = 0;
      const outside = await navigate(port, "/api/__clerk/no-es-v1");
      assertNoClerkInvolvement(outside, "/api/__clerk/no-es-v1");
      assert.equal(outside.status, 404);
      assert.deepEqual(JSON.parse(outside.body), { error: "NOT_FOUND" }, "la respuesta es de la guarda del proxy");

      const method = await navigate(port, "/api/__clerk/v1/client", {}, { method: "TRACE" });
      assertNoClerkInvolvement(method, "TRACE /api/__clerk/v1/client");
      assert.equal(method.status, 405);
      assert.deepEqual(outbound, []);
    },
    { nodeEnv: "production" },
  );
});

/* ── Las rutas privadas siguen cerradas ──────────────────────────────────────────────────────── */

const sessionBody = () =>
  JSON.stringify({
    id: "4b2de3a2-e6c2-4f8b-9d01-217e26ec8766",
    expectedUserId: "user_12345678",
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

const PRIVATE_API = [
  ["GET", "/api/auth/session"],
  ["GET", "/api/account"],
  ["GET", "/api/stats"],
  ["GET", "/api/stats?days=30"],
  ["POST", "/api/auth/session"],
  ["POST", "/api/stats/sessions"],
];

const forgedCredentials = {
  "sin credenciales": {},
  "Authorization: Bearer x": { authorization: "Bearer x" },
  "cookie __session falsa": { cookie: "__session=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyX2ZvcmdlZCJ9.firma; __client_uat=1700000000" },
  "cookie de presencia inventada": { cookie: "__Host-postava_presence=cargautil.firma" },
};

test("las rutas privadas de la API, pedidas con cabeceras de navegador y sin sesión, fallan cerradas", async () => {
  await withApp(async ({ port, store }) => {
    for (const [credentials, extra] of Object.entries(forgedCredentials)) {
      for (const [method, path] of PRIVATE_API) {
        const label = `${credentials}: ${method} ${path}`;
        // Como las manda la app (fetch del mismo origen) y como las vería quien las abre en la barra de direcciones.
        const headerSets = {
          fetch: { ...BROWSER_FETCH, origin: `http://127.0.0.1:${port}`, "content-type": "application/json", ...extra },
          navegación: { ...BROWSER_NAVIGATION, origin: `http://127.0.0.1:${port}`, "content-type": "application/json", ...extra },
        };
        for (const [kind, headers] of Object.entries(headerSets)) {
          const res = await request(port, path, { method, headers, body: method === "POST" ? (path.endsWith("/sessions") ? sessionBody() : JSON.stringify({ remember: true })) : undefined });
          assert.ok(res.status === 401 || res.status === 503, `${label} (${kind}): ${res.status}`);
          // Aquí Clerk sí corre (y pone sus cabeceras informativas x-clerk-auth-*), pero una API JSON nunca redirige.
          assertNoClerkRedirect(res, `${label} (${kind})`);
          assert.equal(res.headers["set-cookie"], undefined, `${label} (${kind}): no debe fijar cookie de presencia`);
          assert.match(res.body, /"error":"(SESSION_REQUIRED|AUTH_UNAVAILABLE)"/, `${label} (${kind})`);
        }
      }
    }
    assert.deepEqual(store.calls, [], "nada llegó al almacén");
  });
});

test("/stats sin sesión: redirige a /sign-in, 503 o, como mucho, el handshake de Clerk; nunca la página", async () => {
  const statsPage = readFileSync(new URL("../stats.html", import.meta.url), "utf8");
  await withApp(async ({ port }) => {
    for (const [credentials, extra] of Object.entries(forgedCredentials)) {
      for (const path of ["/stats", "/stats.html"]) {
        const res = await navigate(port, path, extra);
        const label = `${credentials}: ${path}`;
        // Una página privada necesita a Clerk de todos modos: si el navegador no trae aún la cookie del dev-browser
        // (solo en instancias de desarrollo) el SDK puede mandarlo a Clerk a por ella. Es lo único que se admite.
        const signIn = res.status === 302 && res.headers.location === "/sign-in?redirect=/stats";
        const unavailable = res.status === 503;
        assert.ok(signIn || unavailable || isClerkHandshake(res), `${label}: ${res.status} ${res.headers.location ?? ""}`);
        assert.notEqual(res.body, statsPage, `${label}: no sirve la página privada`);
        // La respuesta del handshake es del SDK (su propio no-store); las demás, la caché privada de la página.
        if (isClerkHandshake(res)) assert.match(res.headers["cache-control"], /no-store/, label);
        else assert.equal(res.headers["cache-control"], "private, no-store", label);
      }
    }
  });
});

/* ── realClerkSession ante una petición que Clerk no autenticó ──────────────────────────────── */

test("realClerkSession falla cerrado si Clerk no corrió en la ruta: devuelve null, no lanza ni autentica", () => {
  const { realClerkSession } = serverModule;
  assert.equal(typeof realClerkSession, "function");
  // Petición que nunca pasó por el middleware (no hay req.auth).
  assert.equal(realClerkSession({ headers: {} }), null);
  assert.equal(realClerkSession({ headers: { cookie: "__session=x" } }), null);
  // Un req.auth que no puso nuestro middleware (otro middleware, un descuido) no vale como sesión de Clerk.
  const foreign = { headers: {}, auth: () => ({ userId: "user_ajeno12345", sessionId: "sess_ajena12345" }) };
  assert.equal(realClerkSession(foreign), null);
});
