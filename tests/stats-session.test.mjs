import test from "node:test";
import assert from "node:assert/strict";
import { bindFocusAccount, completedFocusPayload, classifyStatsSendError } from "../stats-session.js";
import { createStatsHandlers } from "../server/stats-store.mjs";

function focus() {
  return {
    accountId: null,
    startedAt: null,
    elapsedMs: 60_000,
    goodMs: 20_000,
    badMs: 10_000,
    alerts: 1,
    issues: { neck: 1, shoulders: 0, tilt: 0, distance: 0 },
  };
}

test("a block started as a guest cannot be attached to a later sign-in", () => {
  const block = focus();
  bindFocusAccount(block, null);
  block.startedAt = new Date().toISOString();
  bindFocusAccount(block, "user_abcdefgh");
  assert.equal(completedFocusPayload(block, crypto.randomUUID()), null);
});

test("a running block stays with its original account after switching accounts", () => {
  const block = focus();
  bindFocusAccount(block, "user_abcdefgh");
  block.startedAt = new Date().toISOString();
  bindFocusAccount(block, "user_ijklmnop");
  const payload = completedFocusPayload(block, crypto.randomUUID());
  assert.equal(payload.expectedUserId, "user_abcdefgh");
  assert.equal(payload.issues.neck, 1);
});

test("an in-flight retry cannot write an old account's block to the new account", async () => {
  const block = focus();
  bindFocusAccount(block, "user_abcdefgh");
  block.startedAt = new Date().toISOString();
  const payload = completedFocusPayload(block, crypto.randomUUID());
  let stored = false;
  const handlers = createStatsHandlers({
    store: { async saveSession() { stored = true; } },
    authenticatedPresence: () => ({ userId: "user_ijklmnop" }),
    requestHasPublicOrigin: () => true,
  });
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handlers.post({ body: payload }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(stored, false);
});

test("classifyStatsSendError discards non-retryable statuses and retries the rest", () => {
  assert.equal(classifyStatsSendError(400), "discard");
  assert.equal(classifyStatsSendError(409), "discard");
  assert.equal(classifyStatsSendError(401), "retry");
  assert.equal(classifyStatsSendError(500), "retry");
  assert.equal(classifyStatsSendError(undefined), "retry");
});

test("classifyStatsSendError: 422 es reject, 400/409 discard y 429/5xx/401 retry", () => {
  assert.equal(classifyStatsSendError(422), "reject");
  for (const status of [400, 409]) assert.equal(classifyStatsSendError(status), "discard");
  for (const status of [401, 429, 500, 503, undefined]) assert.equal(classifyStatsSendError(status), "retry");
});
