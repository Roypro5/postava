import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createStatsHandlers, createStatsPool, describeDbError, poolConfig } from "../server/stats-store.mjs";

// Ninguna de estas pruebas abre una conexión: el Pool de pg solo conecta al ejecutar la primera consulta,
// y aquí se inyecta una clase falsa o se crea el Pool real sin pedirle nada (y se cierra).

test("el Pool se crea con límites razonables por defecto", () => {
  assert.deepEqual(poolConfig({}), {
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 15_000,
  });
});

test("cada límite se puede sobrescribir por entorno; los valores inválidos vuelven al defecto", () => {
  assert.deepEqual(
    poolConfig({
      DB_POOL_MAX: "12",
      DB_IDLE_TIMEOUT_MS: "60000",
      DB_CONNECTION_TIMEOUT_MS: "2000",
      DB_STATEMENT_TIMEOUT_MS: "3000",
    }),
    {
      max: 12,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 3_000,
      query_timeout: 8_000,
    },
  );

  for (const bad of ["", "  ", "abc", "0", "-5", "1.5", "NaN", "Infinity"]) {
    assert.deepEqual(
      poolConfig({
        DB_POOL_MAX: bad,
        DB_IDLE_TIMEOUT_MS: bad,
        DB_CONNECTION_TIMEOUT_MS: bad,
        DB_STATEMENT_TIMEOUT_MS: bad,
      }),
      poolConfig({}),
      JSON.stringify(bad),
    );
  }
});

test("createStatsPool pasa esa configuración al Pool, no fija credenciales y escucha 'error'", () => {
  const created = [];
  class FakePool extends EventEmitter {
    constructor(config) {
      super();
      created.push(config);
    }
  }
  const pool = createStatsPool({ env: { DB_POOL_MAX: "8" }, PoolClass: FakePool });

  assert.equal(created.length, 1);
  assert.equal(created[0].max, 8);
  assert.equal(created[0].idleTimeoutMillis, 30_000);
  assert.equal(created[0].connectionTimeoutMillis, 5_000);
  assert.equal(created[0].statement_timeout, 10_000);
  // La conexión sigue viniendo de las variables PG* estándar de pg, no de esta configuración.
  for (const key of ["host", "user", "password", "database", "port", "connectionString"]) {
    assert.equal(key in created[0], false, key);
  }

  // Un cliente inactivo que falla (reinicio de la base, red cortada) no debe tumbar el proceso:
  // sin oyente, EventEmitter lanzaría el 'error'.
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    assert.doesNotThrow(() => pool.emit("error", new Error("connection terminated")));
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(logged.length, 1);
  assert.match(String(logged[0][1]), /connection terminated/);
});

/* ── Errores de la base de datos: 503 al cliente, causa en el log ────────────
   El cliente sigue recibiendo un 503 genérico; el operador necesita saber por qué. El mensaje se
   registra sin cadenas de conexión ni secretos y sin el objeto de error (pila y propiedades). */

const USER_ID = "user_12345678";
const statsBody = () => ({
  id: "4b2de3a2-e6c2-4f8b-9d01-217e26ec8766",
  expectedUserId: USER_ID,
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

function responseStub() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

/** Ejecuta las dos rutas con un almacén que falla con `failure`; devuelve respuestas y líneas de console.error. */
async function runFailingStore(failure) {
  const store = {
    async getStats() {
      throw failure;
    },
    async saveSession() {
      throw failure;
    },
  };
  const handlers = createStatsHandlers({
    store,
    authenticatedPresence: () => ({ userId: USER_ID }),
    requestHasPublicOrigin: () => true,
  });
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  const get = responseStub();
  const post = responseStub();
  try {
    await handlers.get({ query: { days: "7" } }, get);
    await handlers.post({ body: statsBody() }, post);
  } finally {
    console.error = originalConsoleError;
  }
  return { get, post, logged };
}

test("un fallo de la base de datos sigue siendo un 503 genérico, pero queda registrado (lectura y escritura)", async () => {
  const failure = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" });
  const { get, post, logged } = await runFailingStore(failure);

  for (const res of [get, post]) {
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: "STATS_UNAVAILABLE" });
  }
  assert.equal(logged.length, 2, "un registro por fallo");
  for (const args of logged) {
    assert.ok(args.every((arg) => typeof arg === "string"), "solo texto: nunca el objeto de error (pila y propiedades)");
    const line = args.join(" ");
    assert.match(line, /ECONNREFUSED/);
    assert.match(line, /10\.0\.0\.5:5432/);
    assert.ok(!line.includes(USER_ID), "el id de la cuenta no se registra");
    assert.doesNotMatch(line, /\n\s+at /);
  }
  assert.notEqual(logged[0].join(" "), logged[1].join(" "), "el registro dice qué operación falló");
});

test("el registro del error de la base de datos no contiene cadenas de conexión ni secretos", async () => {
  const messages = [
    'failed to connect to postgres://app_user:S3cr3tPass@db.internal:5432/postgres?sslmode=require',
    "could not parse connection string postgresql://u:S3cr3tPass@h/db",
    "invalid setting password=S3cr3tPass host=db.internal",
    'FATAL: password: S3cr3tPass rejected',
    'invalid setting password="S3cr3tPass y" host=db.internal',
    "psql: PGPASSWORD=S3cr3tPass rejected",
    "Connection terminated unexpectedly\n    at Client._handleErrorEvent (secreto-en-la-pila)",
  ];
  for (const message of messages) {
    const { get, logged } = await runFailingStore(new Error(message));
    assert.equal(get.statusCode, 503, message);
    assert.ok(logged.length >= 1, message);
    for (const args of logged) {
      const line = args.join(" ");
      assert.ok(!line.includes("S3cr3tPass"), `secreto en el log: ${line}`);
      assert.ok(!line.includes("postgres://") && !line.includes("postgresql://"), `cadena de conexión en el log: ${line}`);
      assert.ok(!line.includes("secreto-en-la-pila"), `solo la primera línea del mensaje: ${line}`);
      assert.doesNotMatch(line, /\n/);
    }
  }
  // La causa útil se conserva.
  const { logged } = await runFailingStore(new Error("Connection terminated unexpectedly"));
  assert.match(logged[0].join(" "), /Connection terminated unexpectedly/);
});

// Cada una lleva un secreto que no puede aparecer en ningún registro; las que tienen espacios o comillas
// dejaban la cola visible con una redacción que solo miraba hasta el primer espacio.
const LEAKY_MESSAGES = [
  'invalid setting password="S3cr3t Pass" host=db.internal',
  "invalid setting password='S3cr3t Pass' host=db.internal",
  'invalid setting password="S3cr3t \\"Pass\\" x" host=db.internal',
  'invalid setting password="S3cr3t Pass',
  "PGPASSWORD=S3cr3tPass psql failed",
  "pgpassword: S3cr3tPass rejected",
  "invalid setting PGPASSWORD='S3cr3t Pass'",
  "sslpassword=S3cr3tPass sslkey=/tmp/S3cr3t.key",
  "db_password=S3cr3tPass",
  '{"password":"S3cr3t Pass","host":"db.internal"}',
  "password = S3cr3tPass",
  "invalid setting secret=\"S3cr3t Pass\" token='S3cr3t Pass'",
];

test("describeDbError redacta contraseñas con comillas y espacios y las variables PG*, sin comerse el resto útil", () => {
  for (const message of LEAKY_MESSAGES) {
    const described = describeDbError(new Error(message));
    assert.ok(!/S3cr3t|Pass\b|Pass"|Pass'/.test(described), `secreto en: ${described}`);
    assert.match(described, /\[redacted\]/, message);
  }
  // Lo que no es un secreto se conserva: el motivo y el host.
  assert.match(describeDbError(new Error('invalid setting password="S3cr3t Pass" host=db.internal')), /host=db\.internal/);
  assert.match(describeDbError(new Error("password authentication failed for user \"app\"")), /password authentication failed/);
  assert.equal(describeDbError(new Error("Connection terminated unexpectedly")), "Connection terminated unexpectedly");
  // Con código de pg, delante.
  assert.equal(describeDbError(Object.assign(new Error("boom"), { code: "57P01" })), "[57P01] boom");
});

test("el error de un cliente inactivo del Pool se registra con la misma redacción y el mismo recorte", () => {
  class FakePool extends EventEmitter {}
  const pool = createStatsPool({ env: {}, PoolClass: FakePool });
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    pool.emit("error", Object.assign(new Error('failed to connect to postgres://app_user:S3cr3tPass@db.internal:5432/app password="S3cr3t Pass"'), { code: "ECONNREFUSED" }));
    pool.emit("error", new Error(`PGPASSWORD=S3cr3tPass ${"x".repeat(5000)}`));
    pool.emit("error", new Error("Connection terminated unexpectedly\n    at Client._handleErrorEvent (secreto-en-la-pila)"));
    pool.emit("error", "cadena suelta");
    pool.emit("error", undefined);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(logged.length, 5);
  for (const args of logged) {
    assert.equal(args[0], "Postgres pool error:");
    assert.ok(args.every((arg) => typeof arg === "string"), "solo texto: nunca el objeto de error");
    const line = args.join(" ");
    assert.ok(!line.includes("S3cr3t"), `secreto en el log: ${line}`);
    assert.ok(!line.includes("postgres://"), `cadena de conexión en el log: ${line}`);
    assert.ok(!line.includes("secreto-en-la-pila"), "solo la primera línea");
    assert.ok(line.length < 300, `recortado: ${line.length}`);
    assert.doesNotMatch(line, /\n/);
  }
  assert.match(logged[0][1], /ECONNREFUSED/, "la causa útil se conserva");
  assert.match(logged[2][1], /Connection terminated unexpectedly/);
});

test("el registro tolera fallos que no son Error y acota su longitud", async () => {
  for (const failure of ["cadena suelta", undefined, null, 42, { message: "objeto sin clase" }, { code: "57014" }]) {
    const { get, post, logged } = await runFailingStore(failure);
    assert.equal(get.statusCode, 503, String(failure));
    assert.equal(post.statusCode, 503, String(failure));
    assert.equal(logged.length, 2, String(failure));
  }
  const { logged } = await runFailingStore(new Error("x".repeat(5000)));
  assert.ok(logged[0].join(" ").length < 400, "el mensaje se recorta");
  // Un código de pg (SQLSTATE) ayuda a diagnosticar (57014 = statement_timeout).
  const timeout = await runFailingStore(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }));
  assert.match(timeout.logged[0].join(" "), /57014/);
});

test("sin sesión las rutas de estadísticas dan 401 por defecto, o lo que decida el servidor (503 si Clerk no está disponible)", async () => {
  const never = { async getStats() { throw new Error("no debe llegar al almacén"); }, async saveSession() { throw new Error("no debe llegar al almacén"); } };
  const base = { store: never, authenticatedPresence: () => null, requestHasPublicOrigin: () => true };

  const plain = createStatsHandlers(base);
  const get = responseStub();
  await plain.get({ query: {} }, get);
  assert.equal(get.statusCode, 401);
  assert.deepEqual(get.body, { error: "SESSION_REQUIRED" });
  const post = responseStub();
  await plain.post({ body: statsBody() }, post);
  assert.equal(post.statusCode, 401);

  const seen = [];
  const custom = createStatsHandlers({
    ...base,
    sendSessionRequired: (req, res) => {
      seen.push(req.marker);
      return res.status(503).json({ error: "AUTH_UNAVAILABLE" });
    },
  });
  const customGet = responseStub();
  await custom.get({ query: {}, marker: "get" }, customGet);
  const customPost = responseStub();
  await custom.post({ body: statsBody(), marker: "post" }, customPost);
  for (const res of [customGet, customPost]) {
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: "AUTH_UNAVAILABLE" });
  }
  assert.deepEqual(seen, ["get", "post"]);
});

test("pg acepta la configuración tal cual en un Pool real (sin conectar)", async () => {
  const pool = createStatsPool({ env: { DB_POOL_MAX: "3", DB_STATEMENT_TIMEOUT_MS: "4000" } });
  try {
    assert.equal(pool.options.max, 3);
    assert.equal(pool.options.idleTimeoutMillis, 30_000);
    assert.equal(pool.options.connectionTimeoutMillis, 5_000);
    assert.equal(pool.options.statement_timeout, 4_000);
    assert.equal(pool.options.query_timeout, 9_000);
    assert.equal(pool.totalCount, 0, "crear el Pool no debe abrir conexiones");
  } finally {
    await pool.end();
  }
});
