// Contrato de versión de Node: app-wiring.test.mjs necesita `module.registerHooks`
// (Node >= 22.15) y, sin él, se OMITE en silencio, con lo que la regla 2 de AGENTS.md
// (tests sin cuentas reales, con un adaptador simulado) quedaría sin respaldo y `npm test`
// seguiría en verde. Estas pruebas hacen ruidosa esa situación y verifican package.json (`engines`).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import nodeModule from "node:module";
import test from "node:test";

const readProjectFile = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const pkg = JSON.parse(readProjectFile("package.json"));

/** Interpreta un rango simple `>=X[.Y[.Z]]` como [X, Y, Z]; devuelve null si el formato no es ese. */
function parseMinimum(range) {
  const match = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(range).trim());
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
}

/** true si `version` >= `minimum` (ambos como [major, minor, patch]). */
function atLeast(version, minimum) {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== minimum[i]) return version[i] > minimum[i];
  }
  return true;
}

test("package.json declara engines.node como '>=X.Y' analizable", () => {
  assert.equal(typeof pkg.engines?.node, "string", "falta engines.node en package.json");
  assert.notEqual(
    parseMinimum(pkg.engines.node),
    null,
    `engines.node debe tener la forma ">=X.Y", no ${JSON.stringify(pkg.engines.node)}`,
  );
});

test("engines.node exige al menos Node 22.15 (module.registerHooks)", () => {
  const minimum = parseMinimum(pkg.engines?.node ?? "");
  assert.ok(minimum, "engines.node ausente o con formato no soportado");
  assert.ok(
    atLeast(minimum, [22, 15, 0]),
    `engines.node (${pkg.engines.node}) permite versiones sin module.registerHooks; app-wiring.test.mjs se omitiría`,
  );
});

test("el Node en ejecución cumple engines.node", () => {
  const minimum = parseMinimum(pkg.engines?.node ?? "");
  assert.ok(minimum, "engines.node ausente o con formato no soportado");
  const running = process.versions.node.split(".").map(Number);
  assert.ok(
    atLeast(running, minimum),
    `Node ${process.versions.node} no cumple engines.node (${pkg.engines.node}). Actualiza Node antes de fiarte de \`npm test\`.`,
  );
});

test("module.registerHooks existe: app-wiring.test.mjs no se omite en silencio", () => {
  assert.equal(
    typeof nodeModule.registerHooks,
    "function",
    `Node ${process.versions.node} no tiene module.registerHooks (>= 22.15): tests/app-wiring.test.mjs ` +
      "se OMITE y el cableado real de app.js queda sin verificar. Usa Node >= 22.15.",
  );
});
