import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("uses canonical Clerk host key and unconditional production proxy wiring", async () => {
  const [client, server] = await Promise.all([read("auth-adapter.js"), read("server.mjs")]);
  assert.match(
    server,
    /publishableKeyFromHost\(\s*getClerkProxyHost\(req\) \?\? "",\s*process\.env\.CLERK_PUBLISHABLE_KEY,\s*\)/,
  );
  assert.match(server, /proxyUrl: process\.env\.VITE_CLERK_PROXY_URL \?\? ""/);
  assert.match(client, /new Clerk\(publishableKey, \{ proxyUrl \}\)/);
  assert.match(client, /signInUrl: "\/sign-in", signUpUrl: "\/sign-up"/);
});

test("server mounts proxy before parsers and protects account API", async () => {
  const server = await read("server.mjs");
  const proxy = server.indexOf("app.use(CLERK_PROXY_PATH, clerkProxyMiddleware())");
  const parser = server.indexOf("app.use(express.json(");
  const auth = server.indexOf("clerkMiddleware((req)");
  assert.ok(proxy >= 0 && proxy < parser && parser < auth);
  assert.match(server, /app\.get\("\/api\/account"/);
  assert.match(server, /authenticatedPresence\(req\)/);
  assert.match(server, /status\(401\)\.json\(\{ error: "SESSION_REQUIRED" \}\)/);
  assert.doesNotMatch(server, /express\.static/);
  assert.match(server, /assets\/auth-adapter\.bundle\.js/);
  assert.doesNotMatch(server, /vite\.middlewares/);
});

test("guest homepage keeps Pomodoro controls and mounts only one auth client", async () => {
  const html = await read("index.html");
  assert.match(html, /id="timerDisplay"/);
  assert.match(html, /id="btnStart"/);
  assert.match(html, /src="\/account\.js"/);
  assert.doesNotMatch(html, /src="\/auth-entry\.jsx"/);
  assert.match(html, /src="app\.js"/);
});

test("account pages expose sign-in, sign-up, sign-out and honest session copy", async () => {
  const [client, login, docs] = await Promise.all([
    read("auth-adapter.js"),
    read("login.html"),
    read("replit.md"),
  ]);
  assert.match(client, /async signIn\(/);
  assert.match(client, /async signUp\(/);
  assert.match(client, /await clerk\.signOut\(\)/);
  assert.match(docs, /Browsers that restore sessions may also restore session cookies/);
  assert.match(login, /id="remember-me"/);
  assert.match(login, /equipos compartidos/);
});