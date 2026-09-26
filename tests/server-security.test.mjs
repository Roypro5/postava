import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { createApp } from "../server.mjs";
import { createRateLimiter } from "../server/rate-limit.mjs";
import { securityHeaders, buildContentSecurityPolicy } from "../server/security-headers.mjs";

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
