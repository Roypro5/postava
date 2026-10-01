// Uso: `npm run test:ui` levanta `node server.mjs` en 127.0.0.1:5000 (puerto local libre).
//  - Servidor ya levantado / remoto: TEST_BASE_URL=https://host npm run test:ui (no arranca servidor local).
//  - Otro puerto local: TEST_PORT=5100 npm run test:ui.
//  - Otro Chromium/Chrome/Edge: CHROMIUM_PATH=/ruta/al/ejecutable npm run test:ui.
//  - Clerk de desarrollo: CLERK_PUBLISHABLE_KEY=pk_test_... CLERK_SECRET_KEY=sk_test_... (los tests
//    nunca crean cuentas ni disparan correos; ver "Decisiones de seguridad" más abajo).
//  - Reutilizar un servidor local ya levantado: TEST_REUSE_SERVER=1 (por defecto NO se reutiliza).
//
// Decisiones de seguridad (cubiertas por tests/playwright-config.test.mjs):
//  1. Mock de Clerk (POSTAVA_MOCK_CLERK=1, lo fija este archivo para tests/auth-ui.spec.mjs): solo con
//     servidor local Y sin CLERK_PUBLISHABLE_KEY NI CLERK_SECRET_KEY propias. Si el entorno define
//     cualquiera de las dos, o se usa TEST_BASE_URL o Replit, no hay mock y los tests de auth-ui que
//     abren login.html cargan el proveedor real (solo comprueban su inicialización y validaciones del
//     formulario: no crean cuentas ni envían correos). Con solo una de las dos claves, la otra
//     conserva su valor ficticio: define el par completo.
//  2. `--no-proxy-server` solo si la URL base es local (localhost, 127.0.0.1, ::1): evita que un proxy
//     corporativo intercepte el tráfico local, pero con TEST_BASE_URL remoto o en Replit el navegador
//     debe respetar el proxy del sistema para llegar al servidor.
//  3. `reuseExistingServer` es false salvo TEST_REUSE_SERVER=1: reutilizar sin avisar un servidor que
//     ya corra en el puerto (p. ej. un dev server con claves reales) haría que los specs se ejecuten
//     contra un servidor distinto del que este archivo arranca con valores ficticios. Si el puerto
//     está ocupado, Playwright falla con un mensaje claro: usa otro TEST_PORT o TEST_REUSE_SERVER=1 a
//     propósito. Con reutilización no se conocen las claves de ese servidor: el mock sigue activo
//     salvo que definas tus claves de desarrollo.
import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const onReplit = Boolean(process.env.REPLIT_DEV_DOMAIN);
const localPort = process.env.TEST_PORT || "5000";
const localBaseURL = `http://127.0.0.1:${localPort}`;

const baseURL =
  process.env.TEST_BASE_URL ||
  (onReplit ? `https://${process.env.REPLIT_DEV_DOMAIN}` : localBaseURL);

/** true si la URL apunta a esta máquina (localhost, 127.0.0.1 o ::1); una URL inválida cuenta como remota. */
function isLocalURL(url) {
  try {
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = onReplit
    ? ["/repl/tools/bin/chromium"]
    : [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "/usr/bin/chromium",
        "/usr/bin/google-chrome",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ];
  return candidates.find((path) => existsSync(path));
}

// Sin TEST_BASE_URL y fuera de Replit se levanta el servidor local.
const startLocalServer = !process.env.TEST_BASE_URL && !onReplit;

// Con las claves ficticias de abajo no hay proveedor real: los specs que dependen de la
// inicialización de Clerk (auth-ui) mockean /api/auth/config y el bundle del adaptador
// cuando POSTAVA_MOCK_CLERK=1. Con TEST_BASE_URL, Replit o cualquier clave de Clerk propia
// (publicable o secreta) se usa el proveedor real y esos specs comprueban su inicialización.
const hasOwnClerkKeys = Boolean(process.env.CLERK_PUBLISHABLE_KEY || process.env.CLERK_SECRET_KEY);
process.env.POSTAVA_MOCK_CLERK = startLocalServer && !hasOwnClerkKeys ? "1" : "0";

const browserArgs = ["--no-sandbox", ...(isLocalURL(baseURL) ? ["--no-proxy-server"] : [])];

export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.mjs",
  workers: 1,
  timeout: 45000,
  reporter: "list",
  use: {
    baseURL,
    launchOptions: { executablePath: findChromium(), args: browserArgs },
  },
  ...(startLocalServer && {
    webServer: {
      command: `node server.mjs ${localPort}`,
      url: localBaseURL,
      reuseExistingServer: process.env.TEST_REUSE_SERVER === "1",
      timeout: 30000,
      // Valores ficticios por defecto (apuntan a clerk.test.invalid): ningún test crea cuentas
      // ni envía correos. Los specs que necesitan un adaptador lo mockean con page.route.
      env: {
        SESSION_SECRET: process.env.SESSION_SECRET || "test-only-secret-not-for-production-use-0123456789",
        CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY || "sk_test_placeholder_not_a_real_key",
        CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY || "pk_test_Y2xlcmsudGVzdC5pbnZhbGlkJA==",
      },
    },
  }),
});
