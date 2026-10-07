import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createApp } from "../server.mjs";

// El SDK de Clerk envía telemetría a sus servidores con claves pk_test: en tests no debe salir nada a la red.
process.env.CLERK_TELEMETRY_DISABLED ??= "1";
process.env.CLERK_SECRET_KEY ??= "sk_test_00000000000000000000000000000000";
process.env.CLERK_PUBLISHABLE_KEY ??= `pk_test_${Buffer.from("test.clerk.accounts.dev$")
  .toString("base64")
  .replace(/=+$/, "")}`;

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
  });
}

async function withServer(run) {
  const server = createApp().listen(0);
  await once(server, "listening");
  try {
    await run(server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("los módulos del cliente registrados en la allowlist se sirven con 200", async () => {
  await withServer(async (port) => {
    for (const path of [
      "/app.js", "/dom.js", "/sound.js", "/camera-utils.js", "/camera.js", "/ui.js", "/notifications.js", "/posture.js",
      "/posture-monitor.js", "/settings.js", "/overlay.js", "/stats-math.js", "/stats-session.js",
      "/stats-queue.js", "/focus-stats.js", "/timer.js", "/theme.js", "/theme-init.js", "/heartbeat.js", "/tick-worker.js",
    ]) {
      assert.equal(await get(port, path), 200, path);
    }
    assert.equal(await get(port, "/server.mjs"), 404);
  });
});

/* ── Cierre transitivo de imports ──────────────────────────────────────────
   Si app.js (o cualquier módulo que importe) apunta a un archivo que la allowlist
   de server.mjs no sirve, el navegador recibe un 404 en producción y la página no
   arranca, pero los tests con imports de Node no lo notan. Aquí se recorren los
   imports reales de cada página y se piden al servidor de verdad. */

const ROOT = new URL("../", import.meta.url);
const PAGES = ["index.html", "login.html", "stats.html"];
// Se genera con esbuild al arrancar el servidor (y está en .gitignore): sin build no existe.
const GENERATED = new Set(["/assets/auth-adapter.bundle.js"]);

const readRoot = (path) => readFileSync(new URL(`.${path}`, ROOT), "utf8");

function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Imports propios (relativos o desde la raíz) de un módulo: estáticos, reexports y dinámicos con literal. */
const LOCAL_SPECIFIER = String.raw`((?:\.{1,2}/|/(?!/))[^"'\s]+)`;
const IMPORT_PATTERNS = [
  new RegExp(String.raw`\bimport\s+(?:[^"';]*?\sfrom\s*)?(["'])${LOCAL_SPECIFIER}\1`, "g"), // import x from "./y"; import "./y"
  new RegExp(String.raw`\bexport\s+[^"';]*?\sfrom\s*(["'])${LOCAL_SPECIFIER}\1`, "g"), // export * from "./y"
  new RegExp(String.raw`\bimport\(\s*(["'])${LOCAL_SPECIFIER}\1\s*\)`, "g"), // import("./y")
  new RegExp(String.raw`\bnew\s+(?:Shared)?Worker\(\s*new\s+URL\(\s*(["'])${LOCAL_SPECIFIER}\1`, "g"), // new Worker(new URL("./y", import.meta.url))
];

function localImports(source) {
  const code = stripJsComments(source);
  return IMPORT_PATTERNS.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[2]));
}

/** Recursos locales que declara una página: <script src> y <link href> (se ignoran http(s)://, // y data:). */
function pageAssets(html) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, "");
  const refs = [
    ...[...clean.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]),
    ...[...clean.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]),
  ];
  return refs.filter((ref) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref));
}

const toPath = (specifier, from) => new URL(specifier, `http://localhost${from}`).pathname;

/** Recorre los imports de cada página; devuelve Map(path -> primera razón por la que se pide). */
function collectClosure() {
  const found = new Map();
  const queue = [];
  const add = (path, reason) => {
    if (found.has(path)) return;
    found.set(path, reason);
    queue.push(path);
  };
  for (const page of PAGES) {
    for (const ref of pageAssets(readRoot(`/${page}`))) add(toPath(ref, `/${page}`), `${page} (etiqueta)`);
  }
  while (queue.length) {
    const path = queue.shift();
    if (!path.endsWith(".js") || !existsSync(new URL(`.${path}`, ROOT))) continue;
    for (const specifier of localImports(readRoot(path))) add(toPath(specifier, path), `${path} (import)`);
  }
  return found;
}

test("el cierre transitivo de imports de las páginas se sirve entero con 200", async (t) => {
  const closure = collectClosure();
  const paths = [...closure.keys()];

  // Control de vacuidad: el recorrido debe llegar a los módulos conocidos de la app.
  for (const known of ["/app.js", "/dom.js", "/timer.js", "/posture-monitor.js", "/posture.js", "/stats-queue.js", "/stats-session.js", "/theme-init.js", "/heartbeat.js", "/tick-worker.js"]) {
    assert.ok(closure.has(known), `el recorrido no llegó a ${known}: ¿cambió el regex de imports?`);
  }
  assert.ok(paths.length >= 15, `se esperaban >= 15 recursos y hay ${paths.length}`);

  await withServer(async (port) => {
    for (const path of paths) {
      if (GENERATED.has(path) && !existsSync(new URL(`.${path}`, ROOT))) {
        t.diagnostic(`${path} no se comprueba: se genera con esbuild al arrancar el servidor`);
        continue;
      }
      assert.equal(
        await get(port, path),
        200,
        `${path} lo pide ${closure.get(path)} pero el servidor no lo sirve (¿falta en la allowlist de server.mjs?)`,
      );
    }
  });
});

test("el servidor no expone código de servidor, manifiestos, pruebas ni documentación", async () => {
  await withServer(async (port) => {
    for (const path of [
      "/server.mjs", "/package.json", "/package-lock.json", "/server/stats-store.mjs", "/CLAUDE.md",
      "/tests/timer.test.mjs", "/playwright.config.mjs", "/.env", "/../server.mjs", "/node_modules/express/package.json",
    ]) {
      assert.equal(await get(port, path), 404, path);
    }
  });
});

test("el recorrido de imports detecta módulos ausentes de la allowlist (control del propio test)", () => {
  const sample = `
    import a from "./uno.js";
    import { b } from "/dos.js";
    import {
      c,
    } from "../tres.js";
    export * from "./cuatro.js";
    const lazy = () => import("./cinco.js");
    const w = new Worker(new URL("./seis.js", import.meta.url), { type: "module" });
    import { cdn } from "https://cdn.example.com/x.js";
    // import ignored from "./comentado.js";
  `;
  assert.deepEqual(localImports(sample).sort(), ["../tres.js", "./cinco.js", "./cuatro.js", "./seis.js", "./uno.js", "/dos.js"]);
  assert.deepEqual(
    pageAssets(`<link rel="stylesheet" href="a.css"><script src="https://x/y.js"></script><script type="module" src="/b.js"></script>`),
    ["/b.js", "a.css"],
  );
});
