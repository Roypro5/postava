import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { build } from "esbuild";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./server/middlewares/clerkProxyMiddleware.mjs";
import {
  clearPresenceCookie,
  createPresenceCookie,
  readPresenceCookie,
  requestHasPublicOrigin,
} from "./server/session-cookie.mjs";
import { createStatsHandlers, statsStore } from "./server/stats-store.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2]) || Number(process.env.PORT) || 5000;

export async function bundleFrontend() {
  const outfile = resolve(root, "assets/auth-adapter.bundle.js");
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(root, "auth-adapter.js")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    define: {
      "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": JSON.stringify(
        process.env.VITE_CLERK_PUBLISHABLE_KEY ??
          process.env.CLERK_PUBLISHABLE_KEY ??
          "",
      ),
      "import.meta.env.VITE_CLERK_PROXY_URL": JSON.stringify(
        process.env.VITE_CLERK_PROXY_URL ?? "",
      ),
    },
  });
}

function noStore(_req, res, next) {
  res.set("Cache-Control", "no-store");
  next();
}

function realClerkSession(req) {
  const auth = getAuth(req);
  if (!auth?.userId || !auth?.sessionId) return null;
  return { userId: auth.userId, sessionId: auth.sessionId };
}

function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    const error = new Error("SESSION_SECRET is required for app session markers");
    error.code = "SESSION_SECRET_REQUIRED";
    throw error;
  }
  return secret;
}

function authenticatedPresence(req) {
  const session = realClerkSession(req);
  if (!session) return null;

  const marker = readPresenceCookie(
    req.headers.cookie,
    session.sessionId,
    sessionSecret(),
  );
  if (!marker) return null;
  return { ...session, remember: marker.remember };
}

function sendAuthenticatedPresence(req, res) {
  try {
    const authenticated = authenticatedPresence(req);
    if (!authenticated) {
      return res.status(401).json({ error: "SESSION_REQUIRED" });
    }
    return res.json(authenticated);
  } catch (error) {
    if (error?.code === "SESSION_SECRET_REQUIRED") {
      return res.status(500).json({ error: "SESSION_CONFIGURATION_ERROR" });
    }
    throw error;
  }
}

export function trustProxyHops() {
  const raw = process.env.TRUST_PROXY_HOPS;
  if (raw === undefined || raw.trim() === "") return 1;
  const hops = Number(raw);
  return Number.isInteger(hops) && hops >= 0 ? hops : 1;
}

export function createApp() {
  const app = express();
  // Trust only the configured number of reverse-proxy hops (Replit puts one
  // in front by default) instead of blindly trusting every hop, so that
  // X-Forwarded-Host/-Proto/-For can't be spoofed by the client past that.
  app.set("trust proxy", trustProxyHops());
  app.disable("x-powered-by");

  // This raw streaming proxy must be mounted before all body parsers.
  app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
  // Browser auth endpoints are same-origin only; do not reflect arbitrary CORS origins.
  app.use(express.json({ limit: "16kb" }));
  app.use(express.urlencoded({ extended: true, limit: "16kb" }));

  app.use(
    clerkMiddleware((req) => ({
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(req) ?? "",
        process.env.CLERK_PUBLISHABLE_KEY,
      ),
    })),
  );

  app.use("/api/auth", noStore);
  app.use("/api/account", noStore);
  app.use("/api/stats", noStore);

  app.get("/api/auth/config", (req, res) => {
    res.json({
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(req) ?? "",
        process.env.CLERK_PUBLISHABLE_KEY,
      ),
      proxyUrl: process.env.VITE_CLERK_PROXY_URL ?? "",
    });
  });

  app.get("/api/auth/session", sendAuthenticatedPresence);

  app.get("/api/account", (req, res) => {
    try {
      const authenticated = authenticatedPresence(req);
      if (!authenticated) {
        return res.status(401).json({ error: "SESSION_REQUIRED" });
      }
      return res.json({ userId: authenticated.userId });
    } catch (error) {
      if (error?.code === "SESSION_SECRET_REQUIRED") {
        return res.status(500).json({ error: "SESSION_CONFIGURATION_ERROR" });
      }
      throw error;
    }
  });

  app.post("/api/auth/session", (req, res) => {
    if (!requestHasPublicOrigin(req)) {
      return res.status(403).json({ error: "UNSAFE_ORIGIN" });
    }
    const session = realClerkSession(req);
    if (!session) {
      return res.status(401).json({ error: "SESSION_REQUIRED" });
    }
    if (typeof req.body?.remember !== "boolean") {
      return res.status(400).json({ error: "INVALID_REMEMBER" });
    }

    try {
      res.set(
        "Set-Cookie",
        createPresenceCookie(
          session.sessionId,
          req.body.remember,
          sessionSecret(),
        ),
      );
    } catch (error) {
      if (error?.code === "SESSION_SECRET_REQUIRED") {
        return res.status(500).json({ error: "SESSION_CONFIGURATION_ERROR" });
      }
      throw error;
    }
    return res.status(204).end();
  });

  app.delete("/api/auth/session", (req, res) => {
    if (!requestHasPublicOrigin(req)) {
      return res.status(403).json({ error: "UNSAFE_ORIGIN" });
    }
    res.set("Set-Cookie", clearPresenceCookie());
    return res.status(204).end();
  });

  const statsHandlers = createStatsHandlers({
    store: statsStore,
    authenticatedPresence,
    requestHasPublicOrigin,
  });
  app.get("/api/stats", statsHandlers.get);
  app.post("/api/stats/sessions", statsHandlers.post);

  const publicFiles = new Map([
    ["/index.html", "index.html"],
    ["/stats.css", "stats.css"],
    ["/stats.js", "stats.js"],
    ["/stats-session.js", "stats-session.js"],
    ["/login.html", "login.html"],
    ["/app.js", "app.js"],
    ["/styles.css", "styles.css"],
    ["/theme.js", "theme.js"],
    ["/posture.js", "posture.js"],
    ["/login.css", "login.css"],
    ["/auth-adapter.js", "auth-adapter.js"],
    ["/login.js", "login.js"],
    ["/account.js", "account.js"],
    ["/logo.svg", "logo.svg"],
    ["/assets/auth-adapter.bundle.js", "assets/auth-adapter.bundle.js"],
  ]);

  app.get("/", (_req, res) => res.sendFile(resolve(root, "index.html")));
  app.get(["/stats", "/stats.html"], (req, res) => {
    try {
      if (!authenticatedPresence(req)) {
        return res.redirect(302, "/sign-in?redirect=/stats");
      }
      return res.sendFile(resolve(root, "stats.html"));
    } catch (error) {
      if (error?.code === "SESSION_SECRET_REQUIRED") {
        return res.status(500).type("text").send("Session configuration error");
      }
      throw error;
    }
  });
  app.get(["/login", "/login.html"], (_req, res) =>
    res.redirect(302, "/sign-in"),
  );
  app.get(/^\/(?:sign-in|sign-up)(?:\/.*)?$/, (_req, res) =>
    res.sendFile(resolve(root, "login.html")),
  );
  app.get("*path", (req, res, next) => {
    const file = publicFiles.get(req.path);
    if (!file) return next();
    return res.sendFile(resolve(root, file));
  });
  app.use((_req, res) => res.status(404).type("text").send("404"));

  app.use(handleUnexpectedError);

  return app;
}

// Express identifies error-handling middleware by its arity (4 args), so
// `next` must stay in the signature even though it's only used when the
// response has already started streaming.
export function handleUnexpectedError(err, _req, res, next) {
  console.error(err);
  if (res.headersSent) {
    return next(err);
  }
  return res.status(500).json({ error: "INTERNAL_ERROR" });
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await bundleFrontend();
  createApp().listen(port, () => {
    console.log(`Postava listening on port ${port}`);
  });
}
