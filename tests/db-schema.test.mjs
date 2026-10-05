import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import {
  MAX_ALERTS,
  MAX_DURATION_MINUTES,
  MAX_USER_ID_LENGTH,
  MIN_DURATION_MINUTES,
} from "../server/stats-store.mjs";

// El esquema versionado (db/) se DEDUJO del código; este test mantiene ambos
// alineados y vigila la regla 6 (cero DDL en el arranque). Sin base de datos.

const root = (path) => new URL(`../${path}`, import.meta.url);
const read = (path) => readFileSync(root(path), "utf8");

const schema = read("db/schema.sql").replace(/--.*$/gm, "");
const migration = read("db/migrations/0001_initial.sql");

function tableBody(sql) {
  const start = sql.search(/CREATE TABLE posture_stats_sessions\s*\(/);
  assert.ok(start >= 0, "falta CREATE TABLE posture_stats_sessions");
  const open = sql.indexOf("(", start);
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    if (sql[i] === ")" && --depth === 0) return sql.slice(open + 1, i);
  }
  throw new Error("CREATE TABLE sin cerrar");
}

// Divide por comas de nivel superior y normaliza espacios.
function definitions(body) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.map((part) => part.replace(/\s+/g, " "));
}

const defs = definitions(tableBody(schema));
const columns = new Map(
  defs
    .filter((def) => !/^(PRIMARY KEY|UNIQUE|CHECK|CONSTRAINT)/i.test(def))
    .map((def) => [def.split(" ")[0], def]),
);

test("la tabla declara todas las columnas que usan las consultas de stats-store", () => {
  const source = read("server/stats-store.mjs");
  const used = ["user_id", "session_id", "started_at", "duration_minutes", "good_ms", "bad_ms", "issues", "issues_unit", "alerts"];
  for (const name of used) {
    assert.ok(columns.has(name), `falta la columna ${name}`);
    assert.ok(source.includes(name), `${name} ya no se usa en stats-store.mjs: actualiza el test y el esquema`);
  }
  assert.deepEqual([...columns.keys()].sort(), [...used, "created_at"].sort());
});

test("tipos nativos y NOT NULL", () => {
  const type = (name) => columns.get(name).split(" ")[1];
  assert.equal(type("user_id"), "text");
  assert.equal(type("session_id"), "uuid");
  assert.equal(type("started_at"), "timestamptz");
  assert.equal(type("duration_minutes"), "smallint");
  assert.equal(type("good_ms"), "integer");
  assert.equal(type("bad_ms"), "integer");
  assert.equal(type("issues"), "jsonb");
  assert.equal(type("alerts"), "integer");
  assert.equal(type("created_at"), "timestamptz");
  for (const [name, def] of columns) assert.match(def, /NOT NULL/, name);
  assert.match(columns.get("created_at"), /DEFAULT now\(\)/);
});

test("clave primaria (user_id, session_id): la deduplicación por cuenta y sesión", () => {
  assert.ok(defs.some((def) => /^PRIMARY KEY \(user_id, session_id\)$/i.test(def)));
  // ON CONFLICT (user_id, session_id) de saveSession necesita justo esa restricción.
  assert.match(read("server/stats-store.mjs"), /ON CONFLICT \(user_id, session_id\) DO NOTHING/);
});

test("índice (user_id, started_at) para lecturas y límite diario", () => {
  assert.match(schema, /CREATE INDEX \w+\s+ON posture_stats_sessions \(user_id, started_at\);/);
});

test("los CHECK coinciden con las constantes de validación de stats-store", () => {
  assert.match(columns.get("user_id"), new RegExp(`char_length\\(user_id\\) BETWEEN 1 AND ${MAX_USER_ID_LENGTH}\\)`));
  assert.match(columns.get("duration_minutes"), new RegExp(`BETWEEN ${MIN_DURATION_MINUTES} AND ${MAX_DURATION_MINUTES}\\)`));
  assert.match(columns.get("alerts"), new RegExp(`BETWEEN 0 AND ${MAX_ALERTS}\\)`));
  assert.match(columns.get("good_ms"), /CHECK \(good_ms >= 0\)/);
  assert.match(columns.get("bad_ms"), /CHECK \(bad_ms >= 0\)/);
  assert.match(columns.get("issues"), /jsonb_typeof\(issues\) = 'object'/);
  assert.match(columns.get("issues_unit"), /IN \('count', 'milliseconds'\)/);
  assert.ok(defs.some((def) => /^CHECK \(good_ms \+ bad_ms <= duration_minutes \* 60000\)$/.test(def)));
});

test("la migración 0001 crea lo mismo que schema.sql y trae Down", () => {
  const normalize = (sql) => sql.replace(/--.*$/gm, "").replace(/\s+/g, " ");
  const up = normalize(migration.slice(0, migration.indexOf("===== Down")));
  const upSql = normalize(migration.slice(0, migration.indexOf("===== Down")));
  for (const def of defs) assert.ok(upSql.includes(def), `la migración no contiene: ${def}`);
  assert.match(up, /CREATE INDEX posture_stats_sessions_user_started_idx ON posture_stats_sessions \(user_id, started_at\)/);
  assert.match(migration, /-- DROP TABLE IF EXISTS posture_stats_sessions;/);
});

test("regla 6: ni server.mjs ni server/*.mjs contienen DDL", () => {
  const files = ["server.mjs", ...readdirSync(root("server")).filter((f) => f.endsWith(".mjs")).map((f) => `server/${f}`)];
  assert.ok(files.length > 3);
  for (const file of files) {
    assert.doesNotMatch(read(file), /\b(CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)|ALTER\s+TABLE|DROP\s+TABLE)\b/i, file);
  }
});
