import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import express from "express";
import {
  CLERK_PROXY_ALLOWED_METHODS,
  CLERK_PROXY_PATH,
  CLERK_PROXY_RATE_LIMIT,
  clerkProxyMiddleware,
  getClerkProxyProtocol,
  isAllowedClerkProxyPath,
  isValidProxyHost,
  stripAppCookies,
  stripClerkProxyMount,
} from "../server/middlewares/clerkProxyMiddleware.mjs";
import { APP_SESSION_COOKIE } from "../server/session-cookie.mjs";

// Nada de esto toca la red real: el "Clerk" de estas pruebas es un servidor HTTP local
// que captura las cabeceras salientes del proxy, y la clave es un valor inerte de prueba.
const SECRET = "sk_test_proxy_headers_are_captured_locally";

async function startFakeClerk() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const body = JSON.stringify({ ok: true });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    received,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      }),
  };
}

/** Express real con el proxy montado; lo que no reenvía cae al 418 final. */
async function startProxyApp({ trustProxy = 1, mount = CLERK_PROXY_PATH, options = {} } = {}) {
  const clerk = await startFakeClerk();
  const app = express();
  app.set("trust proxy", trustProxy);
  const proxy = clerkProxyMiddleware({
    isProduction: true,
    secretKey: SECRET,
    target: clerk.url,
    ...options,
  });
  if (mount === "/") app.use(proxy);
  else app.use(mount, proxy);
  app.use((_req, res) => res.status(418).json({ fellThrough: true }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    clerk,
    port: server.address().port,
    close: async () => {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
      await clerk.close();
    },
  };
}

function request(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    // Node no usa transferencia por trozos en DELETE: sin content-length el cuerpo se malinterpreta.
    const framed = body ? { ...headers, "content-length": String(Buffer.byteLength(body)) } : headers;
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: framed }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function withProxy(options, run) {
  const app = await startProxyApp(options);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

test("la IP que recibe Clerk sale de req.ip (trust proxy), no del X-Forwarded-For que manda el cliente", async () => {
  // El cliente antepone 6.6.6.6; el proxy de confianza (1 salto) añade la IP real al final.
  await withProxy({ trustProxy: 1 }, async ({ port, clerk }) => {
    const res = await request(port, `${CLERK_PROXY_PATH}/v1/client`, {
      headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" },
    });
    assert.equal(res.status, 200);
    assert.equal(clerk.received.length, 1);
    assert.equal(clerk.received[0].headers["x-forwarded-for"], "203.0.113.9");
  });

  // Sin salto de confianza el header del cliente no cuenta: solo la IP del socket.
  await withProxy({ trustProxy: 0 }, async ({ port, clerk }) => {
    await request(port, `${CLERK_PROXY_PATH}/v1/client`, {
      headers: { "x-forwarded-for": "6.6.6.6" },
    });
    assert.equal(clerk.received[0].headers["x-forwarded-for"], "127.0.0.1");
  });
});

test("no reenvía a Clerk otras cabeceras con las que el cliente afirma su IP", async () => {
  await withProxy({ trustProxy: 1 }, async ({ port, clerk }) => {
    await request(port, `${CLERK_PROXY_PATH}/v1/client`, {
      headers: {
        "x-real-ip": "6.6.6.6",
        "cf-connecting-ip": "6.6.6.6",
        "true-client-ip": "6.6.6.6",
        forwarded: "for=6.6.6.6",
      },
    });
    const sent = clerk.received[0].headers;
    for (const name of ["x-real-ip", "cf-connecting-ip", "true-client-ip", "forwarded"]) {
      assert.equal(sent[name], undefined, name);
    }
  });
});

test("las cookies de la app (incluida la de presencia) no llegan a Clerk; las de Clerk sí", async () => {
  await withProxy({ trustProxy: 1 }, async ({ port, clerk }) => {
    await request(port, `${CLERK_PROXY_PATH}/v1/client`, {
      headers: {
        cookie: `${APP_SESSION_COOKIE}=payload.firma; __client=abc; __client_uat=1700000000`,
      },
    });
    assert.equal(clerk.received[0].headers.cookie, "__client=abc; __client_uat=1700000000");

    // Si solo hay cookies de la app, la cabecera Cookie desaparece del todo.
    await request(port, `${CLERK_PROXY_PATH}/v1/client`, {
      headers: { cookie: `${APP_SESSION_COOKIE}=payload.firma` },
    });
    assert.equal(clerk.received[1].headers.cookie, undefined);
  });
});

test("stripAppCookies quita solo las cookies propias y respeta el resto", () => {
  // El nombre real de la cookie de presencia debe caer siempre en el filtro.
  assert.equal(stripAppCookies(`${APP_SESSION_COOKIE}=x`), "");
  assert.equal(
    stripAppCookies("a=1; postava.v1=x; __Secure-postava_y=2;__client=3;  ;b"),
    "a=1; __client=3; b",
  );
  assert.equal(stripAppCookies("theme_postava=1; __client_uat_Ab12=2"), "theme_postava=1; __client_uat_Ab12=2");
  assert.equal(stripAppCookies(undefined), "");
  assert.equal(stripAppCookies(""), "");
});

test("Clerk-Proxy-Url solo usa http o https, y solo lee X-Forwarded-Proto/Host de un salto de confianza", async () => {
  const proxyUrlFor = async (options, headers) => {
    let sent;
    await withProxy(options, async ({ port, clerk }) => {
      await request(port, `${CLERK_PROXY_PATH}/v1/client`, { headers });
      sent = clerk.received[0].headers;
    });
    return sent;
  };
  const trusted = { trustProxy: 1 };

  let sent = await proxyUrlFor(trusted, { host: "internal:5000", "x-forwarded-host": "app.example", "x-forwarded-proto": "https" });
  assert.equal(sent["clerk-proxy-url"], "https://app.example/api/__clerk");
  assert.equal(sent["x-forwarded-proto"], "https");

  sent = await proxyUrlFor(trusted, { host: "app.example", "x-forwarded-proto": "HTTP" });
  assert.equal(sent["clerk-proxy-url"], "http://app.example/api/__clerk");

  // Lista de protocolos: cuenta el primero.
  sent = await proxyUrlFor(trusted, { host: "app.example", "x-forwarded-proto": "https, http" });
  assert.equal(sent["clerk-proxy-url"], "https://app.example/api/__clerk");

  // Esquemas raros o basura: nunca llegan a Clerk, se usa https.
  for (const junk of ["javascript", "ftp", "https://evil.example/", "evil\t.example", ""]) {
    sent = await proxyUrlFor(trusted, { host: "app.example", "x-forwarded-proto": junk });
    assert.equal(sent["clerk-proxy-url"], "https://app.example/api/__clerk", JSON.stringify(junk));
    assert.equal(sent["x-forwarded-proto"], "https", JSON.stringify(junk));
  }

  // Sin salto de confianza se ignoran tanto X-Forwarded-Proto como X-Forwarded-Host.
  sent = await proxyUrlFor(
    { trustProxy: 0 },
    { host: "app.example", "x-forwarded-host": "spoofed.example", "x-forwarded-proto": "http" },
  );
  assert.equal(sent["clerk-proxy-url"], "https://app.example/api/__clerk");
});

test("getClerkProxyProtocol valida el valor y respeta trust proxy", () => {
  const request = (proto, trusted = true) => ({
    app: { get: (key) => (key === "trust proxy fn" ? () => trusted : undefined) },
    socket: { remoteAddress: "203.0.113.5" },
    headers: proto === undefined ? {} : { "x-forwarded-proto": proto },
  });
  assert.equal(getClerkProxyProtocol(request("http")), "http");
  assert.equal(getClerkProxyProtocol(request("https")), "https");
  assert.equal(getClerkProxyProtocol(request(["http", "https"])), "http");
  assert.equal(getClerkProxyProtocol(request("gopher")), "https");
  assert.equal(getClerkProxyProtocol(request(undefined)), "https");
  assert.equal(getClerkProxyProtocol(request("http", false)), "https");
});

test("la clave secreta de Clerk la pone siempre el servidor, aunque el cliente mande otra", async () => {
  await withProxy({}, async ({ port, clerk }) => {
    await request(port, `${CLERK_PROXY_PATH}/v1/client`, {
      headers: { "clerk-secret-key": "sk_live_del_atacante", "clerk-proxy-url": "https://evil.example/x" },
    });
    assert.equal(clerk.received[0].headers["clerk-secret-key"], SECRET);
    assert.match(clerk.received[0].headers["clerk-proxy-url"], /\/api\/__clerk$/);
    assert.doesNotMatch(clerk.received[0].headers["clerk-proxy-url"], /evil/);
  });
});

test("solo se reenvían los métodos que usa clerk-js; el resto se responde 405 sin tocar Clerk", async () => {
  assert.deepEqual([...CLERK_PROXY_ALLOWED_METHODS], ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
  await withProxy({}, async ({ port, clerk }) => {
    for (const method of CLERK_PROXY_ALLOWED_METHODS) {
      const res = await request(port, `${CLERK_PROXY_PATH}/v1/client`, {
        method,
        headers: method === "GET" || method === "HEAD" ? {} : { "content-type": "application/json" },
        body: method === "GET" || method === "HEAD" ? undefined : "{}",
      });
      assert.equal(res.status, 200, method);
    }
    assert.deepEqual(
      clerk.received.map((item) => item.method),
      [...CLERK_PROXY_ALLOWED_METHODS],
    );

    const before = clerk.received.length;
    for (const method of ["TRACE", "OPTIONS", "PROPFIND"]) {
      const res = await request(port, `${CLERK_PROXY_PATH}/v1/client`, { method });
      assert.equal(res.status, 405, method);
      assert.match(res.headers.allow, /GET/);
      assert.deepEqual(JSON.parse(res.body), { error: "METHOD_NOT_ALLOWED" });
    }
    assert.equal(clerk.received.length, before, "Clerk no debe ver estas peticiones");
  });
});

test("solo se reenvía /v1 (el prefijo de la Frontend API) y la ruta llega intacta a Clerk", async () => {
  await withProxy({}, async ({ port, clerk }) => {
    for (const path of ["/v1", "/v1/client", "/v1/client/sign_ins?_clerk_js_version=6&redirect_url=https://x/../y"]) {
      const res = await request(port, `${CLERK_PROXY_PATH}${path}`);
      assert.equal(res.status, 200, path);
    }
    assert.deepEqual(
      clerk.received.map((item) => item.url),
      ["/v1", "/v1/client", "/v1/client/sign_ins?_clerk_js_version=6&redirect_url=https://x/../y"],
    );

    const before = clerk.received.length;
    for (const path of [
      "",
      "/",
      "/npm/@clerk/clerk-js@6/dist/clerk.browser.js",
      "/v1abc",
      "//v1/client",
      "/.well-known/jwks.json",
      "/v1/../npm/x.js",
      "/v1/%2e%2e/npm/x.js",
      "/v1/%2E%2E%2Fnpm/x.js",
      "/v1/..%5cnpm",
      "/v1\\..\\npm",
    ]) {
      const res = await request(port, `${CLERK_PROXY_PATH}${path}`);
      assert.equal(res.status, 404, path);
      assert.deepEqual(JSON.parse(res.body), { error: "NOT_FOUND" }, path);
    }
    assert.equal(clerk.received.length, before, "Clerk no debe ver estas peticiones");
  });
});

test("isAllowedClerkProxyPath solo acepta /v1 sin segmentos de escape en la ruta", () => {
  assert.equal(isAllowedClerkProxyPath("/v1"), true);
  assert.equal(isAllowedClerkProxyPath("/v1/client?a=/../b"), true);
  assert.equal(isAllowedClerkProxyPath("/v1?x=1"), true);
  assert.equal(isAllowedClerkProxyPath("/v10"), false);
  assert.equal(isAllowedClerkProxyPath("/"), false);
  assert.equal(isAllowedClerkProxyPath("/v1/.."), false);
  assert.equal(isAllowedClerkProxyPath("/v1/%2e%2e/x"), false);
  assert.equal(isAllowedClerkProxyPath("/v1/a%2Fb"), false);
  assert.equal(isAllowedClerkProxyPath(undefined), false);
});

test("montado fuera de CLERK_PROXY_PATH no reenvía nada (cedería todo el sitio a Clerk)", async () => {
  await withProxy({ mount: "/" }, async ({ port, clerk }) => {
    for (const path of ["/", "/v1/client", `${CLERK_PROXY_PATH}/v1/client`, "/api/stats"]) {
      const res = await request(port, path);
      assert.equal(res.status, 418, path);
    }
    assert.equal(clerk.received.length, 0);
  });

  // Y bajo un prefijo parecido pero distinto tampoco.
  await withProxy({ mount: "/api/__clerk-copy" }, async ({ port, clerk }) => {
    const res = await request(port, "/api/__clerk-copy/v1/client");
    assert.equal(res.status, 418);
    assert.equal(clerk.received.length, 0);
  });
});

/* ── Endurecimiento del proxy ─────────────────────────────────────────────── */

test("el prefijo del proxy se quita sin distinguir mayúsculas, igual que la guarda", async () => {
  // Con http-proxy-middleware 3.0.7 montado con app.use() el rewrite recibe ya la URL relativa al montaje, así que
  // hoy no hay desvío; la regla sigue siendo la misma que la guarda (que compara en minúsculas) por si eso cambia.
  assert.equal(stripClerkProxyMount("/API/__CLERK/v1/client?x=1"), "/v1/client?x=1");
  assert.equal(stripClerkProxyMount("/Api/__Clerk/v1/a"), "/v1/a");
  assert.equal(stripClerkProxyMount("/api/__clerk/v1/a"), "/v1/a");
  assert.equal(stripClerkProxyMount("/v1/a"), "/v1/a");
  assert.equal(stripClerkProxyMount("/x/api/__clerk/v1/a"), "/x/api/__clerk/v1/a");

  await withProxy({}, async ({ port, clerk }) => {
    for (const mount of ["/API/__CLERK", "/Api/__Clerk", "/api/__clerk"]) {
      const res = await request(port, `${mount}/v1/client?x=1`);
      assert.equal(res.status, 200, mount);
    }
    assert.deepEqual(clerk.received.map((item) => item.url), ["/v1/client?x=1", "/v1/client?x=1", "/v1/client?x=1"]);
    // Solo el prefijo del montaje es insensible a mayúsculas: la ruta de la Frontend API no.
    const wrongCase = await request(port, `${CLERK_PROXY_PATH}/V1/client`);
    assert.equal(wrongCase.status, 404);
    assert.equal(clerk.received.length, 3);
  });
});

test("isAllowedClerkProxyPath: lista blanca positiva de /v1 y segmentos de caracteres no reservados", () => {
  const allowed = [
    "/v1", "/v1/", "/v1/client", "/v1/client/", "/v1/client/sign_ins/sia_2Abc/attempt_first_factor",
    "/v1/client/sessions/sess_1/tokens", "/v1/dev_browser", "/v1/a.b~c-d_e", "/v1/.hidden", "/v1/x..y",
    "/v1?x=1", "/v1/client?a=/../b", "/v1/environment?redirect_url=https://x/../y%2f",
  ];
  for (const url of allowed) assert.equal(isAllowedClerkProxyPath(url), true, url);

  const rejected = [
    "", "/", "//v1", "v1", "/v10", "/v1abc", "/V1/client", "/v1//client", "/v1/client//", "/v1/cli ent", "/v1/client;x=1",
    "/v1/a@b", "/v1/a:b", "/v1/a,b", "/v1/a(b)", "/v1/a*b", "/v1/a'b", '/v1/a"b', "/v1/a[b]", "/v1/a+b", "/v1/a=b",
    "/v1/a%20b", "/v1/%41", "/v1/a%2Fb", "/v1/%2e%2e/x", "/v1/clïent", "/v1\\x", "/v1/x#frag",
    "/v1/.", "/v1/..", "/v1/./x", "/v1/x/.", "/v1/x/..", "/v1/../x", "/v1/x/../y",
    "http://evil.example/v1/client", 42, null, undefined,
  ];
  for (const url of rejected) assert.equal(isAllowedClerkProxyPath(url), false, String(url));
});

test("rutas fuera de la lista blanca se responden 404 sin llegar a Clerk (dobles barras, @, ;, dot-segments)", async () => {
  await withProxy({}, async ({ port, clerk }) => {
    for (const path of ["/v1//client", "/v1/a@b", "/v1/client;x=1", "/v1/./client", "/v1/client/.", "/v1/a(b)", "/v1/client//"]) {
      const res = await request(port, `${CLERK_PROXY_PATH}${path}`);
      assert.equal(res.status, 404, path);
      assert.deepEqual(JSON.parse(res.body), { error: "NOT_FOUND" }, path);
    }
    assert.equal(clerk.received.length, 0);

    for (const path of ["/v1/client/", "/v1/client/sign_ins/sia_2Abc/attempt_first_factor"]) {
      assert.equal((await request(port, `${CLERK_PROXY_PATH}${path}`)).status, 200, path);
    }
  });
});

test("X-Forwarded-Host y X-Forwarded-Port que manda el cliente no llegan a Clerk", async () => {
  for (const trustProxy of [1, 0]) {
    await withProxy({ trustProxy }, async ({ port, clerk }) => {
      const res = await request(port, `${CLERK_PROXY_PATH}/v1/client`, {
        headers: { host: "app.example", "x-forwarded-host": "app.example", "x-forwarded-port": "8443" },
      });
      assert.equal(res.status, 200);
      const sent = clerk.received[0].headers;
      assert.equal(sent["x-forwarded-host"], undefined, `trustProxy=${trustProxy}`);
      assert.equal(sent["x-forwarded-port"], undefined, `trustProxy=${trustProxy}`);
      // Lo que sí se manda lo decide el servidor.
      assert.equal(sent["clerk-proxy-url"], "https://app.example/api/__clerk");
      assert.equal(sent["x-forwarded-proto"], "https");
    });
  }
});

test("isValidProxyHost acepta host[:puerto] de nombre DNS, IPv4 o IPv6 entre corchetes y nada más", () => {
  for (const host of [
    "app.example", "app.example:5000", "APP.Example.COM", "localhost", "internal:5000", "127.0.0.1:5000", "[::1]:5000", "[2001:db8::1]",
    "xn--bcher-kva.example", "a", "a-b.c-d.example:65535", `${"a".repeat(63)}.example`,
  ]) {
    assert.equal(isValidProxyHost(host), true, host);
  }
  for (const host of [
    "", " ", undefined, null, 42, "app.example/evil", "app.example?x=1", "app.example#x", "user@app.example", "app example",
    "app.example:", "app.example:0x50", "app.example:123456", "app.example:80:81", "[::1", "[zz]", "[]", "-app.example",
    "app-.example", "app..example", ".example", "app.example.", "app_example", "app.exämple", "app.example\r\nX: y",
    `${"a".repeat(64)}.example`, `${"a.".repeat(130)}example`, "https://app.example", "*.example.com",
  ]) {
    assert.equal(isValidProxyHost(host), false, String(host));
  }
});

test("Clerk-Proxy-Url: el host se valida antes de construirla; con un host inválido no se reenvía nada (400)", async () => {
  await withProxy({ trustProxy: 1 }, async ({ port, clerk }) => {
    for (const host of ["app.example/evil", "app.example?x=1", "app.example#x", "user@app.example", "app example", "app.example:123456"]) {
      const res = await request(port, `${CLERK_PROXY_PATH}/v1/client`, { headers: { host } });
      assert.equal(res.status, 400, host);
      assert.deepEqual(JSON.parse(res.body), { error: "BAD_REQUEST" }, host);
    }
    // También cuando el host inválido lo afirma el salto de confianza (X-Forwarded-Host).
    const viaForwarded = await request(port, `${CLERK_PROXY_PATH}/v1/client`, {
      headers: { host: "internal:5000", "x-forwarded-host": "evil.example/api" },
    });
    assert.equal(viaForwarded.status, 400);
    assert.equal(clerk.received.length, 0, "Clerk no debe ver estas peticiones");

    for (const host of ["app.example", "app.example:5000", "127.0.0.1:5000", "[::1]:5000"]) {
      const res = await request(port, `${CLERK_PROXY_PATH}/v1/client`, { headers: { host } });
      assert.equal(res.status, 200, host);
    }
    assert.deepEqual(
      clerk.received.map((item) => item.headers["clerk-proxy-url"]),
      ["https://app.example/api/__clerk", "https://app.example:5000/api/__clerk", "https://127.0.0.1:5000/api/__clerk", "https://[::1]:5000/api/__clerk"],
    );
  });

  // Sin salto de confianza X-Forwarded-Host no cuenta, así que uno inválido ahí es irrelevante.
  await withProxy({ trustProxy: 0 }, async ({ port, clerk }) => {
    const res = await request(port, `${CLERK_PROXY_PATH}/v1/client`, {
      headers: { host: "app.example", "x-forwarded-host": "evil.example/api" },
    });
    assert.equal(res.status, 200);
    assert.equal(clerk.received[0].headers["clerk-proxy-url"], "https://app.example/api/__clerk");
  });
});

test("tope de peticiones por IP solo en la ruta del proxy: 429 con Retry-After, cupos independientes y sin afectar al resto", async () => {
  assert.deepEqual({ ...CLERK_PROXY_RATE_LIMIT }, { windowMs: 60_000, max: 300 });

  await withProxy({ trustProxy: 1, options: { rateLimit: { windowMs: 60_000, max: 3 } } }, async ({ port, clerk }) => {
    const from = (n) => ({ "x-forwarded-for": `198.51.100.${n}` });
    for (let i = 0; i < 3; i++) assert.equal((await request(port, `${CLERK_PROXY_PATH}/v1/client`, { headers: from(1) })).status, 200, `intento ${i}`);
    const limited = await request(port, `${CLERK_PROXY_PATH}/v1/client`, { headers: from(1) });
    assert.equal(limited.status, 429);
    assert.deepEqual(JSON.parse(limited.body), { error: "RATE_LIMITED" });
    assert.match(limited.headers["retry-after"], /^\d+$/);
    assert.equal(clerk.received.length, 3, "la cuarta no llega a Clerk");

    // Otra IP (mismo proxy de confianza) tiene su propio cupo.
    assert.equal((await request(port, `${CLERK_PROXY_PATH}/v1/client`, { headers: from(2) })).status, 200);
    // Y el resto de la aplicación, incluso desde la IP agotada, sigue respondiendo.
    for (let i = 0; i < 6; i++) assert.equal((await request(port, "/otra-ruta", { headers: from(1) })).status, 418);

    // Lo que se rechaza antes de reenviar (método, ruta, host) no gasta cupo.
    for (let i = 0; i < 5; i++) {
      assert.equal((await request(port, `${CLERK_PROXY_PATH}/v1//x`, { headers: from(3) })).status, 404);
      assert.equal((await request(port, `${CLERK_PROXY_PATH}/v1/client`, { method: "TRACE", headers: from(3) })).status, 405);
      assert.equal((await request(port, `${CLERK_PROXY_PATH}/v1/client`, { headers: { ...from(3), host: "a/b" } })).status, 400);
    }
    for (let i = 0; i < 3; i++) assert.equal((await request(port, `${CLERK_PROXY_PATH}/v1/client`, { headers: from(3) })).status, 200);
  });
});

test("el tope solo cuenta la IP real: un X-Forwarded-For inventado no elige cubo", async () => {
  await withProxy({ trustProxy: 1, options: { rateLimit: { windowMs: 60_000, max: 2 } } }, async ({ port }) => {
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      // El proxy de confianza añade la IP real (203.0.113.9) al final; lo que el cliente escribe antes no cuenta.
      const res = await request(port, `${CLERK_PROXY_PATH}/v1/client`, { headers: { "x-forwarded-for": `10.0.0.${i}, 203.0.113.9` } });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [200, 200, 429, 429]);
  });
});

test("fuera de producción o sin CLERK_SECRET_KEY el proxy es transparente (sigue la cadena)", async () => {
  for (const options of [{ isProduction: false }, { secretKey: "" }]) {
    await withProxy({ options }, async ({ port, clerk }) => {
      const res = await request(port, `${CLERK_PROXY_PATH}/v1/client`);
      assert.equal(res.status, 418, JSON.stringify(options));
      assert.equal(clerk.received.length, 0);
    });
  }
});
