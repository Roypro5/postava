import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_SESSION_COOKIE,
  PRESENCE_LIFETIME_SECONDS,
  PRESENCE_SESSION_LIFETIME_SECONDS,
  clearPresenceCookie,
  createPresenceCookie,
  createPresenceValue,
  readPresenceCookie,
  requestHasPublicOrigin,
  verifyPresenceValue,
} from "../server/session-cookie.mjs";
import { getClerkProxyHost } from "../server/middlewares/clerkProxyMiddleware.mjs";
import { handleUnexpectedError, trustProxyHops } from "../server.mjs";

// El SDK de Clerk envía telemetría a sus servidores con claves pk_test: en tests no debe salir nada a la red.
process.env.CLERK_TELEMETRY_DISABLED ??= "1";

const secret = "a-test-secret-that-is-never-used-by-the-server";
const now = 1_700_000_000_000;

test("rejects a tampered app-presence cookie", () => {
  const value = createPresenceValue("sess_one", true, secret, now);
  const tampered = `${value.slice(0, -1)}${value.endsWith("a") ? "b" : "a"}`;
  assert.equal(verifyPresenceValue(tampered, "sess_one", secret, now), null);
});

test("binds the marker to the Clerk session id", () => {
  const value = createPresenceValue("sess_one", true, secret, now);
  assert.equal(verifyPresenceValue(value, "sess_two", secret, now), null);
  assert.deepEqual(verifyPresenceValue(value, "sess_one", secret, now), {
    remember: true,
    expiresAt: now + PRESENCE_LIFETIME_SECONDS * 1000,
  });
});

test("rejects expired markers", () => {
  const value = createPresenceValue("sess_one", false, secret, now);
  const expiry = now + PRESENCE_LIFETIME_SECONDS * 1000;
  assert.equal(verifyPresenceValue(value, "sess_one", secret, expiry), null);
});

test("persistent and session cookies have the required attributes", () => {
  const persistent = createPresenceCookie("sess_one", true, secret, now);
  const session = createPresenceCookie("sess_one", false, secret, now);

  for (const cookie of [persistent, session]) {
    assert.match(cookie, new RegExp(`^${APP_SESSION_COOKIE}=`));
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; SameSite=Lax/);
  }
  assert.match(persistent, new RegExp(`; Max-Age=${PRESENCE_LIFETIME_SECONDS}`));
  assert.doesNotMatch(session, /Max-Age=/);
  assert.doesNotMatch(session, /Expires=/);
  assert.equal(
    readPresenceCookie(session, "sess_one", secret, now)?.remember,
    false,
  );
});

test("sin Recordarme el marcador firmado caduca a las 12 h; con Recordarme conserva 30 días", () => {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  assert.equal(PRESENCE_SESSION_LIFETIME_SECONDS, 12 * 60 * 60);
  assert.equal(PRESENCE_LIFETIME_SECONDS, 30 * 24 * 60 * 60);

  const session = createPresenceValue("sess_one", false, secret, now);
  assert.deepEqual(verifyPresenceValue(session, "sess_one", secret, now + 12 * hour - 1), {
    remember: false,
    expiresAt: now + 12 * hour,
  });
  assert.equal(verifyPresenceValue(session, "sess_one", secret, now + 12 * hour), null);
  assert.equal(verifyPresenceValue(session, "sess_one", secret, now + 13 * hour), null);
  assert.equal(verifyPresenceValue(session, "sess_one", secret, now + 29 * day), null);

  const persistent = createPresenceValue("sess_one", true, secret, now);
  assert.deepEqual(verifyPresenceValue(persistent, "sess_one", secret, now + 13 * hour), {
    remember: true,
    expiresAt: now + 30 * day,
  });
  assert.equal(verifyPresenceValue(persistent, "sess_one", secret, now + 30 * day - 1)?.remember, true);
  assert.equal(verifyPresenceValue(persistent, "sess_one", secret, now + 30 * day), null);
});

test("la cookie sin Recordarme sigue siendo de sesión (sin Max-Age) aunque su marcador caduque a las 12 h", () => {
  const session = createPresenceCookie("sess_one", false, secret, now);
  const persistent = createPresenceCookie("sess_one", true, secret, now);
  assert.doesNotMatch(session, /Max-Age=|Expires=/);
  assert.match(persistent, /; Max-Age=2592000(?:;|$)/);

  assert.equal(readPresenceCookie(session, "sess_one", secret, now + 11 * 60 * 60 * 1000)?.remember, false);
  assert.equal(readPresenceCookie(session, "sess_one", secret, now + 13 * 60 * 60 * 1000), null);
  assert.equal(readPresenceCookie(persistent, "sess_one", secret, now + 13 * 60 * 60 * 1000)?.remember, true);
});

test("la cookie de presencia cumple los requisitos del prefijo __Host- en todos los casos", () => {
  assert.ok(APP_SESSION_COOKIE.startsWith("__Host-"));
  for (const cookie of [
    createPresenceCookie("sess_one", true, secret, now),
    createPresenceCookie("sess_one", false, secret, now),
    clearPresenceCookie(),
  ]) {
    assert.match(cookie, /; Secure(?:;|$)/);
    assert.match(cookie, /; Path=\/(?:;|$)/);
    assert.doesNotMatch(cookie, /Domain=/i);
    assert.match(cookie, /; HttpOnly/);
  }
});

function trustingApp(trusted) {
  return { get: (key) => (key === "trust proxy fn" ? () => trusted : undefined) };
}

test("origin must match the effective public request host", () => {
  const request = (origin, host, forwardedHost, { trustProxy = true } = {}) => ({
    protocol: "https",
    app: trustingApp(trustProxy),
    socket: { remoteAddress: "203.0.113.5" },
    headers: {
      origin,
      host,
      ...(forwardedHost ? { "x-forwarded-host": forwardedHost } : {}),
    },
  });

  assert.equal(
    requestHasPublicOrigin(request("https://app.example", "internal:5000", "app.example")),
    true,
  );
  assert.equal(
    requestHasPublicOrigin(request("https://evil.example", "app.example")),
    false,
  );
  assert.equal(
    requestHasPublicOrigin(request("http://app.example", "app.example")),
    false,
  );
  assert.equal(requestHasPublicOrigin(request(undefined, "app.example")), false);
  assert.equal(
    requestHasPublicOrigin(
      request("https://app.example", "internal:5000", "app.example, proxy.local"),
    ),
    true,
  );
  // An untrusted hop (e.g. trust proxy hops set to 0) must not let a spoofed
  // X-Forwarded-Host override the real Host header used to compare origins.
  assert.equal(
    requestHasPublicOrigin(
      request("https://app.example", "internal:5000", "app.example", {
        trustProxy: false,
      }),
    ),
    false,
  );
});

test("requestHasPublicOrigin: X-Forwarded-Proto solo cuenta desde un salto de confianza y solo si es http o https", () => {
  const request = (origin, forwardedProto, { trustProxy = true, protocol = "https" } = {}) => ({
    protocol,
    app: trustingApp(trustProxy),
    socket: { remoteAddress: "203.0.113.5" },
    headers: {
      origin,
      host: "app.example",
      ...(forwardedProto === undefined ? {} : { "x-forwarded-proto": forwardedProto }),
    },
  });

  // Detrás de un proxy de confianza que termina TLS, manda lo que ese proxy dice (solo el primer valor, sin distinguir mayúsculas).
  assert.equal(requestHasPublicOrigin(request("https://app.example", "https", { protocol: "http" })), true);
  assert.equal(requestHasPublicOrigin(request("https://app.example", "HTTPS", { protocol: "http" })), true);
  assert.equal(requestHasPublicOrigin(request("https://app.example", "https, http", { protocol: "http" })), true);
  assert.equal(requestHasPublicOrigin(request("http://app.example", "http", { protocol: "https" })), true);
  assert.equal(requestHasPublicOrigin(request("http://app.example", "https", { protocol: "http" })), false);

  // Sin salto de confianza la cabecera no existe: manda el protocolo real de la conexión, diga lo que diga el cliente.
  assert.equal(requestHasPublicOrigin(request("http://app.example", "http", { trustProxy: false, protocol: "https" })), false);
  assert.equal(requestHasPublicOrigin(request("https://app.example", "https", { trustProxy: false, protocol: "http" })), false);
  assert.equal(requestHasPublicOrigin(request("https://app.example", "http", { trustProxy: false, protocol: "https" })), true);
  assert.equal(requestHasPublicOrigin(request("http://app.example", undefined, { trustProxy: false, protocol: "http" })), true);

  // Un esquema que no sea http/https no vale como protocolo público, ni siquiera desde un salto de confianza
  // (Express devuelve en req.protocol lo que diga la cabecera, sin validarlo).
  for (const junk of ["javascript", "ftp", "https://evil.example", "evil\t", ""]) {
    assert.equal(
      requestHasPublicOrigin(request(`${junk.split(":")[0] || "https"}://app.example`, junk, { protocol: junk })),
      false,
      JSON.stringify(junk),
    );
  }
  // Y sin protocolo conocido no se da por bueno ningún Origin.
  assert.equal(requestHasPublicOrigin(request("https://app.example", undefined, { protocol: null })), false);
});

test("getClerkProxyHost only honors X-Forwarded-Host from a trusted hop", () => {
  const request = (host, forwardedHost, trustProxy) => ({
    app: trustingApp(trustProxy),
    socket: { remoteAddress: "203.0.113.5" },
    headers: {
      host,
      ...(forwardedHost ? { "x-forwarded-host": forwardedHost } : {}),
    },
  });

  assert.equal(
    getClerkProxyHost(request("internal:5000", "app.example", true)),
    "app.example",
  );
  assert.equal(
    getClerkProxyHost(request("internal:5000", "spoofed.example", false)),
    "internal:5000",
  );
  assert.equal(
    getClerkProxyHost({ headers: { host: "internal:5000" } }),
    "internal:5000",
  );
});

test("trustProxyHops defaults to a single hop and rejects invalid overrides", () => {
  const original = process.env.TRUST_PROXY_HOPS;
  try {
    delete process.env.TRUST_PROXY_HOPS;
    assert.equal(trustProxyHops(), 1);

    process.env.TRUST_PROXY_HOPS = "0";
    assert.equal(trustProxyHops(), 0);

    process.env.TRUST_PROXY_HOPS = "3";
    assert.equal(trustProxyHops(), 3);

    process.env.TRUST_PROXY_HOPS = "not-a-number";
    assert.equal(trustProxyHops(), 1);

    process.env.TRUST_PROXY_HOPS = "-1";
    assert.equal(trustProxyHops(), 1);
  } finally {
    if (original === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = original;
  }
});

test("handleUnexpectedError logs and answers 500 without a stack, unless headers are already sent", () => {
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const res = {
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    handleUnexpectedError(new Error("boom"), {}, res, () => {
      throw new Error("next() must not be called when headers were not sent");
    });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: "INTERNAL_ERROR" });
    assert.equal(logged.length, 1);

    let forwarded;
    const sentRes = { headersSent: true };
    const err = new Error("already streaming");
    handleUnexpectedError(err, {}, sentRes, (nextErr) => {
      forwarded = nextErr;
    });
    assert.equal(forwarded, err);
  } finally {
    console.error = originalConsoleError;
  }
});
