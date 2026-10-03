import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  MIN_SESSION_SECRET_BYTES,
  MIN_SESSION_SECRET_DISTINCT_CHARS,
  applyProductionMode,
  checkStartupConfig,
  isLowEntropySessionSecret,
} from "../server/startup-config.mjs";

// Ninguna de estas pruebas usa claves reales: los valores de Clerk son marcadores inertes y el único
// proceso que se lanza (un servidor que debe negarse a arrancar) termina solo sin escuchar en ningún puerto.

// 32 bytes con variedad de sobra (un secreto "s".repeat(32) mide lo mismo pero ya no vale: ver la prueba de entropía).
const GOOD_SECRET = "Xk3-9fQmZ2vB8rLwT5nYc7HdJ4pAeU1s";
const CLERK_KEY = "sk_test_placeholder_not_a_real_key";

test("el mínimo del secreto de sesión son 32 bytes", () => {
  assert.equal(MIN_SESSION_SECRET_BYTES, 32);
  assert.equal(Buffer.byteLength(GOOD_SECRET, "utf8"), MIN_SESSION_SECRET_BYTES, "GOOD_SECRET mide justo el mínimo");
});

test("producción con la configuración correcta arranca sin errores ni avisos", () => {
  const result = checkStartupConfig({
    env: { NODE_ENV: "production", SESSION_SECRET: GOOD_SECRET, CLERK_SECRET_KEY: CLERK_KEY },
  });
  assert.deepEqual(result, { errors: [], warnings: [] });
});

test("producción: SESSION_SECRET ausente, vacío o de menos de 32 bytes es un error que impide arrancar", () => {
  for (const secret of [undefined, "", "corto", "s".repeat(MIN_SESSION_SECRET_BYTES - 1)]) {
    const { errors } = checkStartupConfig({
      env: { NODE_ENV: "production", SESSION_SECRET: secret, CLERK_SECRET_KEY: CLERK_KEY },
    });
    assert.equal(errors.length, 1, JSON.stringify(secret));
    assert.match(errors[0], /SESSION_SECRET/);
    assert.match(errors[0], /32/);
  }
  // Exactamente 32 bytes (con variedad) vale.
  assert.deepEqual(
    checkStartupConfig({
      env: { NODE_ENV: "production", SESSION_SECRET: GOOD_SECRET, CLERK_SECRET_KEY: CLERK_KEY },
    }).errors,
    [],
  );
});

test("la longitud se mide en bytes, no en caracteres", () => {
  const env = (SESSION_SECRET) => ({ NODE_ENV: "production", SESSION_SECRET, CLERK_SECRET_KEY: CLERK_KEY });
  // Cada letra acentuada ocupa 2 bytes en UTF-8: 16 caracteres distintos = 32 bytes (vale), 15 = 30 bytes (no vale).
  assert.deepEqual(checkStartupConfig({ env: env("ñáéíóúüçàèìòùâêî") }).errors, []);
  assert.equal(checkStartupConfig({ env: env("ñáéíóúüçàèìòùâê") }).errors.length, 1);
});

test("fuera de producción un secreto ausente o corto solo genera un aviso", () => {
  for (const nodeEnv of [undefined, "development", "test"]) {
    for (const secret of [undefined, "corto"]) {
      const result = checkStartupConfig({ env: { NODE_ENV: nodeEnv, SESSION_SECRET: secret } });
      assert.deepEqual(result.errors, [], `${nodeEnv}/${secret}`);
      assert.equal(result.warnings.length, 1, `${nodeEnv}/${secret}`);
      assert.match(result.warnings[0], /SESSION_SECRET/);
    }
    // Y con un secreto válido, ni siquiera el aviso; tampoco se avisa de CLERK_SECRET_KEY en desarrollo.
    assert.deepEqual(checkStartupConfig({ env: { NODE_ENV: nodeEnv, SESSION_SECRET: GOOD_SECRET } }), {
      errors: [],
      warnings: [],
    });
  }
});

test("producción sin CLERK_SECRET_KEY avisa (el proxy de Clerk queda desactivado) pero no impide arrancar", () => {
  const { errors, warnings } = checkStartupConfig({
    env: { NODE_ENV: "production", SESSION_SECRET: GOOD_SECRET },
  });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /CLERK_SECRET_KEY/);
  assert.match(warnings[0], /__clerk/);
  // El texto describe lo que de verdad pasa (ver tests/server-no-clerk.test.mjs): rutas de cuenta cerradas, resto operativo.
  assert.match(warnings[0], /\/api\/stats/);
  assert.match(warnings[0], /503 AUTH_UNAVAILABLE/);
  assert.doesNotMatch(warnings[0], /\b401\b|redirect/);
  assert.match(warnings[0], /keeps working without accounts/);
  assert.doesNotMatch(warnings[0], /unaffected/);

  // Una clave vacía o en blanco cuenta como no configurada, igual que en server.mjs y en el proxy de Clerk.
  for (const blank of ["", " ", "   ", "\n", "\t \n"]) {
    const result = checkStartupConfig({
      env: { NODE_ENV: "production", SESSION_SECRET: GOOD_SECRET, CLERK_SECRET_KEY: blank },
    });
    assert.equal(result.warnings.length, 1, JSON.stringify(blank));
  }
});

/* ── Secretos de ejemplo del repositorio ─────────────────────────────────────
   .claude/launch.json, playwright.config.mjs y los tests llevan SESSION_SECRET de ejemplo que superan
   los 32 bytes. Son públicos (están en el repositorio): con ellos cualquiera falsificaría la cookie de
   presencia, así que en producción no valen aunque cumplan la longitud. */

const ROOT = new URL("../", import.meta.url);

/** Los valores de ejemplo reales que hay en el repo, leídos de sus archivos para que este test no se quede atrás. */
function exampleSecretsInRepo() {
  const found = new Map();
  const launch = new URL(".claude/launch.json", ROOT);
  if (existsSync(launch)) {
    for (const configuration of JSON.parse(readFileSync(launch, "utf8")).configurations ?? []) {
      if (configuration.env?.SESSION_SECRET) found.set(".claude/launch.json", configuration.env.SESSION_SECRET);
    }
  }
  const playwright = readFileSync(new URL("playwright.config.mjs", ROOT), "utf8");
  const fromPlaywright = playwright.match(/SESSION_SECRET:\s*process\.env\.SESSION_SECRET \|\| "([^"]+)"/)?.[1];
  if (fromPlaywright) found.set("playwright.config.mjs", fromPlaywright);
  const fromTests = readFileSync(new URL("tests/server-auth.test.mjs", ROOT), "utf8").match(/const secret = "([^"]+)"/)?.[1];
  if (fromTests) found.set("tests/server-auth.test.mjs", fromTests);
  return found;
}

test("producción rechaza como SESSION_SECRET los valores de ejemplo del repositorio aunque midan 32 bytes o más", () => {
  const examples = exampleSecretsInRepo();
  assert.ok(examples.size >= 2, `se esperaban valores de ejemplo en el repo y hay ${examples.size}: ¿cambió su ubicación?`);

  for (const [origin, secret] of examples) {
    assert.ok(Buffer.byteLength(secret, "utf8") >= MIN_SESSION_SECRET_BYTES, `${origin}: el ejemplo ya supera la longitud mínima`);
    const { errors, warnings } = checkStartupConfig({
      env: { NODE_ENV: "production", SESSION_SECRET: secret, CLERK_SECRET_KEY: CLERK_KEY },
    });
    assert.equal(errors.length, 1, origin);
    assert.match(errors[0], /SESSION_SECRET/, origin);
    assert.match(errors[0], /example/i, origin);
    assert.match(errors[0], /openssl rand/, "el mensaje dice cómo generar uno bueno");
    assert.ok(!errors[0].includes(secret), `${origin}: el mensaje no debe imprimir el valor`);
    assert.deepEqual(warnings, [], origin);
  }
});

test("las variantes evidentes de esos valores (marcadores de ejemplo) también se rechazan en producción", () => {
  const variants = [
    `test-only-secret-${"x".repeat(32)}`,
    `DEV-ONLY-SECRET-${"y".repeat(32)}`,
    `algo-not-for-production-${"z".repeat(32)}`,
    `changeme${"0".repeat(40)}`,
    `${"a".repeat(20)}-change-me-${"b".repeat(20)}`,
  ];
  for (const secret of variants) {
    const { errors } = checkStartupConfig({ env: { NODE_ENV: "production", SESSION_SECRET: secret, CLERK_SECRET_KEY: CLERK_KEY } });
    assert.equal(errors.length, 1, secret);
    assert.ok(!errors[0].includes(secret));
  }
});

test("fuera de producción los secretos de ejemplo siguen valiendo, sin aviso (launch.json y Playwright los usan)", () => {
  for (const [origin, secret] of exampleSecretsInRepo()) {
    for (const nodeEnv of [undefined, "development", "test"]) {
      assert.deepEqual(
        checkStartupConfig({ env: { NODE_ENV: nodeEnv, SESSION_SECRET: secret } }),
        { errors: [], warnings: [] },
        `${origin} / ${nodeEnv}`,
      );
    }
  }
});

test("un secreto aleatorio o de 32 bytes cualquiera no cae en la lista de ejemplos (sin falsos positivos)", () => {
  for (let i = 0; i < 300; i++) {
    const secret = randomBytes(48).toString("base64");
    assert.deepEqual(
      checkStartupConfig({ env: { NODE_ENV: "production", SESSION_SECRET: secret, CLERK_SECRET_KEY: CLERK_KEY } }).errors,
      [],
      secret,
    );
  }
  assert.deepEqual(checkStartupConfig({ env: { NODE_ENV: "production", SESSION_SECRET: GOOD_SECRET, CLERK_SECRET_KEY: CLERK_KEY } }).errors, []);

  // Los formatos habituales de `openssl rand` y equivalentes, con la longitud justa y con más.
  for (let i = 0; i < 300; i++) {
    for (const secret of [randomBytes(16).toString("hex"), randomBytes(24).toString("base64"), randomBytes(32).toString("hex"), randomBytes(32).toString("base64url")]) {
      assert.equal(isLowEntropySessionSecret(secret), false, secret);
    }
  }
});

/* ── Entropía mínima ────────────────────────────────────────────────────────────
   Medir 32 bytes no basta: "s".repeat(32) los cumple. En producción se rechazan los secretos con menos de
   MIN_SESSION_SECRET_DISTINCT_CHARS caracteres distintos y los que son un patrón corto repetido. */

const LOW_ENTROPY = {
  "un carácter repetido (32)": "s".repeat(32),
  "un carácter repetido (200)": "0".repeat(200),
  "dos caracteres alternados": "ab".repeat(20),
  "siete caracteres distintos, sin patrón": "gfedcbagfedcbagfedcbabcdefgabcdefggggfabcde",
  "ocho caracteres repetidos en bloque (12345678 x 4)": "12345678".repeat(4),
  "una frase repetida": "correct-horse-battery-staple-".repeat(2),
  "un carácter no ASCII repetido": "ñ".repeat(20),
};

test("el mínimo de caracteres distintos es 8", () => {
  assert.equal(MIN_SESSION_SECRET_DISTINCT_CHARS, 8);
});

test("producción rechaza un SESSION_SECRET de longitud suficiente pero sin variedad, sin imprimir su valor", () => {
  for (const [label, secret] of Object.entries(LOW_ENTROPY)) {
    assert.ok(Buffer.byteLength(secret, "utf8") >= MIN_SESSION_SECRET_BYTES, `${label}: cumple la longitud, así que solo lo detiene la entropía`);
    const { errors, warnings } = checkStartupConfig({
      env: { NODE_ENV: "production", SESSION_SECRET: secret, CLERK_SECRET_KEY: CLERK_KEY },
    });
    assert.equal(errors.length, 1, label);
    assert.match(errors[0], /SESSION_SECRET/, label);
    assert.match(errors[0], /predictable/, label);
    assert.match(errors[0], /openssl rand/, `${label}: el mensaje dice cómo generar uno bueno`);
    assert.ok(!errors[0].includes(secret), `${label}: el mensaje no debe imprimir el valor`);
    assert.ok(!/\b\d{2,3} bytes\b/.test(errors[0]), `${label}: ni su longitud`);
    assert.deepEqual(warnings, [], label);
    assert.equal(isLowEntropySessionSecret(secret), true, label);
  }
});

test("fuera de producción un secreto sin variedad no molesta (launch.json, Playwright y los tests usan valores de ejemplo)", () => {
  for (const nodeEnv of [undefined, "development", "test"]) {
    assert.deepEqual(
      checkStartupConfig({ env: { NODE_ENV: nodeEnv, SESSION_SECRET: "s".repeat(32) } }),
      { errors: [], warnings: [] },
      String(nodeEnv),
    );
  }
});

test("con 8 caracteres distintos y sin patrón repetido ya vale (el límite es exacto)", () => {
  const eight = "abcdefghabcdefhgabcdegfhabcdgefhabdcefgh";
  assert.equal(new Set(eight).size, MIN_SESSION_SECRET_DISTINCT_CHARS);
  assert.equal(isLowEntropySessionSecret(eight), false);
  assert.equal(isLowEntropySessionSecret(`${eight}x`), false);
  assert.equal(isLowEntropySessionSecret("gfedcbagfedcbagfedcbabcdefgabcdefggggfabcde"), true, "7 distintos: no");
  // Un patrón repetido solo cuenta si cubre TODO el secreto.
  assert.equal(isLowEntropySessionSecret(`${"12345678".repeat(4)}9`), false);
});

test("la entropía se comprueba después de la longitud y de los ejemplos: cada secreto da un solo error, el más útil", () => {
  const env = (SESSION_SECRET) => ({ NODE_ENV: "production", SESSION_SECRET, CLERK_SECRET_KEY: CLERK_KEY });
  assert.match(checkStartupConfig({ env: env("s".repeat(10)) }).errors[0], /too short/);
  assert.match(checkStartupConfig({ env: env(`changeme${"0".repeat(40)}`) }).errors[0], /known example value/);
  assert.match(checkStartupConfig({ env: env("s".repeat(40)) }).errors[0], /too predictable/);
});

test("`node server.mjs` con NODE_ENV=production y un SESSION_SECRET de ejemplo sale con código 1 sin arrancar ni imprimirlo", () => {
  const [, example] = [...exampleSecretsInRepo()][0];
  const result = spawnSync(process.execPath, ["server.mjs", "54874"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: "production",
      SESSION_SECRET: example,
      CLERK_SECRET_KEY: CLERK_KEY,
      CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("test.clerk.accounts.dev$").toString("base64").replace(/=+$/, "")}`,
      CLERK_TELEMETRY_DISABLED: "1",
    },
    encoding: "utf8",
    // Red de seguridad: si el servidor arrancara de verdad, spawnSync termina este proceso hijo (solo el que lanzó).
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, `el proceso no debía quedarse en marcha: ${result.error}`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SESSION_SECRET is a known example value/);
  assert.match(result.stderr, /Refusing to start/);
  assert.doesNotMatch(result.stdout, /listening/);
  assert.ok(!result.stderr.includes(example), "no debe imprimir el valor del secreto");
});

test("los mensajes no revelan el valor del secreto", () => {
  const secret = "corto-pero-secreto";
  const { errors, warnings } = checkStartupConfig({
    env: { NODE_ENV: "production", SESSION_SECRET: secret },
  });
  for (const message of [...errors, ...warnings]) assert.ok(!message.includes(secret));
  assert.match(errors[0], /\b18 bytes\b/);
});

test("el modo producción se deduce de NODE_ENV cuando no se indica", () => {
  assert.equal(checkStartupConfig({ env: { NODE_ENV: "production" } }).errors.length, 1);
  assert.equal(checkStartupConfig({ env: {} }).errors.length, 0);
});

test("`node server.mjs` con NODE_ENV=production y un SESSION_SECRET corto sale con código 1 sin arrancar", () => {
  const result = spawnSync(process.execPath, ["server.mjs", "54873"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: "production",
      SESSION_SECRET: "corto",
      CLERK_SECRET_KEY: CLERK_KEY,
      CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("test.clerk.accounts.dev$").toString("base64").replace(/=+$/, "")}`,
      CLERK_TELEMETRY_DISABLED: "1",
    },
    encoding: "utf8",
    // Red de seguridad: si el servidor arrancara de verdad, spawnSync termina este proceso hijo (solo el que lanzó).
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, `el proceso no debía quedarse en marcha: ${result.error}`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SESSION_SECRET is too short/);
  assert.match(result.stderr, /Refusing to start/);
  assert.doesNotMatch(result.stdout, /listening/);
  assert.ok(!result.stderr.includes("corto"), "no debe imprimir el valor del secreto");
});

/* ── Modo producción: --production y REPLIT_DEPLOYMENT ───────────────────── */

test("applyProductionMode: --production fija NODE_ENV=production, también si venía otro valor", () => {
  for (const initial of [undefined, "", "  ", "production"]) {
    const env = initial === undefined ? {} : { NODE_ENV: initial };
    assert.deepEqual(applyProductionMode({ argv: ["5000", "--production"], env }), [], String(initial));
    assert.equal(env.NODE_ENV, "production", String(initial));
  }
});

test("applyProductionMode: --production sobre un NODE_ENV explícito distinto avisa del cambio", () => {
  for (const initial of ["development", "test"]) {
    const env = { NODE_ENV: initial };
    const warnings = applyProductionMode({ argv: ["--production"], env });
    assert.equal(warnings.length, 1, initial);
    assert.match(warnings[0], /--production overrides NODE_ENV=/);
    assert.ok(warnings[0].includes(JSON.stringify(initial)));
    assert.equal(env.NODE_ENV, "production");
  }
});

test("applyProductionMode: un argumento tipo flag no reconocido (--prod, -production) avisa y no activa producción", () => {
  for (const arg of ["--prod", "-production", "--productions", "--Production"]) {
    const env = {};
    const warnings = applyProductionMode({ argv: ["5000", arg], env });
    assert.equal(warnings.length, 1, arg);
    assert.match(warnings[0], /Unrecognized argument/);
    assert.ok(warnings[0].includes(JSON.stringify(arg)));
    assert.equal(env.NODE_ENV, undefined, "no debe activar producción");
  }
});

test("applyProductionMode: puerto y --production válidos no avisan; un typo junto a --production sí", () => {
  assert.deepEqual(applyProductionMode({ argv: ["5000", "--production"], env: {} }), []);
  const env = {};
  const warnings = applyProductionMode({ argv: ["--production", "--prod"], env });
  assert.equal(warnings.length, 1);
  assert.equal(env.NODE_ENV, "production");
});

test("applyProductionMode: sin flag ni despliegue de Replit no toca el entorno ni avisa", () => {
  for (const env of [{}, { NODE_ENV: "development" }, { REPLIT_DEPLOYMENT: "0" }, { REPLIT_DEPLOYMENT: "true" }]) {
    const before = { ...env };
    assert.deepEqual(applyProductionMode({ argv: ["5000"], env }), []);
    assert.deepEqual(env, before);
  }
});

test("applyProductionMode: REPLIT_DEPLOYMENT=1 sin NODE_ENV se trata como producción y avisa en voz alta", () => {
  for (const blank of [undefined, "", "  "]) {
    const env = { REPLIT_DEPLOYMENT: "1" };
    if (blank !== undefined) env.NODE_ENV = blank;
    const warnings = applyProductionMode({ argv: [], env });
    assert.equal(env.NODE_ENV, "production", JSON.stringify(blank));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /REPLIT_DEPLOYMENT=1/);
    assert.match(warnings[0], /PRODUCTION/);
  }
});

test("applyProductionMode: en un despliegue de Replit un NODE_ENV explícito se respeta (con aviso si no es production)", () => {
  const dev = { REPLIT_DEPLOYMENT: "1", NODE_ENV: "development" };
  const warnings = applyProductionMode({ argv: [], env: dev });
  assert.equal(dev.NODE_ENV, "development");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /WITHOUT production hardening/);

  const prod = { REPLIT_DEPLOYMENT: "1", NODE_ENV: "production" };
  assert.deepEqual(applyProductionMode({ argv: [], env: prod }), []);
  assert.equal(prod.NODE_ENV, "production");
});

test("package.json: start:prod arranca con --production y start sigue igual", () => {
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(scripts.start, "node server.mjs 5000");
  assert.match(scripts["start:prod"], /^node server\.mjs \d+ --production$/);
});

/** Lanza `node server.mjs` con un secreto débil: si el modo producción está activo debe salir con 1 sin escuchar. */
function runWeakSecretServer(args, env) {
  const cleanEnv = { ...process.env, SESSION_SECRET: "corto", CLERK_SECRET_KEY: CLERK_KEY, CLERK_TELEMETRY_DISABLED: "1" };
  delete cleanEnv.NODE_ENV;
  delete cleanEnv.REPLIT_DEPLOYMENT;
  return spawnSync(process.execPath, ["server.mjs", ...args], {
    cwd: new URL("../", import.meta.url),
    env: { ...cleanEnv, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("`node server.mjs <puerto> --production` (y con el flag primero) activa producción: un secreto débil impide arrancar", () => {
  for (const args of [["54871", "--production"], ["--production", "54871"]]) {
    const result = runWeakSecretServer(args, {});
    assert.equal(result.error, undefined, `${args}: ${result.error}`);
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /SESSION_SECRET is too short/);
    assert.match(result.stderr, /Refusing to start/);
    assert.doesNotMatch(result.stdout, /listening/);
  }
});

test("`node server.mjs` con REPLIT_DEPLOYMENT=1 y sin NODE_ENV avisa y aplica las comprobaciones de producción", () => {
  const result = runWeakSecretServer(["54872"], { REPLIT_DEPLOYMENT: "1" });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /REPLIT_DEPLOYMENT=1 and NODE_ENV is not set/);
  assert.match(result.stderr, /SESSION_SECRET is too short/);
  assert.doesNotMatch(result.stdout, /listening/);
});
