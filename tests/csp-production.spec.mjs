import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Comprueba en un navegador real que la CSP ENFORCED de producción no bloquea la carga de
// MediaPipe (módulo de jsDelivr, WASM de jsDelivr y modelo de storage.googleapis.com).
// app.js llama a monitor.initEngine() al cargar la página, así que no hace falta cámara.
//
// Levanta su propio servidor con `--production` en un puerto libre (el servidor de playwright.config.mjs
// corre en desarrollo, con CSP Report-Only). SESSION_SECRET se genera al azar; Clerk se deja sin
// configurar a propósito (solo un aviso de arranque): no se crea ninguna cuenta ni se envía ningún correo.
// Requiere red real hacia jsDelivr y googleapis: sin ella el test se omite con motivo explícito.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MEDIAPIPE_URLS = [
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.js",
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
];

async function networkUnavailableReason() {
  for (const url of MEDIAPIPE_URLS) {
    try {
      const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
      if (!res.ok) return `${url} respondió ${res.status}`;
    } catch (error) {
      return `sin red hacia ${new URL(url).host} (${error.message})`;
    }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

let server;
let baseURL;
let skipReason = null;

test.beforeAll(async () => {
  skipReason = await networkUnavailableReason();
  if (skipReason) return;
  const port = await freePort();
  baseURL = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server.mjs", String(port), "--production"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "",
      SESSION_SECRET: randomBytes(48).toString("base64"),
      CLERK_SECRET_KEY: "",
      CLERK_PUBLISHABLE_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`el servidor no arrancó a tiempo:\n${output}`)), 25000);
    const onData = (chunk) => {
      output += chunk;
      if (/listening/i.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", (chunk) => (output += chunk));
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`el servidor terminó con código ${code}:\n${output}`));
    });
  });
});

test.afterAll(() => {
  server?.kill();
});

test("producción: la CSP enforced no bloquea MediaPipe (módulo, WASM y modelo)", async ({ page }) => {
  test.skip(Boolean(skipReason), `omitido: ${skipReason}`);
  test.setTimeout(90000);

  const consoleCspErrors = [];
  const engine = { ready: false, failed: false };
  const mediapipeRequests = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (/Content Security Policy|Content-Security-Policy/i.test(text)) consoleCspErrors.push(text);
    if (/motor de postura listo/i.test(text)) engine.ready = true;
    if (msg.type() === "error" && !/Failed to load resource/i.test(text)) engine.failed = true;
  });
  page.on("response", (res) => {
    const url = res.url();
    if (/jsdelivr|storage\.googleapis/.test(url)) mediapipeRequests.push({ url, status: res.status() });
  });
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspViolations.push({
        directive: e.violatedDirective,
        blocked: e.blockedURI,
        disposition: e.disposition,
      });
    });
  });

  const response = await page.goto(`${baseURL}/`);
  // Es producción de verdad: CSP enforced, no Report-Only.
  expect(response.headers()["content-security-policy"]).toContain("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14");
  expect(response.headers()["content-security-policy-report-only"]).toBeUndefined();

  // Espera a que el modelo termine de cargarse (o falle) sin sleeps fijos.
  await expect
    .poll(() => engine.ready || engine.failed, { timeout: 60000, message: "MediaPipe no terminó de inicializarse" })
    .toBe(true);

  const violations = await page.evaluate(() => window.__cspViolations);
  expect(violations, "violaciones de CSP").toEqual([]);
  expect(consoleCspErrors, "errores de CSP en consola").toEqual([]);
  expect(engine.failed, "MediaPipe falló al inicializarse").toBe(false);
  expect(engine.ready).toBe(true);
  expect(mediapipeRequests.some((r) => r.url.includes("jsdelivr") && r.status === 200)).toBe(true);
  expect(mediapipeRequests.some((r) => r.url.includes("pose_landmarker_lite.task") && r.status === 200)).toBe(true);
});
