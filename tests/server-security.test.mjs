import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { createApp, handleUnexpectedError } from "../server.mjs";
import { createRateLimiter } from "../server/rate-limit.mjs";
import { securityHeaders, buildContentSecurityPolicy } from "../server/security-headers.mjs";

// El SDK de Clerk envía telemetría a sus servidores con claves pk_test: en tests no debe salir nada a la red.
process.env.CLERK_TELEMETRY_DISABLED ??= "1";

// clerkMiddleware runs on every request and fails closed (500) without a
// syntactically valid key pair; these are inert test-only placeholders, no
// real Clerk instance is contacted by these tests.
process.env.CLERK_SECRET_KEY ??= "sk_test_00000000000000000000000000000000";
process.env.CLERK_PUBLISHABLE_KEY ??= `pk_test_${Buffer.from("test.clerk.accounts.dev$")
  .toString("base64")
  .replace(/=+$/, "")}`;

async function startServer() {
  const server = createApp().listen(0);
  await once(server, "listening");
  const { port } = server.address();
  return {
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: options.method || "GET", headers: options.headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test("responses carry the hardening headers, including a CSP that matches what the app actually loads", async () => {
  const { port, close } = await startServer();
  try {
    const res = await request(port, "/");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["referrer-policy"], "strict-origin-when-cross-origin");
    assert.equal(res.headers["x-frame-options"], "DENY");

    // NODE_ENV is not "production" while running tests, so the middleware
    // ships Report-Only (see server/security-headers.mjs for why).
    const csp = res.headers["content-security-policy-report-only"];
    assert.ok(csp, "expected a Content-Security-Policy-Report-Only header");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src[^;]*https:\/\/cdn\.jsdelivr\.net/);
    assert.match(csp, /script-src[^;]*'wasm-unsafe-eval'/);
    assert.match(csp, /connect-src[^;]*https:\/\/storage\.googleapis\.com/);
    assert.match(csp, /connect-src[^;]*https:\/\/clerk-telemetry\.com/);
    assert.match(csp, /frame-src[^;]*https:\/\/challenges\.cloudflare\.com/);
    assert.match(csp, /worker-src[^;]*blob:/);
    assert.match(csp, /style-src[^;]*https:\/\/fonts\.googleapis\.com/);
  } finally {
    await close();
  }
});

test("production ships the CSP enforced instead of Report-Only, without Clerk's direct dev host", () => {
  const prodCsp = buildContentSecurityPolicy({ isProduction: true });
  const devCsp = buildContentSecurityPolicy({ isProduction: false });
  assert.doesNotMatch(prodCsp, /clerk\.accounts\.dev/);
  assert.match(devCsp, /clerk\.accounts\.dev/);

  const headerNames = [];
  securityHeaders({ isProduction: true })({}, { set: (name) => headerNames.push(name) }, () => {});
  assert.ok(headerNames.includes("Content-Security-Policy"));
  assert.ok(!headerNames.includes("Content-Security-Policy-Report-Only"));
});

test("POST /api/auth/session is rate-limited per key with a Retry-After header", async () => {
  const { port, close } = await startServer();
  try {
    let lastStatus;
    let limited;
    for (let i = 0; i < 31; i++) {
      // No Clerk session cookie, so every call is rejected before rate
      // limiting matters for its own logic; we only care that the limiter
      // itself trips after the configured ceiling regardless of the
      // downstream handler's outcome.
      const res = await request(port, "/api/auth/session", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "0" },
      });
      lastStatus = res.status;
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    assert.equal(lastStatus, 429);
    assert.ok(limited.headers["retry-after"]);
    assert.deepEqual(JSON.parse(limited.body), { error: "RATE_LIMITED" });
  } finally {
    await close();
  }
});

test("no hay parser de formularios: un cuerpo urlencoded no se interpreta ni se limita, la ruta responde como siempre", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /express\.urlencoded/);

  const { port, close } = await startServer();
  try {
    // Con el parser montado (límite 16 KB) esto acababa en un 500 INTERNAL_ERROR por cuerpo demasiado grande;
    // sin él llega al manejador de la ruta, que rechaza la petición por falta de Origin propio.
    const res = await request(port, "/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `remember=${"x".repeat(20_000)}`,
    });
    assert.equal(res.status, 403);
    assert.deepEqual(JSON.parse(res.body), { error: "UNSAFE_ORIGIN" });

    // El JSON sigue funcionando (mismo camino: sin Origin, 403).
    const json = await request(port, "/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remember: true }),
    });
    assert.equal(json.status, 403);
  } finally {
    await close();
  }
});

/** Ejecuta `run` capturando todo lo que se escriba con console.error/warn/log; devuelve las líneas ya formateadas. */
async function captureConsole(run) {
  const original = { error: console.error, warn: console.warn, log: console.log };
  const lines = [];
  const format = (args) =>
    args.map((arg) => (arg instanceof Error ? `${arg.stack}\n${JSON.stringify({ ...arg })}` : String(arg))).join(" ");
  for (const method of Object.keys(original)) console[method] = (...args) => lines.push({ method, text: format(args), args });
  try {
    await run();
  } finally {
    Object.assign(console, original);
  }
  return lines;
}

test("JSON mal formado: 400 BAD_REQUEST genérico, y el log no lleva pila ni un solo trozo del cuerpo", async () => {
  const { port, close } = await startServer();
  try {
    // El error de V8 cita el texto que rodea al fallo y body-parser adjunta el cuerpo entero (err.body).
    const body = '{"nota":"hunter2-CUERPO-SECRETO-abc" roto}';
    let res;
    const lines = await captureConsole(async () => {
      res = await request(port, "/api/auth/session", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
        body,
      });
    });
    assert.equal(res.status, 400);
    assert.deepEqual(JSON.parse(res.body), { error: "BAD_REQUEST" });
    assert.ok(lines.length >= 1, "el rechazo debe quedar registrado");
    for (const { text, args } of lines) {
      assert.ok(!text.includes("hunter2"), `el log no debe contener el cuerpo: ${text}`);
      assert.ok(!text.includes("SECRETO"), `el log no debe contener el cuerpo: ${text}`);
      assert.doesNotMatch(text, /\n\s+at /, "sin pila");
      assert.ok(args.every((arg) => typeof arg === "string"), "solo texto, nunca el objeto de error (arrastra err.body)");
    }
  } finally {
    await close();
  }
});

test("cuerpo JSON de más de 16 KB: 413 PAYLOAD_TOO_LARGE y sin volcar el cuerpo al log", async () => {
  const { port, close } = await startServer();
  try {
    const body = JSON.stringify({ nota: "x".repeat(20_000) });
    let res;
    const lines = await captureConsole(async () => {
      res = await request(port, "/api/stats/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
        body,
      });
    });
    assert.equal(res.status, 413);
    assert.deepEqual(JSON.parse(res.body), { error: "PAYLOAD_TOO_LARGE" });
    for (const { text } of lines) {
      assert.ok(!text.includes("xxxxxxxx"), "el log no debe contener el cuerpo");
      assert.doesNotMatch(text, /\n\s+at /, "sin pila");
    }
  } finally {
    await close();
  }
});

test("handleUnexpectedError: cualquier 4xx entero conserva su código con cuerpo genérico; lo demás sigue siendo 500", async () => {
  const run = async (err, headersSent = false) => {
    const res = {
      headersSent,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    let forwarded;
    const lines = await captureConsole(() => handleUnexpectedError(err, {}, res, (next) => (forwarded = next)));
    return { res, lines, forwarded };
  };
  const withStatus = (status, extra = {}) => Object.assign(new Error("mensaje interno"), { status, ...extra });

  for (const [status, code] of [[400, "BAD_REQUEST"], [403, "BAD_REQUEST"], [413, "PAYLOAD_TOO_LARGE"], [415, "BAD_REQUEST"], [431, "BAD_REQUEST"], [499, "BAD_REQUEST"]]) {
    const { res, lines } = await run(withStatus(status));
    assert.equal(res.statusCode, status);
    assert.deepEqual(res.body, { error: code });
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0].text, /\n\s+at /);
  }
  // Solo se registra `type` (identificador fijo de body-parser) o el mensaje, jamás el cuerpo (err.body).
  const parse = await run(withStatus(400, { type: "entity.parse.failed", body: "hunter2-cuerpo", message: 'Unexpected token, "hunter2-cuerpo" no es JSON' }));
  assert.equal(parse.res.statusCode, 400);
  assert.ok(parse.lines.every(({ text }) => !text.includes("hunter2")));
  assert.match(parse.lines[0].text, /entity\.parse\.failed/);
  const plain = await run(withStatus(400, { body: "hunter2-cuerpo" }));
  assert.match(plain.lines[0].text, /mensaje interno/);
  assert.ok(plain.lines.every(({ text }) => !text.includes("hunter2")));
  // `statusCode` (así lo llaman algunas bibliotecas) también vale.
  assert.equal((await run(Object.assign(new Error("x"), { statusCode: 431 }))).res.statusCode, 431);

  // Los 5xx reales y cualquier estado que no sea un entero 4xx: 500 genérico, sin filtrar el mensaje.
  for (const status of [500, 503, 302, 200, 600, 399, 400.5, "400", NaN, null, undefined]) {
    const { res, lines } = await run(withStatus(status, { message: "detalle-interno" }));
    assert.equal(res.statusCode, 500, String(status));
    assert.deepEqual(res.body, { error: "INTERNAL_ERROR" }, String(status));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].method, "error");
  }

  // Con la respuesta ya empezada se delega en Express también para los 4xx.
  const err = withStatus(400);
  const started = await run(err, true);
  assert.equal(started.forwarded, err);
  assert.equal(started.res.statusCode, undefined);
});

test("createRateLimiter resets after its window and prunes stale keys on sweep", () => {
  let currentTime = 0;
  const limiter = createRateLimiter({
    windowMs: 1000,
    max: 2,
    keyFn: (req) => req.key,
    now: () => currentTime,
  });
  const responses = () => {
    const headers = {};
    return {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      set(name, value) {
        headers[name] = value;
      },
      json(body) {
        this.body = body;
        return this;
      },
      headers,
    };
  };

  const call = (key) => {
    const res = responses();
    let nextCalled = false;
    limiter.middleware({ key }, res, () => {
      nextCalled = true;
    });
    return { res, nextCalled };
  };

  assert.equal(call("a").nextCalled, true);
  assert.equal(call("a").nextCalled, true);
  const third = call("a");
  assert.equal(third.nextCalled, false);
  assert.equal(third.res.statusCode, 429);
  assert.deepEqual(third.res.body, { error: "RATE_LIMITED" });
  assert.equal(third.res.headers["Retry-After"], "1");

  assert.equal(limiter.size(), 1);
  currentTime = 1001;
  limiter.sweep();
  assert.equal(limiter.size(), 0);

  // A different key is tracked independently.
  assert.equal(call("b").nextCalled, true);
  assert.equal(limiter.size(), 1);
});

test("createRateLimiter validates its configuration", () => {
  assert.throws(() => createRateLimiter({ windowMs: 0, max: 5 }));
  assert.throws(() => createRateLimiter({ windowMs: 1000, max: 0 }));
});
