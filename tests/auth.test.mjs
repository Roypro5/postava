import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("uses canonical Clerk host key and unconditional production proxy wiring", async () => {
  const client = await read("client/auth-entry.jsx");
  assert.match(
    client,
    /publishableKeyFromHost\(\s*window\.location\.hostname,\s*import\.meta\.env\.VITE_CLERK_PUBLISHABLE_KEY,\s*\)/,
  );
  assert.match(client, /const clerkProxyUrl = import\.meta\.env\.VITE_CLERK_PROXY_URL;/);
  assert.match(client, /publishableKey=\{clerkPubKey\}/);
  assert.match(client, /proxyUrl=\{clerkProxyUrl\}/);
  assert.match(client, /routing="path"\s+path="\/sign-in"/);
  assert.match(client, /routing="path"\s+path="\/sign-up"/);
});

test("server mounts proxy before parsers and protects account API", async () => {
  const server = await read("server.mjs");
  const proxy = server.indexOf("app.use(CLERK_PROXY_PATH, clerkProxyMiddleware())");
  const parser = server.indexOf("app.use(express.json())");
  const auth = server.indexOf("clerkMiddleware((req)");
  assert.ok(proxy >= 0 && proxy < parser && parser < auth);
  assert.match(server, /app\.get\("\/api\/account", requireAuth/);
  assert.match(server, /status\(401\)\.json\(\{ error: "Unauthorized" \}\)/);
  assert.doesNotMatch(server, /express\.static/);
  assert.match(server, /process\.env\.NODE_ENV === "production"/);
  assert.match(server, /entryFileNames: "auth-entry\.js"/);
  assert.match(server, /server: \{ middlewareMode: true, allowedHosts: true \}/);
});

test("guest homepage keeps Pomodoro controls and mounts only an auth island", async () => {
  const html = await read("index.html");
  assert.match(html, /id="timerDisplay"/);
  assert.match(html, /id="btnStart"/);
  assert.match(html, /id="auth-root"/);
  assert.match(html, /src="\/auth-entry\.jsx"/);
  assert.match(html, /src="app\.js"/);
});

test("account pages expose sign-in, sign-up, sign-out and honest session copy", async () => {
  const [client, login] = await Promise.all([
    read("client/auth-entry.jsx"),
    read("login.html"),
  ]);
  assert.match(client, /<SignIn/);
  assert.match(client, /<SignUp/);
  assert.match(client, /signOut\(\{ redirectUrl: "\/" \}\)/);
  assert.match(client, /Cerrar la pestaña no equivale a cerrar sesión/);
  assert.doesNotMatch(login, /Recordarme|remember-me/);
});