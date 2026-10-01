// Contrato de playwright.config.mjs: cuándo se mockea Clerk (POSTAVA_MOCK_CLERK), cuándo se ignora el
// proxy del sistema (--no-proxy-server) y cuándo se reutiliza un servidor ya levantado. No arranca
// Playwright ni un navegador: solo importa la configuración con distintos entornos y comprueba lo que
// decide. Así, la lógica que decide si tests/auth-ui.spec.mjs mockea el proveedor tiene respaldo
// aunque los specs de UI no se ejecuten en esta máquina.
//
// Requiere la devDependency `@playwright/test` (el config la importa). Si falta, el primer test falla
// con un mensaje claro y el resto se omite con motivo explícito: nunca hay un verde silencioso.
import assert from "node:assert/strict";
import test from "node:test";

const PLAYWRIGHT_SPECIFIER = "@playwright/test";

/** null si `@playwright/test` se puede resolver; si no, el motivo del fallo. */
function playwrightUnavailableReason(specifier) {
  try {
    import.meta.resolve(specifier);
    return null;
  } catch (error) {
    return error.message;
  }
}

const playwrightMissing = playwrightUnavailableReason(PLAYWRIGHT_SPECIFIER);
/** Opciones de `test()` para los casos que necesitan importar el config real. */
const needsPlaywright = playwrightMissing
  ? { skip: `omitido: falta ${PLAYWRIGHT_SPECIFIER} (ver el primer test de este archivo)` }
  : {};

const ENV_KEYS = [
  "TEST_BASE_URL",
  "TEST_PORT",
  "TEST_REUSE_SERVER",
  "REPLIT_DEV_DOMAIN",
  "CHROMIUM_PATH",
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "SESSION_SECRET",
  "POSTAVA_MOCK_CLERK",
];

let importCounter = 0;

/** Importa una copia nueva de la configuración con exactamente `env` definido (el resto se borra). */
async function loadConfig(env = {}) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, env);
    const url = new URL("../playwright.config.mjs", import.meta.url);
    url.searchParams.set("case", String(++importCounter));
    const { default: config } = await import(url.href);
    return { config, mockClerk: process.env.POSTAVA_MOCK_CLERK };
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const FAKE_KEY = "pk_test_Y2xlcmsudGVzdC5pbnZhbGlkJA==";
const NO_PROXY = "--no-proxy-server";

test("@playwright/test (devDependency) está instalado", () => {
  assert.equal(
    playwrightMissing,
    null,
    `No se puede resolver ${PLAYWRIGHT_SPECIFIER}: instala las devDependencies (\`npm install\`, sin --omit=dev). ` +
      `Sin él no se puede comprobar el contrato de playwright.config.mjs. Motivo: ${playwrightMissing}`,
  );
});

test("la guardia de @playwright/test detecta un paquete inexistente", () => {
  const reason = playwrightUnavailableReason("@playwright/paquete-que-no-existe");
  assert.equal(typeof reason, "string", "un paquete inexistente debe producir un motivo de fallo, no null");
});

test("claves ficticias locales: se levanta el servidor y se mockea Clerk", needsPlaywright, async () => {
  const { config, mockClerk } = await loadConfig({ CHROMIUM_PATH: "chromium-de-prueba" });
  assert.equal(mockClerk, "1");
  assert.equal(config.webServer.env.CLERK_PUBLISHABLE_KEY, FAKE_KEY);
  assert.match(config.webServer.env.CLERK_SECRET_KEY, /^sk_test_placeholder/);
  assert.equal(config.use.baseURL, "http://127.0.0.1:5000");
});

test("TEST_PORT cambia el puerto local sin desactivar el mock", needsPlaywright, async () => {
  const { config, mockClerk } = await loadConfig({ TEST_PORT: "5123", CHROMIUM_PATH: "chromium-de-prueba" });
  assert.equal(mockClerk, "1");
  assert.equal(config.use.baseURL, "http://127.0.0.1:5123");
  assert.match(config.webServer.command, /server\.mjs 5123$/);
});

test("TEST_BASE_URL: no se arranca servidor local y se usa el proveedor real", needsPlaywright, async () => {
  const { config, mockClerk } = await loadConfig({ TEST_BASE_URL: "http://127.0.0.1:9999" });
  assert.equal(mockClerk, "0");
  assert.equal(config.webServer, undefined);
  assert.equal(config.use.baseURL, "http://127.0.0.1:9999");
});

test("Replit (REPLIT_DEV_DOMAIN): proveedor real, sin servidor local y URL pública", needsPlaywright, async () => {
  const { config, mockClerk } = await loadConfig({ REPLIT_DEV_DOMAIN: "postava.example.repl.co" });
  assert.equal(mockClerk, "0");
  assert.equal(config.webServer, undefined);
  assert.equal(config.use.baseURL, "https://postava.example.repl.co");
});

test("CLERK_PUBLISHABLE_KEY y CLERK_SECRET_KEY propias (desarrollo): se pasan al servidor y no se mockea", needsPlaywright, async () => {
  const { config, mockClerk } = await loadConfig({
    CLERK_PUBLISHABLE_KEY: "pk_test_clave-de-desarrollo-del-usuario",
    CLERK_SECRET_KEY: "sk_test_clave-de-desarrollo-del-usuario",
    CHROMIUM_PATH: "chromium-de-prueba",
  });
  assert.equal(mockClerk, "0");
  assert.equal(config.webServer.env.CLERK_PUBLISHABLE_KEY, "pk_test_clave-de-desarrollo-del-usuario");
  assert.equal(config.webServer.env.CLERK_SECRET_KEY, "sk_test_clave-de-desarrollo-del-usuario");
});

// 4a: el mock solo se activa si NO hay ninguna clave propia, ni la publicable ni la secreta.
for (const [name, env] of [
  ["solo CLERK_PUBLISHABLE_KEY propia", { CLERK_PUBLISHABLE_KEY: "pk_test_clave-de-desarrollo-del-usuario" }],
  ["solo CLERK_SECRET_KEY propia", { CLERK_SECRET_KEY: "sk_test_clave-de-desarrollo-del-usuario" }],
]) {
  test(`mock de Clerk desactivado con ${name}`, needsPlaywright, async () => {
    const { config, mockClerk } = await loadConfig({ ...env, CHROMIUM_PATH: "chromium-de-prueba" });
    assert.equal(mockClerk, "0", `con ${Object.keys(env)[0]} propia no debe mockearse (proveedor real)`);
    assert.ok(config.webServer, "sigue arrancándose el servidor local");
    // La clave que no se definió conserva su valor ficticio (par incompleto: el config pide definir ambas).
    if (!env.CLERK_PUBLISHABLE_KEY) assert.equal(config.webServer.env.CLERK_PUBLISHABLE_KEY, FAKE_KEY);
    if (!env.CLERK_SECRET_KEY) assert.match(config.webServer.env.CLERK_SECRET_KEY, /^sk_test_placeholder/);
  });
}

test("mock de Clerk: variables de claves vacías no cuentan como claves propias", needsPlaywright, async () => {
  const { mockClerk } = await loadConfig({ CLERK_PUBLISHABLE_KEY: "", CLERK_SECRET_KEY: "" });
  assert.equal(mockClerk, "1");
});

test("CHROMIUM_PATH tiene prioridad al elegir el navegador", needsPlaywright, async () => {
  const { config } = await loadConfig({ CHROMIUM_PATH: "C:\\ruta\\a\\otro-chromium.exe" });
  assert.equal(config.use.launchOptions.executablePath, "C:\\ruta\\a\\otro-chromium.exe");
});

// 4b: --no-proxy-server solo con URL base local; con servidor remoto o Replit el navegador necesita el proxy del sistema.
for (const [name, env] of [
  ["servidor local por defecto", {}],
  ["TEST_PORT local", { TEST_PORT: "5123" }],
  ["TEST_BASE_URL con localhost", { TEST_BASE_URL: "http://localhost:3000" }],
  ["TEST_BASE_URL con 127.0.0.1", { TEST_BASE_URL: "http://127.0.0.1:9999" }],
  ["TEST_BASE_URL con ::1", { TEST_BASE_URL: "http://[::1]:8080" }],
]) {
  test(`--no-proxy-server se aplica con URL base local: ${name}`, needsPlaywright, async () => {
    const { config } = await loadConfig({ ...env, CHROMIUM_PATH: "chromium-de-prueba" });
    const args = config.use.launchOptions.args;
    assert.ok(args.includes(NO_PROXY), `falta ${NO_PROXY} con baseURL ${config.use.baseURL}: ${args}`);
    assert.ok(args.includes("--no-sandbox"), "--no-sandbox se mantiene");
  });
}

for (const [name, env] of [
  ["TEST_BASE_URL remoto (https)", { TEST_BASE_URL: "https://staging.example.com" }],
  ["TEST_BASE_URL en una IP de la red local", { TEST_BASE_URL: "http://192.168.1.10:5000" }],
  ["dominio que solo empieza por localhost", { TEST_BASE_URL: "https://localhost.evil.example" }],
  ["dominio que solo empieza por 127.0.0.1", { TEST_BASE_URL: "http://127.0.0.1.nip.io:5000" }],
  ["TEST_BASE_URL que no es una URL", { TEST_BASE_URL: "esto no es una url" }],
  ["Replit", { REPLIT_DEV_DOMAIN: "postava.example.repl.co" }],
]) {
  test(`--no-proxy-server NO se aplica con URL base remota: ${name}`, needsPlaywright, async () => {
    const { config } = await loadConfig({ ...env, CHROMIUM_PATH: "chromium-de-prueba" });
    const args = config.use.launchOptions.args;
    assert.ok(!args.includes(NO_PROXY), `${NO_PROXY} no debe usarse con baseURL ${config.use.baseURL}: ${args}`);
    assert.ok(args.includes("--no-sandbox"), "--no-sandbox se mantiene");
  });
}

// 4c: reuseExistingServer solo con TEST_REUSE_SERVER=1 explícito.
test("reuseExistingServer es false por defecto (no se reutiliza un servidor ajeno)", needsPlaywright, async () => {
  const { config } = await loadConfig({ CHROMIUM_PATH: "chromium-de-prueba" });
  assert.equal(config.webServer.reuseExistingServer, false);
});

test("TEST_REUSE_SERVER=1 activa reuseExistingServer de forma explícita", needsPlaywright, async () => {
  const { config } = await loadConfig({ TEST_REUSE_SERVER: "1", CHROMIUM_PATH: "chromium-de-prueba" });
  assert.equal(config.webServer.reuseExistingServer, true);
});

for (const value of ["0", "", "true", "yes", "2"]) {
  test(`TEST_REUSE_SERVER=${JSON.stringify(value)} no activa la reutilización (solo "1")`, needsPlaywright, async () => {
    const { config } = await loadConfig({ TEST_REUSE_SERVER: value, CHROMIUM_PATH: "chromium-de-prueba" });
    assert.equal(config.webServer.reuseExistingServer, false);
  });
}

test("TEST_REUSE_SERVER=1 no cambia la decisión del mock ni arranca servidor con TEST_BASE_URL", needsPlaywright, async () => {
  const sinClaves = await loadConfig({ TEST_REUSE_SERVER: "1", CHROMIUM_PATH: "chromium-de-prueba" });
  assert.equal(sinClaves.mockClerk, "1", "con un servidor reutilizado y sin claves propias el mock sigue activo");

  const conClaves = await loadConfig({
    TEST_REUSE_SERVER: "1",
    CLERK_SECRET_KEY: "sk_test_clave-de-desarrollo-del-usuario",
    CHROMIUM_PATH: "chromium-de-prueba",
  });
  assert.equal(conClaves.mockClerk, "0");

  const remoto = await loadConfig({ TEST_REUSE_SERVER: "1", TEST_BASE_URL: "https://staging.example.com" });
  assert.equal(remoto.config.webServer, undefined);
  assert.equal(remoto.mockClerk, "0");
});
