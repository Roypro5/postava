import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_SESSION_COOKIE,
  PRESENCE_LIFETIME_SECONDS,
  createPresenceCookie,
  createPresenceValue,
  readPresenceCookie,
  requestHasPublicOrigin,
  verifyPresenceValue,
} from "../server/session-cookie.mjs";

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

test("origin must match the effective public request host", () => {
  const request = (origin, host, forwardedHost) => ({
    protocol: "https",
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
});