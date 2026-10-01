import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthAdapter, authError } from "../auth-adapter.js";

function setup() {
  const calls = [];
  const complete = { status: "complete", createdSessionId: "test-session" };
  const signIn = {
    status: "needs_first_factor",
    supportedFirstFactors: [{ strategy: "reset_password_email_code", emailAddressId: "test-email" }],
    create: async values => { calls.push(["credentials", values]); return complete; },
    attemptFirstFactor: async values => { calls.push(["verify", values]); signIn.status = "needs_new_password"; return signIn; },
    resetPassword: async values => { calls.push(["reset", values]); return complete; },
  };
  const clerk = {
    session: { id: "test-session" }, user: { id: "test-user" }, client: { signIn },
    setActive: async values => calls.push(["active", values]),
    signOut: async () => calls.push(["signout"]),
  };
  const request = async (url, options) => { calls.push(["request", url, options]); return { ok: true, status: 204 }; };
  return { clerk, calls, request };
}

test("login establishes provider session then signed persistence preference without password", async () => {
  const { clerk, calls, request } = setup();
  const adapter = createAuthAdapter(clerk, request);
  assert.deepEqual(await adapter.signIn({ email: "test@example.com", password: "only-to-provider", remember: true }), { step: "complete" });
  const [, url, options] = calls.find(c => c[0] === "request");
  assert.equal(url, "/api/auth/session");
  assert.deepEqual(JSON.parse(options.body), { remember: true });
  assert.equal(options.credentials, "same-origin");
  assert.ok(calls.findIndex(c => c[0] === "active") < calls.findIndex(c => c[0] === "request"));
});
test("failed session creation revokes newly activated provider session", async () => {
  const { clerk, calls } = setup();
  const adapter = createAuthAdapter(clerk, async () => ({ ok: false }));
  await assert.rejects(adapter.signIn({ email: "test@example.com", password: "test", remember: false }), /SESSION_UNAVAILABLE/);
  assert.ok(calls.some(c => c[0] === "signout"));
});
test("missing browser-presence marker signs out; network failure does not masquerade as logout", async () => {
  const { clerk, calls } = setup();
  assert.equal(await createAuthAdapter(clerk, async () => ({ status: 401 })).restore(), null);
  assert.equal(calls.length, 1);
  await assert.rejects(createAuthAdapter(clerk, async () => ({ status: 503, ok: false })).restore());
  assert.equal(calls.length, 1);
});
test("reset verifies code, revokes other sessions and allows password retry without reused OTP", async () => {
  const { clerk, calls, request } = setup();
  clerk.client.signIn.create = async () => clerk.client.signIn;
  const adapter = createAuthAdapter(clerk, request);
  await adapter.recover("test@example.com");
  await adapter.reset("123456", "new-passphrase", false);
  await adapter.reset("123456", "newer-passphrase", false);
  assert.equal(calls.filter(c => c[0] === "verify").length, 1);
  assert.deepEqual(calls.find(c => c[0] === "reset")[1], { password: "new-passphrase", signOutOfOtherSessions: true });
});
test("recovery resend supplies the provider email identifier", async () => {
  const { clerk, calls, request } = setup();
  clerk.client.signIn.create = async () => clerk.client.signIn;
  clerk.client.signIn.prepareFirstFactor = async values => calls.push(["resend", values]);
  const adapter = createAuthAdapter(clerk, request);
  await adapter.recover("test@example.com");
  await adapter.resend("reset-code");
  assert.deepEqual(calls[0], ["resend", { strategy: "reset_password_email_code", emailAddressId: "test-email" }]);
});
test("failed recovery cannot reuse an earlier account's pending verification", async () => {
  const { clerk, calls, request } = setup();
  clerk.client.signIn.create = async () => clerk.client.signIn;
  const adapter = createAuthAdapter(clerk, request);
  await adapter.recover("first@example.com");
  clerk.client.signIn.create = async () => { throw new Error("unknown account"); };
  await assert.rejects(adapter.recover("unknown@example.com"));
  await assert.rejects(adapter.reset("123456", "new-passphrase", false), /RECOVERY_NOT_STARTED/);
  await assert.rejects(adapter.resend("reset-code"), /RECOVERY_NOT_STARTED/);
  assert.equal(calls.length, 0);
});
test("incorrect recovery code never changes password or establishes session", async () => {
  const { clerk, calls, request } = setup();
  clerk.client.signIn.create = async () => clerk.client.signIn;
  clerk.client.signIn.attemptFirstFactor = async () => { throw new Error("invalid code"); };
  const adapter = createAuthAdapter(clerk, request);
  await adapter.recover("test@example.com");
  await assert.rejects(adapter.reset("bad-code", "new-passphrase", true), /invalid code/);
  assert.equal(calls.length, 0);
});
test("recovery of a nonexistent account is indistinguishable from a real account with a wrong code", async () => {
  const unknownError = new Error("not found");
  unknownError.errors = [{ code: "form_identifier_not_found" }];
  const { clerk: unknownClerk, request: unknownRequest } = setup();
  unknownClerk.client.signIn.create = async () => { throw unknownError; };
  const unknownAdapter = createAuthAdapter(unknownClerk, unknownRequest);
  assert.deepEqual(await unknownAdapter.recover("unknown@example.com"), { step: "reset-code" });
  const unknownStart = Date.now();
  let unknownMessage;
  await assert.rejects(unknownAdapter.reset("000000", "new-passphrase", false), error => {
    unknownMessage = authError(error);
    return true;
  });
  assert.ok(Date.now() - unknownStart >= 250, "masked reset should not resolve instantly");
  await assert.doesNotReject(unknownAdapter.resend("reset-code"));

  const { clerk: realClerk, request: realRequest } = setup();
  realClerk.client.signIn.create = async () => realClerk.client.signIn;
  realClerk.client.signIn.attemptFirstFactor = async () => {
    const error = new Error("wrong code");
    error.errors = [{ code: "form_code_incorrect" }];
    throw error;
  };
  const realAdapter = createAuthAdapter(realClerk, realRequest);
  await realAdapter.recover("real@example.com");
  let realMessage;
  await assert.rejects(realAdapter.reset("000000", "new-passphrase", false), error => {
    realMessage = authError(error);
    return true;
  });

  assert.equal(unknownMessage, realMessage);
  assert.equal(unknownMessage, "El código no es válido. Revísalo e inténtalo de nuevo.");
});
test("registration awaits email verification before setting session with remember choice", async () => {
  const { clerk, calls, request } = setup();
  const signup = {
    status: "missing_requirements",
    prepareEmailAddressVerification: async values => calls.push(["send", values]),
    attemptEmailAddressVerification: async values => {
      calls.push(["verify-email", values]);
      return { status: "complete", createdSessionId: "test-session" };
    },
  };
  clerk.client.signUp = { ...signup, create: async () => signup };
  const adapter = createAuthAdapter(clerk, request);
  assert.deepEqual(await adapter.signUp({ email: "test@example.com", password: "test-password", remember: true }), { step: "verify-email" });
  assert.equal(calls.some(c => c[0] === "active"), false);
  assert.deepEqual(await adapter.verifyEmail("123456"), { step: "complete" });
  assert.deepEqual(JSON.parse(calls.find(c => c[0] === "request")[2].body), { remember: true });
});
test("logout uses Clerk SDK before clearing app marker", async () => {
  const { clerk, calls, request } = setup();
  await createAuthAdapter(clerk, request).signOut();
  assert.equal(calls[0][0], "signout");
  assert.equal(calls[1][2].method, "DELETE");
});
test("logout completes even when clearing the presence cookie fails over the network", async () => {
  const { clerk, calls } = setup();
  const request = async () => { throw new Error("network down"); };
  await assert.doesNotReject(createAuthAdapter(clerk, request).signOut());
  assert.ok(calls.some(c => c[0] === "signout"));
});
test("provider errors are mapped without reflecting arbitrary provider messages", () => {
  assert.match(authError({ errors: [{ code: "form_code_incorrect" }] }), /código no es válido/);
  const shortPassword = authError({ errors: [{ code: "form_password_length_too_short" }] });
  assert.match(shortPassword, /longitud mínima configurada/);
  assert.doesNotMatch(shortPassword, /8 caracteres/);
  assert.match(authError({ status: 429 }), /Demasiados intentos/);
  assert.match(authError({ errors: [{ code: "form_identifier_exists" }] }), /correo ya está registrado.*recuperar el acceso/);
  assert.doesNotMatch(authError({ message: "sensitive data" }), /sensitive data/);
});