import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { createApp } from "../server.mjs";

// Regla 2: el Pomodoro (y todo lo público) funciona SIEMPRE, con o sin Clerk configurado.
// Ninguna prueba contacta con Clerk: las claves son marcadores inertes y, sin cookie de sesión de Clerk,
// el SDK no sale a la red. El servidor se levanta en un puerto efímero de 127.0.0.1.
process.env.CLERK_TELEMETRY_DISABLED ??= "1";

const VALID_PK = `pk_test_${Buffer.from("test.clerk.accounts.dev$").toString("base64").replace(/=+$/, "")}`;
const SECRET = "sk_test_00000000000000000000000000000000";
const PRESENCE_SECRET = "s".repeat(48);

const ENV_KEYS = [
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_IS_SATELLITE",
  "SESSION_SECRET",
  "VITE_CLERK_PROXY_URL",
];

/** Fija el entorno mientras dura `run` (Clerk se lee en cada petición) y lo restaura siempre. */
async function withEnv(overrides, run) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, { SESSION_SECRET: PRESENCE_SECRET }, overrides);
  try {
    return await run();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** Levanta la app con el entorno dado y captura los console.warn (el aviso de Clerk no ensucia la salida). */
async function withServer(env, run) {
  return withEnv(env, async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    const server = createApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      return await run({ port: server.address().port, warnings });
    } finally {
      console.warn = originalWarn;
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    }
  });
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

/** Petición HTTP escrita a mano en un socket (para lo que http.request no deja hacer, como un Host vacío). */
function rawRequest(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

const PUBLIC_PATHS = ["/", "/index.html", "/app.js", "/timer.js", "/styles.css", "/theme-init.js", "/sign-in", "/api/auth/config"];

async function assertPublicSiteWorks(port) {
  for (const path of PUBLIC_PATHS) {
    const res = await request(port, path);
    assert.equal(res.status, 200, path);
  }
  // Rutas que ya redirigían u ocultaban su contenido siguen igual.
  const login = await request(port, "/login.html");
  assert.equal(login.status, 302);
  assert.equal(login.headers.location, "/sign-in");
  assert.equal((await request(port, "/no-existe")).status, 404);
  assert.equal((await request(port, "/server.mjs")).status, 404);
}

/**
 * Toda ruta privada debe negar el acceso, nunca 2xx ni 500. La forma de negarlo depende de por qué:
 *  - `unavailable: true`  (Clerk no puede autenticar la petición): 503 AUTH_UNAVAILABLE con Retry-After y, para
 *    /stats, una página 503 en lugar de la redirección. Nunca 401: auth-adapter.js cierra la sesión de Clerk
 *    del navegador con cada 401 de /api/auth/session, así que una caída de Clerk desconectaría a todo el mundo.
 *  - `unavailable: false` (Clerk funciona y no hay sesión): 401 SESSION_REQUIRED y redirección a /sign-in.
 */
async function assertPrivateRoutesFailClosed(port, extraHeaders = {}, { unavailable = true } = {}) {
  const same = { origin: `http://127.0.0.1:${port}`, "content-type": "application/json", ...extraHeaders };
  const sessionBody = JSON.stringify({
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
  const cases = [
    ["GET", "/api/auth/session", undefined],
    ["GET", "/api/account", undefined],
    ["GET", "/api/stats", undefined],
    ["GET", "/api/stats?days=30", undefined],
    ["POST", "/api/auth/session", JSON.stringify({ remember: true })],
    ["POST", "/api/stats/sessions", sessionBody],
  ];
  for (const [method, path, body] of cases) {
    const res = await request(port, path, { method, headers: same, body });
    const label = `${method} ${path}`;
    if (unavailable) {
      assert.equal(res.status, 503, label);
      assert.deepEqual(JSON.parse(res.body), { error: "AUTH_UNAVAILABLE" }, label);
      assert.match(res.headers["retry-after"] ?? "", /^[1-9]\d{0,3}$/, `${label}: Retry-After en segundos`);
    } else {
      assert.equal(res.status, 401, label);
      assert.deepEqual(JSON.parse(res.body), { error: "SESSION_REQUIRED" }, label);
      assert.equal(res.headers["retry-after"], undefined, label);
    }
    assert.equal(res.headers["set-cookie"], undefined, `${label} no debe fijar cookie de presencia`);
  }
  for (const path of ["/stats", "/stats.html"]) {
    const res = await request(port, path, { headers: extraHeaders });
    // Ni la página, ni la redirección, ni el 503 dependen de quién pregunta como para guardarse en caché.
    assert.equal(res.headers["cache-control"], "private, no-store", path);
    if (unavailable) {
      assert.equal(res.status, 503, path);
      assert.equal(res.headers.location, undefined, `${path}: no redirige a /sign-in cuando Clerk no está disponible`);
      assert.match(res.headers["content-type"], /^text\/html/, path);
      assert.match(res.headers["retry-after"] ?? "", /^[1-9]\d{0,3}$/, path);
      assert.match(res.body, /Servicio de cuentas no disponible/, path);
      assert.match(res.body, /href="\/"/, `${path}: enlace de vuelta al Pomodoro, que funciona sin cuenta`);
      assert.doesNotMatch(res.body, /<script|<style|\son\w+=/i, `${path}: la CSP no admite nada en línea`);
    } else {
      assert.equal(res.status, 302, path);
      assert.equal(res.headers.location, "/sign-in?redirect=/stats", path);
    }
  }
}

const FORGED_CREDENTIALS = {
  authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyX2ZvcmdlZCJ9.firma",
  cookie: "__session=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyX2ZvcmdlZCJ9.firma; __client_uat=1700000000; __Host-postava_presence=cargautil.firma",
};

test("server.mjs no monta clerkMiddleware sin protección ni de forma global: solo clerkAuthentication(), ruta a ruta", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /app\.use\(\s*clerkMiddleware/, "un clerkMiddleware global sin envolver vuelve a tumbar el sitio sin claves");
  assert.equal(source.match(/clerkMiddleware\(/g)?.length, 1, "solo el envoltorio construye el middleware de Clerk");
  // Global, Clerk responde 307 de handshake a toda navegación (la página principal incluida) con claves de
  // desarrollo: ver server-public-routes.test.mjs.
  assert.doesNotMatch(source, /app\.use\(\s*(?:clerkAuthentication\(\)|withClerk)/, "Clerk global: la página principal dependería de Clerk");
  assert.match(source, /const withClerk = clerkAuthentication\(\);/);
});

test("sin CLERK_SECRET_KEY ni clave pública el sitio público responde 200 y las rutas privadas fallan cerradas", async () => {
  await withServer({}, async ({ port, warnings }) => {
    await assertPublicSiteWorks(port);
    await assertPrivateRoutesFailClosed(port);
    // El operador debe enterarse (una vez por motivo y minuto, sin repetir por petición y sin volcar valores).
    assert.equal(warnings.length, 1, warnings.join("\n"));
    assert.match(warnings[0], /CLERK_SECRET_KEY/);
    assert.match(warnings[0], /503/);
    assert.doesNotMatch(warnings[0], /\b401\b/);
  });
});

// Va antes de cualquier prueba que use una clave secreta: el SDK de Clerk cachea en un singleton la primera
// clave no vacía que ve y, una vez creado, una clave vacía en el entorno ya no le hace fallar. El servidor
// debe decidir por el entorno (no por ese caché), así que el orden no puede cambiar el resultado.
test("una clave secreta vacía o solo con espacios cuenta como no configurada", async () => {
  for (const secret of ["", "   "]) {
    await withServer({ CLERK_SECRET_KEY: secret, CLERK_PUBLISHABLE_KEY: VALID_PK }, async ({ port }) => {
      await assertPublicSiteWorks(port);
      await assertPrivateRoutesFailClosed(port);
    });
  }
});

test("sin Clerk, unas credenciales falsas (JWT de sesión y cookie de presencia inventados) no dan acceso", async () => {
  await withServer({}, async ({ port }) => {
    await assertPrivateRoutesFailClosed(port, FORGED_CREDENTIALS);
    // Ni siquiera con una cookie de presencia bien formada: sin sesión de Clerk verificada no hay identidad.
    await assertPublicSiteWorks(port);
  });
});

test("con la clave secreta pero una clave pública inválida ocurre lo mismo (el sitio no cae)", async () => {
  await withServer({ CLERK_SECRET_KEY: SECRET, CLERK_PUBLISHABLE_KEY: "pk_test_no-es-una-clave" }, async ({ port, warnings }) => {
    await assertPublicSiteWorks(port);
    await assertPrivateRoutesFailClosed(port, FORGED_CREDENTIALS);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /publishable key/i);
  });
});

test("si el middleware de Clerk lanza (configuración rota), lo público sigue y lo privado falla cerrado", async () => {
  // Un satélite sin dominio ni proxy hace que el SDK lance dentro de authenticateRequest en cada petición.
  await withServer(
    { CLERK_SECRET_KEY: SECRET, CLERK_PUBLISHABLE_KEY: VALID_PK, CLERK_IS_SATELLITE: "true" },
    async ({ port, warnings }) => {
      await assertPublicSiteWorks(port);
      await assertPrivateRoutesFailClosed(port, FORGED_CREDENTIALS);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /Clerk/);
    },
  );
});

test("con Clerk bien configurado nada cambia: sin sesión, 401 y redirección, y sin avisos", async () => {
  await withServer({ CLERK_SECRET_KEY: SECRET, CLERK_PUBLISHABLE_KEY: VALID_PK }, async ({ port, warnings }) => {
    await assertPublicSiteWorks(port);
    // Clerk sí puede mirar y no hay sesión: eso sigue siendo un 401 / redirección, no un 503.
    await assertPrivateRoutesFailClosed(port, {}, { unavailable: false });
    const config = await request(port, "/api/auth/config");
    assert.deepEqual(JSON.parse(config.body), { publishableKey: VALID_PK, proxyUrl: "" });
    assert.deepEqual(warnings, []);
  });
});

test("DELETE /api/auth/session sigue limpiando la cookie de presencia aunque Clerk no esté configurado", async () => {
  await withServer({}, async ({ port }) => {
    const res = await request(port, "/api/auth/session", {
      method: "DELETE",
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(res.status, 204);
    assert.match(String(res.headers["set-cookie"]), /Max-Age=0/);
  });
});

test("un fallo transitorio de Clerk da 503 mientras dura (no 401, que cerraría la sesión) y luego todo vuelve a la normalidad", async () => {
  await withServer({ CLERK_SECRET_KEY: SECRET, CLERK_PUBLISHABLE_KEY: VALID_PK }, async ({ port, warnings }) => {
    // Clerk sano y sin sesión: 401 y redirección, como siempre.
    await assertPrivateRoutesFailClosed(port, {}, { unavailable: false });
    assert.deepEqual(warnings, []);

    // Ahora el SDK lanza en cada petición (un satélite sin dominio; es el modo de fallo que se puede provocar sin red).
    process.env.CLERK_IS_SATELLITE = "true";
    await assertPrivateRoutesFailClosed(port, FORGED_CREDENTIALS, { unavailable: true });
    await assertPublicSiteWorks(port);
    // Cerrar la sesión local no depende de Clerk: sigue funcionando en plena caída.
    const logout = await request(port, "/api/auth/session", { method: "DELETE", headers: { origin: `http://127.0.0.1:${port}` } });
    assert.equal(logout.status, 204);
    assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/);
    assert.equal(warnings.length, 1, warnings.join("\n"));

    // Clerk vuelve: el marcado era de cada petición, no queda pegado a la aplicación.
    delete process.env.CLERK_IS_SATELLITE;
    await assertPrivateRoutesFailClosed(port, {}, { unavailable: false });
  });
});

test("el aviso de Clerk se limita por motivo: un Host manipulado no lo agota ni se imprime texto del cliente", async () => {
  // Sin CLERK_PUBLISHABLE_KEY la clave sale del Host de cada petición, y el SDK lanza en todas (satélite sin dominio).
  await withServer({ CLERK_SECRET_KEY: SECRET, CLERK_IS_SATELLITE: "true" }, async ({ port, warnings }) => {
    // 0) Solo las rutas privadas consultan a Clerk: lo público responde 200 (con o sin Host) y no avisa de nada.
    assert.match(await rawRequest(port, "GET / HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n"), /^HTTP\/1\.1 200 /);
    assert.equal((await request(port, "/")).status, 200);
    assert.deepEqual(warnings, []);
    // 1) Un Host vacío no permite resolver ninguna clave: es un motivo distinto, provocado por el cliente.
    //    (http.request rellena un Host vacío por su cuenta, así que la petición se escribe a mano.)
    assert.match(await rawRequest(port, "GET /api/account HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n"), /^HTTP\/1\.1 503 /);
    assert.equal(warnings.length, 1, warnings.join("\n"));
    assert.match(warnings[0], /host of a request/);
    // 2) Eso no debe silenciar el fallo real de Clerk, que es otro motivo.
    for (let i = 0; i < 6; i++) assert.equal((await request(port, "/api/account")).status, 503);
    assert.equal(warnings.length, 2, warnings.join("\n"));
    assert.match(warnings[1], /Clerk SDK failed/);
    // 3) Repetirlo no repite el aviso dentro del intervalo (ni siquiera con Hosts distintos, ni desde otra ruta privada).
    for (const host of ["otro.example.com", "127.0.0.1:1", "evil.example.com;script-src-*"]) {
      await request(port, "/api/account", { headers: { host } });
    }
    await request(port, "/api/stats");
    await request(port, "/stats");
    await rawRequest(port, "GET /api/account HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n");
    assert.equal(warnings.length, 2, warnings.join("\n"));

    for (const line of warnings) {
      assert.doesNotMatch(line, /127\.0\.0\.1|evil|otro\.example|sk_test|pk_test/, `sin Host ni claves en el log: ${line}`);
      assert.match(line, /503/);
      assert.equal(line.split("\n").length, 1, "una sola línea");
    }
  });
});
