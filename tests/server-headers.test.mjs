import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import vm from "node:vm";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createApp } from "../server.mjs";
import { buildContentSecurityPolicy, clerkFrontendApiOrigin, securityHeaders } from "../server/security-headers.mjs";
import { MODEL_URL, WASM_BASE } from "../posture-monitor.js";

// El SDK de Clerk envía telemetría a sus servidores con claves pk_test: en tests no debe salir nada a la red.
process.env.CLERK_TELEMETRY_DISABLED ??= "1";
// Claves inertes de prueba: ninguna instancia real de Clerk se contacta desde estos tests.
process.env.CLERK_SECRET_KEY ??= "sk_test_00000000000000000000000000000000";
process.env.CLERK_PUBLISHABLE_KEY ??= `pk_test_${Buffer.from("test.clerk.accounts.dev$")
  .toString("base64")
  .replace(/=+$/, "")}`;

const ROOT = new URL("../", import.meta.url);
const readRoot = (path) => readFileSync(new URL(path, ROOT), "utf8");

/** Crea la app con NODE_ENV fijado solo durante createApp() (ahí se decide el modo de las cabeceras). */
async function startServer({ nodeEnv } = {}) {
  const original = process.env.NODE_ENV;
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  let app;
  try {
    app = createApp();
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
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

/** Aplica el middleware sobre una respuesta falsa y devuelve las cabeceras que puso (y, en `vary`, las de Vary). */
function headersFrom(options) {
  const headers = new Map();
  const vary = [];
  securityHeaders(options)({}, { set: (name, value) => headers.set(name, value), vary: (name) => vary.push(name) }, () => {});
  headers.vary = vary;
  return headers;
}

const directive = (csp, name) => {
  const match = csp.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `));
  assert.ok(match, `falta la directiva ${name}`);
  return match.split(/\s+/).slice(1);
};

test("producción: HSTS, Permissions-Policy, COOP y CSP enforcing; nada de Report-Only", () => {
  const headers = headersFrom({ isProduction: true });
  assert.equal(headers.get("Strict-Transport-Security"), "max-age=15552000");
  assert.equal(headers.get("Permissions-Policy"), "camera=(self), microphone=(), geolocation=()");
  assert.equal(headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assert.ok(headers.has("Content-Security-Policy"));
  assert.ok(!headers.has("Content-Security-Policy-Report-Only"));
  // Las de siempre siguen ahí.
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  assert.equal(headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
});

test("fuera de producción: sin HSTS (no se fija HTTPS en localhost), CSP en Report-Only, resto igual", () => {
  const headers = headersFrom({ isProduction: false });
  assert.ok(!headers.has("Strict-Transport-Security"));
  assert.equal(headers.get("Permissions-Policy"), "camera=(self), microphone=(), geolocation=()");
  assert.equal(headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assert.ok(headers.has("Content-Security-Policy-Report-Only"));
  assert.ok(!headers.has("Content-Security-Policy"));
});

test("el servidor real envía las cabeceras según NODE_ENV, también en respuestas de API y 404", async () => {
  const dev = await startServer({});
  try {
    for (const path of ["/", "/api/auth/config", "/no-existe"]) {
      const res = await get(dev.port, path);
      assert.equal(res.headers["strict-transport-security"], undefined, path);
      assert.equal(res.headers["cross-origin-opener-policy"], "same-origin", path);
      assert.equal(res.headers["permissions-policy"], "camera=(self), microphone=(), geolocation=()", path);
      assert.ok(res.headers["content-security-policy-report-only"], path);
      assert.equal(res.headers["content-security-policy"], undefined, path);
    }
  } finally {
    await dev.close();
  }

  const prod = await startServer({ nodeEnv: "production" });
  try {
    for (const path of ["/", "/api/auth/config", "/no-existe", "/theme-init.js"]) {
      const res = await get(prod.port, path);
      assert.equal(res.headers["strict-transport-security"], "max-age=15552000", path);
      assert.equal(res.headers["cross-origin-opener-policy"], "same-origin", path);
      assert.equal(res.headers["permissions-policy"], "camera=(self), microphone=(), geolocation=()", path);
      assert.ok(res.headers["content-security-policy"], path);
      assert.equal(res.headers["content-security-policy-report-only"], undefined, path);
    }
  } finally {
    await prod.close();
  }
});

for (const isProduction of [true, false]) {
  test(`CSP (${isProduction ? "producción" : "desarrollo"}): sin 'unsafe-inline' ni 'unsafe-eval' en script-src, y MediaPipe sigue permitido`, () => {
    const csp = buildContentSecurityPolicy({ isProduction });
    const scriptSrc = directive(csp, "script-src");
    const connectSrc = directive(csp, "connect-src");

    for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "*", "https:", "http:", "data:", "blob:"]) {
      assert.ok(!scriptSrc.includes(bad), `script-src no debe incluir ${bad}`);
    }
    // Sin hash ni nonce: no hay ningún script en línea que autorizar.
    assert.ok(!scriptSrc.some((value) => /^'(?:sha\d+-|nonce-)/.test(value)));

    // MediaPipe: el módulo y el runtime wasm vienen de jsDelivr, el modelo de storage.googleapis.com.
    assert.ok(scriptSrc.includes("'wasm-unsafe-eval'"));
    // Fijado por prefijo de ruta (no el host entero): WASM_BASE y MODEL_URL caen bajo ellos.
    const cdnPrefix = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/";
    const modelPrefix = "https://storage.googleapis.com/mediapipe-models/";
    assert.ok(scriptSrc.includes(cdnPrefix));
    assert.ok(connectSrc.includes(cdnPrefix));
    assert.ok(connectSrc.includes(modelPrefix));
    assert.ok(cspAllowsUrl(scriptSrc, `${WASM_BASE}/vision_wasm_internal.js`), "el loader wasm debe caer en script-src");
    assert.ok(cspAllowsUrl(connectSrc, `${WASM_BASE}/vision_wasm_internal.wasm`), "el .wasm debe caer en connect-src");
    assert.ok(cspAllowsUrl(connectSrc, MODEL_URL), "MODEL_URL debe caer en connect-src");
    // Sin el host entero, cualquier otro paquete del CDN o bucket de Google quedaria permitido.
    for (const host of ["https://cdn.jsdelivr.net", "https://storage.googleapis.com"]) {
      assert.ok(!scriptSrc.includes(host) && !connectSrc.includes(host), `${host} no debe permitirse entero`);
    }
    assert.ok(!cspAllowsUrl(scriptSrc, "https://cdn.jsdelivr.net/npm/otro-paquete@1.0.0/x.js"));
    assert.ok(!cspAllowsUrl(connectSrc, "https://storage.googleapis.com/otro-bucket/x"));
    assert.ok(directive(csp, "worker-src").includes("blob:"));
    assert.deepEqual(directive(csp, "default-src"), ["'none'"]);
  });
}

/** Coincidencia de ruta de CSP: con "/" final es prefijo, si no, exacta; el origen siempre debe coincidir. */
function cspAllowsUrl(sources, url) {
  const target = new URL(url);
  return sources.some((source) => {
    if (!source.startsWith("https://")) return false;
    const src = new URL(source);
    if (src.origin !== target.origin) return false;
    if (src.pathname === "/" && !source.endsWith("/")) return true; // fuente de solo origen
    return src.pathname.endsWith("/") ? target.pathname.startsWith(src.pathname) : target.pathname === src.pathname;
  });
}

test("cada import() remoto de app.js cae en el script-src que se aplica en producción", () => {
  const remote = [...readRoot("app.js").matchAll(/\bimport\(\s*["'](https:\/\/[^"']+)["']\s*\)/g)].map((match) => match[1]);
  assert.ok(remote.length >= 1, "app.js ya no importa MediaPipe por CDN: actualiza este test y la CSP");
  const scriptSrc = directive(buildContentSecurityPolicy({ isProduction: true }), "script-src");
  for (const url of remote) {
    assert.ok(cspAllowsUrl(scriptSrc, url), `${url} no está permitido por script-src`);
  }
});

const PAGES = ["index.html", "login.html", "stats.html"];

for (const page of PAGES) {
  test(`${page}: no queda ningún script en línea ni manejador on*= y el tema se carga síncrono desde /theme-init.js`, () => {
    const html = readRoot(page).replace(/<!--[\s\S]*?-->/g, "");
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(match[1], /\bsrc\s*=/, `${page} tiene un <script> en línea: la CSP de producción lo bloquea`);
      assert.equal(match[2].trim(), "", `${page}: un <script src> no debe llevar cuerpo`);
    }
    assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, `${page} tiene manejadores de eventos en línea`);

    const head = html.slice(html.indexOf("<head"), html.indexOf("</head>"));
    const tag = head.match(/<script\b[^>]*\bsrc\s*=\s*["']\/theme-init\.js["'][^>]*>/i)?.[0];
    assert.ok(tag, `${page} debe cargar /theme-init.js en el <head>`);
    // Síncrono: con defer, async o module el tema se aplicaría después del primer pintado (parpadeo).
    assert.doesNotMatch(tag, /\b(?:defer|async)\b|\btype\s*=/i);
  });
}

test("/theme-init.js se sirve como JavaScript desde la allowlist", async () => {
  const { port, close } = await startServer({});
  try {
    const res = await get(port, "/theme-init.js");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /javascript/);
    assert.equal(res.body, readRoot("theme-init.js"));
  } finally {
    await close();
  }
});

/** Ejecuta theme-init.js como script clásico en un contexto aislado con un navegador simulado. */
function runThemeInit({ stored, systemDark = false, storageThrows = false }) {
  const dataset = {};
  const sandbox = {
    localStorage: {
      getItem(key) {
        if (storageThrows) throw new Error("SecurityError");
        assert.equal(key, "postava.theme");
        return stored ?? null;
      },
    },
    matchMedia: (query) => {
      assert.equal(query, "(prefers-color-scheme: dark)");
      return { matches: systemDark };
    },
    document: { documentElement: { dataset } },
  };
  vm.runInNewContext(readRoot("theme-init.js"), sandbox);
  return { theme: dataset.theme, themePref: dataset.themePref };
}

test("theme-init.js conserva el comportamiento del script en línea que sustituye", () => {
  assert.deepEqual(runThemeInit({ stored: "dark" }), { theme: "dark", themePref: "dark" });
  assert.deepEqual(runThemeInit({ stored: "light", systemDark: true }), { theme: "light", themePref: "light" });
  assert.deepEqual(runThemeInit({ stored: "auto", systemDark: true }), { theme: "dark", themePref: "auto" });
  assert.deepEqual(runThemeInit({ stored: "auto", systemDark: false }), { theme: "light", themePref: "auto" });
  assert.deepEqual(runThemeInit({ systemDark: true }), { theme: "dark", themePref: "auto" });
  // Modo privado / almacenamiento bloqueado: automático, sin romper la carga de la página.
  assert.deepEqual(runThemeInit({ storageThrows: true, systemDark: true }), { theme: "dark", themePref: "auto" });
  assert.deepEqual(runThemeInit({ storageThrows: true }), { theme: "light", themePref: "auto" });
});

/* ── Frontend API de Clerk sin proxy ───────────────────────────────────────
   Con `proxyUrl` vacío clerk-js habla directo con el host de la clave pública
   (auth-adapter.js: `new Clerk(publishableKey, { proxyUrl })`) y la CSP debe permitirlo
   en connect-src. clerk-js va empaquetado por esbuild (mismo origen, 'self'), no carga
   nada de ese host con <script>, así que script-src y frame-src no se tocan. */

const publishableKey = (host, prefix = "pk_test_") => `${prefix}${Buffer.from(`${host}$`).toString("base64").replace(/=+$/, "")}`;
const DEV_KEY = publishableKey("foo-bar-13.clerk.accounts.dev");

test("clerkFrontendApiOrigin: https://<frontendApi> de la clave pública, solo cuando no hay proxy", () => {
  assert.equal(clerkFrontendApiOrigin({ publishableKey: DEV_KEY, proxyUrl: "" }), "https://foo-bar-13.clerk.accounts.dev");
  assert.equal(clerkFrontendApiOrigin({ publishableKey: DEV_KEY }), "https://foo-bar-13.clerk.accounts.dev");
  assert.equal(
    clerkFrontendApiOrigin({ publishableKey: publishableKey("clerk.example.com", "pk_live_"), proxyUrl: "" }),
    "https://clerk.example.com",
  );
  // Los hosts no distinguen mayúsculas: se normaliza a minúsculas.
  assert.equal(
    clerkFrontendApiOrigin({ publishableKey: publishableKey("Clerk.Example.COM", "pk_live_"), proxyUrl: "" }),
    "https://clerk.example.com",
  );
  // Con proxy (relativo o absoluto) el navegador solo habla con nuestro origen: no se añade nada.
  for (const proxyUrl of ["/api/__clerk", "https://app.example.com/api/__clerk"]) {
    assert.equal(clerkFrontendApiOrigin({ publishableKey: DEV_KEY, proxyUrl }), null, proxyUrl);
  }
  assert.equal(clerkFrontendApiOrigin(), null);
  assert.equal(clerkFrontendApiOrigin({}), null);
});

test("clerkFrontendApiOrigin: clave inválida o host derivado que no sea un nombre DNS estricto no añade nada", () => {
  const badKeys = [
    undefined, null, 42, "", "pk_test_", "pk_test_no-es-base64!", "pk_live_", "sk_test_00000000", "pk_dev_Zm9vLmJhci5jb20k",
    `pk_test_${Buffer.from("foo.example.com").toString("base64")}`, // sin el `$` final
    `pk_test_${Buffer.from("foo.exam$ple.com$").toString("base64")}`, // dos `$`
  ];
  for (const key of badKeys) assert.equal(clerkFrontendApiOrigin({ publishableKey: key, proxyUrl: "" }), null, String(key));

  const badHosts = [
    "*.clerk.accounts.dev", "*.evil.com", "evil.com/x", "evil.com:8080", "evil.com;script-src *", "a b.com", "evil.com\n.x.com",
    "evil_host.example.com", "-a.example.com", "a-.example.com", "a..example.com", ".example.com", "example.com.",
    "localhost", "1.2.3.4", "clerk.127.0.0.1", "example.123", "é.example.com", "x".repeat(64) + ".example.com", "https://evil.com",
    "user@evil.com", "evil.com#", "evil.com?", "evil.com%2f", "[::1].example.com",
  ];
  for (const host of badHosts) {
    assert.equal(clerkFrontendApiOrigin({ publishableKey: publishableKey(host), proxyUrl: "" }), null, host);
  }
});

test("buildContentSecurityPolicy: el origen de Clerk va solo a connect-src, y se descarta si no es un https://host estricto", () => {
  const origin = "https://clerk.example.com";
  for (const isProduction of [true, false]) {
    const csp = buildContentSecurityPolicy({ isProduction, clerkFrontendOrigin: origin });
    assert.ok(directive(csp, "connect-src").includes(origin));
    for (const name of ["script-src", "frame-src", "default-src", "img-src", "style-src", "font-src", "worker-src", "form-action"]) {
      assert.ok(!directive(csp, name).includes(origin), `${name} no debe llevar el origen`);
    }
    // El resto de connect-src se conserva.
    for (const kept of ["'self'", "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/", "https://storage.googleapis.com/mediapipe-models/", "https://clerk-telemetry.com"]) {
      assert.ok(directive(csp, "connect-src").includes(kept), kept);
    }
    assert.ok(!buildContentSecurityPolicy({ isProduction }).includes(origin));
  }

  const base = buildContentSecurityPolicy({ isProduction: true });
  for (const bad of [
    "", null, "clerk.example.com", "http://clerk.example.com", "https://*.example.com", "https://a.example.com/x",
    "https://a.example.com:444", "https://a.example.com; script-src *", "https://a.example.com https://evil.com", "https://LOCALHOST", "https://1.2.3.4",
    "*", "https:", "'unsafe-inline'",
  ]) {
    assert.equal(buildContentSecurityPolicy({ isProduction: true, clerkFrontendOrigin: bad }), base, String(bad));
  }
});

/** Fija variables de entorno solo mientras dura `run` (la CSP se calcula por petición) y las restaura siempre. */
async function withEnv(overrides, run) {
  const saved = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const connectSrcOf = (res) => directive(res.headers["content-security-policy"] ?? res.headers["content-security-policy-report-only"], "connect-src");
const cspOf = (res) => res.headers["content-security-policy"] ?? res.headers["content-security-policy-report-only"];

test("producción sin proxy: connect-src permite el host de la clave pública, y solo connect-src", async () => {
  await withEnv({ CLERK_PUBLISHABLE_KEY: DEV_KEY, VITE_CLERK_PROXY_URL: undefined }, async () => {
    const prod = await startServer({ nodeEnv: "production" });
    try {
      for (const path of ["/", "/api/auth/config", "/no-existe", "/theme-init.js"]) {
        const res = await get(prod.port, path);
        assert.ok(res.headers["content-security-policy"], path);
        assert.ok(connectSrcOf(res).includes("https://foo-bar-13.clerk.accounts.dev"), path);
        assert.ok(!directive(cspOf(res), "script-src").some((value) => value.includes("foo-bar-13")), `${path} script-src`);
        assert.ok(!directive(cspOf(res), "frame-src").some((value) => value.includes("foo-bar-13")), `${path} frame-src`);
      }
    } finally {
      await prod.close();
    }
  });
});

test("producción con proxy activo (VITE_CLERK_PROXY_URL): la CSP no cambia", async () => {
  const baseline = buildContentSecurityPolicy({ isProduction: true });
  await withEnv({ CLERK_PUBLISHABLE_KEY: DEV_KEY, VITE_CLERK_PROXY_URL: "/api/__clerk" }, async () => {
    const prod = await startServer({ nodeEnv: "production" });
    try {
      const res = await get(prod.port, "/");
      assert.equal(res.headers["content-security-policy"], baseline);
      assert.doesNotMatch(cspOf(res), /clerk\.accounts\.dev/);
    } finally {
      await prod.close();
    }
  });
});

test("producción sin proxy y con una clave pública inválida: la CSP no cambia y el sitio responde", async () => {
  const baseline = buildContentSecurityPolicy({ isProduction: true });
  for (const key of ["pk_test_no-es-una-clave", "pk_live_", "basura"]) {
    await withEnv({ CLERK_PUBLISHABLE_KEY: key, VITE_CLERK_PROXY_URL: undefined }, async () => {
      const prod = await startServer({ nodeEnv: "production" });
      try {
        const res = await get(prod.port, "/");
        assert.equal(res.status, 200, key);
        assert.equal(res.headers["content-security-policy"], baseline, key);
      } finally {
        await prod.close();
      }
    });
  }
});

test("clave pública de producción (o ausente): el host sale del host público de la petición, validado", async () => {
  await withEnv({ CLERK_PUBLISHABLE_KEY: undefined, VITE_CLERK_PROXY_URL: undefined }, async () => {
    const baseline = buildContentSecurityPolicy({ isProduction: true });
    const prod = await startServer({ nodeEnv: "production" });
    try {
      // Es la clave que /api/auth/config entrega al navegador para ese host: la CSP debe coincidir con ella.
      const host = "app.example.com";
      const config = JSON.parse((await get(prod.port, "/api/auth/config", { host: `${host}:5000` })).body);
      assert.equal(config.publishableKey, publishableKey(`clerk.${host}`, "pk_live_"));
      const res = await get(prod.port, "/", { host: `${host}:5000` });
      assert.ok(connectSrcOf(res).includes("https://clerk.app.example.com"));

      // Un Host que no sea un nombre DNS estricto nunca llega a la cabecera (inyección de directivas).
      // (`localhost` sí es un nombre DNS válido: derivaría https://clerk.localhost, que es lo que clerk-js contactaría.)
      for (const hostile of ["evil.com;script-src *", "a b.example.com", "evil.com/../x", "127.0.0.1", "127.0.0.1:5000"]) {
        const attempt = await get(prod.port, "/", { host: hostile });
        assert.equal(attempt.headers["content-security-policy"], baseline, hostile);
      }
    } finally {
      await prod.close();
    }
  });
});

test("desarrollo (Report-Only) también refleja el host de la clave pública cuando no hay proxy", async () => {
  await withEnv({ CLERK_PUBLISHABLE_KEY: DEV_KEY, VITE_CLERK_PROXY_URL: undefined }, async () => {
    const dev = await startServer({});
    try {
      const res = await get(dev.port, "/");
      assert.equal(res.headers["content-security-policy"], undefined);
      assert.ok(directive(res.headers["content-security-policy-report-only"], "connect-src").includes("https://foo-bar-13.clerk.accounts.dev"));
    } finally {
      await dev.close();
    }
  });
});

test("securityHeaders acepta un proveedor de origen que falla o devuelve basura sin romper la respuesta", () => {
  const headersWith = (clerkFrontendOrigin) => {
    const headers = new Map();
    securityHeaders({ isProduction: true, clerkFrontendOrigin })({}, { set: (name, value) => headers.set(name, value), vary: () => {} }, () => {});
    return headers.get("Content-Security-Policy");
  };
  const baseline = buildContentSecurityPolicy({ isProduction: true });
  assert.equal(headersWith(undefined), baseline);
  assert.equal(headersWith(() => null), baseline);
  assert.equal(headersWith(() => { throw new Error("sin host"); }), baseline);
  assert.equal(headersWith(() => "https://evil.com; script-src *"), baseline);
  assert.ok(directive(headersWith(() => "https://clerk.example.com"), "connect-src").includes("https://clerk.example.com"));
});

/* ── Vary: la CSP puede depender del Host ──────────────────────────────────────
   Sin proxy, la clave pública (y con ella el origen de Clerk en connect-src) sale del host público de la
   petición. Sin `Vary`, una caché podría servir la política de un host a otro; con un Host manipulado
   dejaría en la caché la política base, sin el origen de Clerk, y la página real dejaría de poder iniciar sesión. */

const varyValues = (res) => String(res.headers.vary ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);

test("securityHeaders: con un proveedor de origen que depende del host añade Vary: Host y X-Forwarded-Host", () => {
  const withProvider = headersFrom({ isProduction: true, clerkFrontendOrigin: () => "https://clerk.example.com" });
  assert.deepEqual(withProvider.vary, ["Host", "X-Forwarded-Host"]);
  const dev = headersFrom({ isProduction: false, clerkFrontendOrigin: () => null });
  assert.deepEqual(dev.vary, ["Host", "X-Forwarded-Host"], "también cuando esta petición no añade origen: la caché no lo sabe");

  // Sin proveedor la política es la misma para todos los hosts: nada que variar.
  assert.deepEqual(headersFrom({ isProduction: true }).vary, []);
  // El servidor puede decir que, para esta petición, la política no depende del host (hay proxy).
  assert.deepEqual(headersFrom({ isProduction: true, clerkFrontendOrigin: () => null, cspVariesByHost: () => false }).vary, []);
  // Un predicado que falla se trata como "varía": es el lado seguro.
  const failing = headersFrom({ isProduction: true, clerkFrontendOrigin: () => null, cspVariesByHost: () => { throw new Error("x"); } });
  assert.deepEqual(failing.vary, ["Host", "X-Forwarded-Host"]);
});

test("producción sin proxy: todas las respuestas llevan Vary: Host y X-Forwarded-Host, y cada host recibe su política", async () => {
  await withEnv({ CLERK_PUBLISHABLE_KEY: undefined, VITE_CLERK_PROXY_URL: undefined }, async () => {
    const prod = await startServer({ nodeEnv: "production" });
    try {
      for (const path of ["/", "/api/auth/config", "/no-existe", "/theme-init.js", "/stats"]) {
        const res = await get(prod.port, path, { host: "app.example.com" });
        assert.ok(varyValues(res).includes("host"), `${path}: ${res.headers.vary}`);
        assert.ok(varyValues(res).includes("x-forwarded-host"), `${path}: ${res.headers.vary}`);
      }
      const first = await get(prod.port, "/", { host: "app.example.com" });
      const second = await get(prod.port, "/", { host: "otra.example.org" });
      assert.ok(connectSrcOf(first).includes("https://clerk.app.example.com"));
      assert.ok(connectSrcOf(second).includes("https://clerk.otra.example.org"));
      assert.notEqual(cspOf(first), cspOf(second), "por eso la respuesta tiene que variar por host");
    } finally {
      await prod.close();
    }
  });
});

test("desarrollo sin proxy también avisa con Vary (Report-Only depende del host igual)", async () => {
  await withEnv({ CLERK_PUBLISHABLE_KEY: undefined, VITE_CLERK_PROXY_URL: undefined }, async () => {
    const dev = await startServer({});
    try {
      const res = await get(dev.port, "/", { host: "app.example.com" });
      assert.ok(res.headers["content-security-policy-report-only"]);
      assert.ok(varyValues(res).includes("host") && varyValues(res).includes("x-forwarded-host"), String(res.headers.vary));
    } finally {
      await dev.close();
    }
  });
});

test("producción con proxy activo: la CSP no cambia con el host y no hace falta Vary por host", async () => {
  const baseline = buildContentSecurityPolicy({ isProduction: true });
  await withEnv({ CLERK_PUBLISHABLE_KEY: undefined, VITE_CLERK_PROXY_URL: "/api/__clerk" }, async () => {
    const prod = await startServer({ nodeEnv: "production" });
    try {
      for (const host of ["app.example.com", "otra.example.org", "127.0.0.1"]) {
        const res = await get(prod.port, "/", { host });
        assert.equal(res.headers["content-security-policy"], baseline, host);
        assert.ok(!varyValues(res).includes("host"), `${host}: ${res.headers.vary}`);
        assert.ok(!varyValues(res).includes("x-forwarded-host"), `${host}: ${res.headers.vary}`);
      }
    } finally {
      await prod.close();
    }
  });
});
