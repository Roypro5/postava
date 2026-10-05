import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { build } from "esbuild";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { isPublishableKey, publishableKeyFromHost } from "@clerk/shared/keys";
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
import { clerkFrontendApiOrigin, securityHeaders } from "./server/security-headers.mjs";
import { createRateLimiter } from "./server/rate-limit.mjs";
import { applyProductionMode, checkStartupConfig } from "./server/startup-config.mjs";
import { isClerkSecretKeyConfigured } from "./server/clerk-config.mjs";
import { createLogThrottle } from "./server/log-throttle.mjs";

const root = dirname(fileURLToPath(import.meta.url));
// The port is the first argument that is not a flag (`--production` may come first).
const port =
  Number(process.argv.slice(2).find((arg) => !arg.startsWith("--"))) ||
  Number(process.env.PORT) ||
  5000;

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

// Marks a request Clerk could not authenticate (see clerkAuthentication).
// realClerkSession() answers "no session" for it, so every private route fails
// closed while public routes keep working. What that closed door looks like is
// decided in sendSessionRequired: 503, not 401.
const CLERK_UNAVAILABLE = Symbol("postava.clerkUnavailable");

// Set by clerkAuthentication() once Clerk has authenticated the request and put
// its auth object on it. It is what tells a request Clerk looked at from one it
// never saw (a public route, or a private route that forgot to mount it).
const CLERK_AUTHENTICATED = Symbol("postava.clerkAuthenticated");

// The only place a session is read (the only getAuth outside the middleware's
// own check). It fails closed: a request Clerk did not authenticate, for any
// reason, has no session. getAuth() itself throws on such a request, and an
// auth object some other code left on it is not Clerk's word.
// Exported for the tests.
export function realClerkSession(req) {
  if (req[CLERK_UNAVAILABLE] || !req[CLERK_AUTHENTICATED]) return null;
  const auth = getAuth(req);
  if (!auth?.userId || !auth?.sessionId) return null;
  return { userId: auth.userId, sessionId: auth.sessionId };
}

// "Nobody is signed in" (401) and "we could not tell" (503) must stay apart:
// auth-adapter.js signs the browser out of Clerk on every 401 from
// /api/auth/session, so answering 401 while Clerk is down would log everybody
// out for the length of the outage. A 503 is treated by the client as "service
// unavailable, try again" and touches neither the session nor the pending stats.
const AUTH_UNAVAILABLE_RETRY_SECONDS = 30;

function sendAuthUnavailable(res) {
  res.set("Retry-After", String(AUTH_UNAVAILABLE_RETRY_SECONDS));
  return res.status(503).json({ error: "AUTH_UNAVAILABLE" });
}

// What a private route answers when it finds no session.
function sendSessionRequired(req, res) {
  if (req[CLERK_UNAVAILABLE]) return sendAuthUnavailable(res);
  return res.status(401).json({ error: "SESSION_REQUIRED" });
}

// Plain and static (no request data in it, no inline script or style: the CSP
// allows none) for when someone opens /stats while Clerk cannot be asked.
const AUTH_UNAVAILABLE_PAGE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Servicio de cuentas no disponible</title>
</head>
<body>
<h1>Servicio de cuentas no disponible</h1>
<p>No podemos comprobar tu sesión ahora mismo. Tu sesión sigue abierta: vuelve a intentarlo en unos minutos.</p>
<p><a href="/stats">Reintentar</a> · <a href="/">Volver al Pomodoro</a> (funciona sin cuenta).</p>
</body>
</html>
`;

// The publishable key clerk-js and the SDK use for this request: the configured
// development key as is, otherwise one derived from the public host.
function resolvePublishableKey(req) {
  return publishableKeyFromHost(
    getClerkProxyHost(req) ?? "",
    process.env.CLERK_PUBLISHABLE_KEY,
  );
}

function clerkBrowserConfig(req) {
  let publishableKey = "";
  try {
    publishableKey = resolvePublishableKey(req);
  } catch {
    // No usable host: the client reports accounts as unavailable.
  }
  return {
    publishableKey,
    proxyUrl: process.env.VITE_CLERK_PROXY_URL ?? "",
  };
}

// Why Clerk cannot authenticate, as a closed set: the log line is built from
// these texts and never from the request or the error, so a client cannot put
// words (or a Host) into the operator's log, nor pass one reason off as another.
const CLERK_UNAVAILABLE_REASONS = Object.freeze({
  "secret-key-missing": "CLERK_SECRET_KEY is not set",
  "publishable-key-invalid": "the Clerk publishable key is not valid",
  "host-unresolvable": "no Clerk publishable key can be resolved for the host of a request",
  "clerk-error": "the Clerk SDK failed while authenticating a request",
  "clerk-unreachable":
    "Clerk could not be reached to verify a session; CLERK_JWT_KEY would let sessions be verified without calling it",
});

// The SDK does not throw when it cannot verify a session because Clerk is
// unreachable (its signing keys cannot be loaded, a token refresh fails): it
// reports the request as signed out and puts one of these reasons in the debug
// data of the auth object. That is "we could not tell", not "nobody is signed
// in". Any other reason (no cookie, bad signature, expired, unknown key) is a
// genuine absence of a session and keeps answering 401.
const CLERK_SERVICE_FAILURE_REASONS = new Set([
  "jwk-remote-failed-to-load",
  "unexpected-error",
  "session-token-expired-refresh-fetch-error",
  "session-token-expired-refresh-unexpected-bapi-error",
]);

// Only a request that carries a session cookie can need Clerk to verify it, and
// asking is cheap enough for those (the auth object is already built).
function clerkCouldNotVerify(req) {
  if (!req.headers.cookie?.includes("__session")) return false;
  try {
    const auth = getAuth(req);
    if (auth?.userId) return false;
    const reason = auth?.debug?.()?.reason;
    return typeof reason === "string" && CLERK_SERVICE_FAILURE_REASONS.has(reason);
  } catch {
    return false;
  }
}

// Why Clerk cannot authenticate this request (a key of CLERK_UNAVAILABLE_REASONS),
// or null when it can. These are the two things the SDK asserts on every call (a
// non-empty secret key and a parseable publishable key); without them it throws,
// and it must not take the whole site down with it.
function clerkConfigProblem(req) {
  if (!isClerkSecretKeyConfigured(process.env.CLERK_SECRET_KEY)) return "secret-key-missing";
  try {
    if (!isPublishableKey(resolvePublishableKey(req))) return "publishable-key-invalid";
  } catch {
    return "host-unresolvable";
  }
  return null;
}

// A short, machine-made tag for the error (a Node system code such as
// ECONNREFUSED, or the class name), never its message: messages can quote the
// request. Anything that is not a plain token is dropped.
function errorTag(err) {
  const candidate = err?.code ?? err?.cause?.code ?? err?.name;
  return typeof candidate === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(candidate)
    ? candidate
    : "Error";
}

/**
 * Clerk authentication for the private routes, and only for them (rule 2: the
 * Pomodoro works without an account, with Clerk down or offline).
 *
 * It is NOT mounted globally, on purpose. @clerk/express answers a document
 * navigation from a visitor with no dev-browser cookie (any browser, on a
 * development instance: pk_test_...) with a 307 "handshake" to the Clerk
 * Frontend API, whatever the path is: `/`, the scripts and the styles included.
 * With Clerk unreachable the home page would not even load. So createApp()
 * mounts one instance of this on exactly the routes that read a session (see
 * `withClerk` there); the home page, the static allowlist, /sign-in, /sign-up,
 * /api/auth/config, the local sign-out and the Clerk proxy never reach it.
 *
 * It can never take a private route down with a 500 either. When Clerk is not
 * configured, or its middleware fails, the request goes on flagged
 * CLERK_UNAVAILABLE instead, and every private route treats it as having no
 * session and answers 503 AUTH_UNAVAILABLE (see sendSessionRequired).
 *
 * The operator is told at most once a minute per reason (with how many requests
 * that stands for), so a persistent outage keeps showing up and a hostile client
 * cannot use up the notice; no key, host or client text is ever printed.
 */
function clerkAuthentication() {
  const authenticate = clerkMiddleware((req) => ({
    publishableKey: resolvePublishableKey(req),
  }));
  const admit = createLogThrottle();

  function proceedWithoutClerk(req, next, reason, err) {
    req[CLERK_UNAVAILABLE] = true;
    const { log, suppressed } = admit(reason);
    if (log) {
      const tag = err === undefined ? "" : ` [${errorTag(err)}]`;
      const more = suppressed > 0 ? ` ${suppressed} more request(s) were affected since the last notice.` : "";
      console.warn(
        `[auth] Clerk cannot authenticate requests (${CLERK_UNAVAILABLE_REASONS[reason]}${tag}): ` +
          "account routes answer 503 AUTH_UNAVAILABLE and the rest of the site keeps working " +
          `without accounts.${more}`,
      );
    }
    next();
  }

  return function clerkAuthenticationMiddleware(req, res, next) {
    // Only the session cookies authenticate a request to this server: the client
    // is same-origin and cookie-based and never sends its own Authorization header
    // (replit.md; clerk-js only sends one to third-party analytics). The SDK would
    // otherwise honor a "Bearer" header ahead of the cookies, and a machine-token
    // prefix (mt_, oat_, ak_) makes it call Clerk's API on every request it sees.
    // (The Clerk proxy, which does forward what the client sent, never gets here.)
    delete req.headers.authorization;

    const problem = clerkConfigProblem(req);
    if (problem) return proceedWithoutClerk(req, next, problem);
    return authenticate(req, res, (err) => {
      if (err) return proceedWithoutClerk(req, next, "clerk-error", err);
      if (clerkCouldNotVerify(req)) return proceedWithoutClerk(req, next, "clerk-unreachable");
      req[CLERK_AUTHENTICATED] = true;
      return next();
    });
  };
}

// The JSON API is only ever called with fetch() (Sec-Fetch-Dest: empty), never
// navigated to, so a handshake redirect to Clerk has no place there: it would
// only ever show up for someone who typed the URL in the address bar. The SDK
// takes a request for a navigation when it says so (Sec-Fetch-Dest: document or
// iframe, or no Sec-Fetch-Dest and Accept: text/html); stating what the API
// really is keeps it answering 401/503 as JSON. Mounted right before Clerk, on
// the API routes only: /stats is a page and keeps the SDK's own judgment.
function notANavigation(req, _res, next) {
  req.headers["sec-fetch-dest"] = "empty";
  next();
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
    if (!authenticated) return sendSessionRequired(req, res);
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

// `store` is only overridden by tests, to run the stats routes without a database.
export function createApp({ store = statsStore } = {}) {
  const app = express();
  // Trust only the configured number of reverse-proxy hops (Replit puts one
  // in front by default) instead of blindly trusting every hop, so that
  // X-Forwarded-Host/-Proto/-For can't be spoofed by the client past that.
  app.set("trust proxy", trustProxyHops());
  app.disable("x-powered-by");

  // With no proxyUrl, clerk-js talks to Clerk's Frontend API directly and the
  // CSP must allow exactly that host; it is the same key /api/auth/config hands
  // to the browser, so both are derived from clerkBrowserConfig(). Without a
  // proxy that key (and so the CSP) comes from the request's host, which is what
  // the Vary header on those responses is for.
  app.use(
    securityHeaders({
      clerkFrontendOrigin: (req) => clerkFrontendApiOrigin(clerkBrowserConfig(req)),
      cspVariesByHost: (req) => !clerkBrowserConfig(req).proxyUrl,
    }),
  );

  // Liveness only (no database, no auth, no rate limit): "the process answers".
  app.get("/healthz", noStore, (_req, res) => res.json({ ok: true }));

  // This raw streaming proxy must be mounted before all body parsers.
  app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
  // Browser auth endpoints are same-origin only; do not reflect arbitrary CORS origins.
  // JSON only: no route reads form-encoded bodies (login is handled by
  // clerk-js, not by a <form> POST), so no urlencoded parser is mounted.
  app.use(express.json({ limit: "16kb" }));

  // Clerk is mounted route by route, never with app.use() (see clerkAuthentication
  // for why): ONLY the routes below that read a session list it, always first
  // (after notANavigation on the API), because the rate limiters and the handlers
  // need the verified identity. One shared instance, so the operator's notice is
  // throttled for the whole app. A route that reads a session without it has no
  // session (realClerkSession).
  const withClerk = clerkAuthentication();
  const withClerkForApi = [notANavigation, withClerk];

  app.use("/api/auth", noStore);
  app.use("/api/account", noStore);
  app.use("/api/stats", noStore);

  // Keyed by the verified Clerk user when available (so one account can't be
  // starved by another sharing a NAT/proxy IP), falling back to the request
  // IP for anonymous callers. `req.ip` honors "trust proxy" (see
  // trustProxyHops): with the wrong hop count every visitor behind a proxy
  // would share one bucket, and a client-written X-Forwarded-For can never
  // pick its own bucket. Each createApp() call gets its own limiter
  // instances, so tests never leak rate-limit state between apps.
  const rateLimitKey = (req) => realClerkSession(req)?.userId || req.ip;
  const limiters = {
    authSessionWrite: createRateLimiter({ windowMs: 60_000, max: 30, keyFn: rateLimitKey }),
    statsSessionWrite: createRateLimiter({ windowMs: 60_000, max: 30, keyFn: rateLimitKey }),
    // GET /api/auth/session and GET /api/account share one bucket per caller;
    // the client asks once per page load, so 60/min is far above real use.
    sessionRead: createRateLimiter({ windowMs: 60_000, max: 60, keyFn: rateLimitKey }),
    statsRead: createRateLimiter({ windowMs: 60_000, max: 60, keyFn: rateLimitKey }),
  };
  for (const limiter of Object.values(limiters)) limiter.startCleanup();

  app.get("/api/auth/config", (req, res) => {
    res.json(clerkBrowserConfig(req));
  });

  app.get("/api/auth/session", withClerkForApi, limiters.sessionRead.middleware, sendAuthenticatedPresence);

  app.get("/api/account", withClerkForApi, limiters.sessionRead.middleware, (req, res) => {
    try {
      const authenticated = authenticatedPresence(req);
      if (!authenticated) return sendSessionRequired(req, res);
      return res.json({ userId: authenticated.userId });
    } catch (error) {
      if (error?.code === "SESSION_SECRET_REQUIRED") {
        return res.status(500).json({ error: "SESSION_CONFIGURATION_ERROR" });
      }
      throw error;
    }
  });

  app.post("/api/auth/session", withClerkForApi, limiters.authSessionWrite.middleware, (req, res) => {
    if (!requestHasPublicOrigin(req)) {
      return res.status(403).json({ error: "UNSAFE_ORIGIN" });
    }
    const session = realClerkSession(req);
    if (!session) return sendSessionRequired(req, res);
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

  // Signing out locally only clears our own cookie, so it takes no Clerk and
  // keeps working while Clerk is down.
  app.delete("/api/auth/session", (req, res) => {
    if (!requestHasPublicOrigin(req)) {
      return res.status(403).json({ error: "UNSAFE_ORIGIN" });
    }
    res.set("Set-Cookie", clearPresenceCookie());
    return res.status(204).end();
  });

  const statsHandlers = createStatsHandlers({
    store,
    authenticatedPresence,
    requestHasPublicOrigin,
    sendSessionRequired,
  });
  app.get("/api/stats", withClerkForApi, limiters.statsRead.middleware, statsHandlers.get);
  app.post("/api/stats/sessions", withClerkForApi, limiters.statsSessionWrite.middleware, statsHandlers.post);

  const publicFiles = new Map([
    ["/index.html", "index.html"],
    ["/stats.css", "stats.css"],
    ["/stats.js", "stats.js"],
    ["/stats-math.js", "stats-math.js"],
    ["/stats-session.js", "stats-session.js"],
    ["/stats-queue.js", "stats-queue.js"],
    ["/focus-stats.js", "focus-stats.js"],
    ["/timer.js", "timer.js"],
    ["/app.js", "app.js"],
    ["/styles.css", "styles.css"],
    ["/theme.js", "theme.js"],
    ["/theme-init.js", "theme-init.js"],
    ["/posture.js", "posture.js"],
    ["/posture-monitor.js", "posture-monitor.js"],
    ["/notifications.js", "notifications.js"],
    ["/camera-utils.js", "camera-utils.js"],
    ["/camera.js", "camera.js"],
    ["/ui.js", "ui.js"],
    ["/dom.js", "dom.js"],
    ["/sound.js", "sound.js"],
    ["/settings.js", "settings.js"],
    ["/overlay.js", "overlay.js"],
    ["/login.css", "login.css"],
    ["/auth-adapter.js", "auth-adapter.js"],
    ["/login.js", "login.js"],
    ["/account.js", "account.js"],
    ["/logo.svg", "logo.svg"],
    ["/assets/auth-adapter.bundle.js", "assets/auth-adapter.bundle.js"],
  ]);

  app.get("/", (_req, res) => res.sendFile(resolve(root, "index.html")));
  // A page that exists only for a signed-in person, and whose answer (page,
  // redirect or 503) depends on who asks: never for a shared cache or the disk.
  const privatePage = (_req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    next();
  };
  // The one page that does go through Clerk, because it is only for a signed-in
  // person and cannot be served without asking Clerk who is there. As with any
  // document navigation, a development instance (pk_test_...) may answer a first
  // visit that has no dev-browser cookie yet with Clerk's 307 handshake. That is
  // accepted here, and only here: the Pomodoro and every other page are
  // untouched, and with Clerk down /stats is the one thing that cannot load
  // (the 503 page below when the SDK reports the outage; the browser's own error
  // when the handshake itself cannot reach Clerk).
  app.get(["/stats", "/stats.html"], withClerk, privatePage, (req, res) => {
    try {
      if (!authenticatedPresence(req)) {
        if (req[CLERK_UNAVAILABLE]) {
          res.set("Retry-After", String(AUTH_UNAVAILABLE_RETRY_SECONDS));
          return res.status(503).type("html").send(AUTH_UNAVAILABLE_PAGE);
        }
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
  app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((_req, res) => res.status(404).type("text").send("404"));

  app.use(handleUnexpectedError);

  return app;
}

// Express identifies error-handling middleware by its arity (4 args), so
// `next` must stay in the signature even though it's only used when the
// response has already started streaming.
export function handleUnexpectedError(err, _req, res, next) {
  const clientStatus = clientErrorStatus(err);
  if (clientStatus === null) {
    console.error(err);
  } else {
    // Client mistakes (malformed JSON, oversized body, aborted upload) are not
    // server faults: no stack, and never `err.body`, which body-parser fills
    // with the raw request body.
    console.warn(`[http] ${clientStatus} ${describeClientError(err)}`);
  }
  if (res.headersSent) {
    return next(err);
  }
  if (clientStatus === null) {
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
  return res
    .status(clientStatus)
    .json({ error: clientStatus === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST" });
}

// body-parser and http-errors report the client's fault as `status` (some
// libraries use `statusCode`): any integer 4xx keeps its code.
function clientErrorStatus(err) {
  const status = err?.status ?? err?.statusCode;
  return Number.isInteger(status) && status >= 400 && status < 500 ? status : null;
}

// body-parser tags its errors with a fixed `type` (entity.parse.failed,
// entity.too.large, request.aborted...). That is what gets logged for them: the
// message of a malformed-JSON SyntaxError quotes the text around the failure,
// i.e. part of the body. Anything else logs a single line of its message.
function describeClientError(err) {
  if (typeof err?.type === "string" && /^[a-z][a-z.]{0,39}$/.test(err.type)) {
    return err.type;
  }
  return String(err?.message ?? "client error").split("\n", 1)[0].slice(0, 200);
}

export const SHUTDOWN_FORCE_EXIT_MS = 10_000;
const SHUTDOWN_SWEEP_MS = 100;

/**
 * Graceful shutdown: stop accepting connections, drop idle keep-alive sockets,
 * let in-flight requests finish, close the database pool, then exit. A timer
 * (unref'd, so it never keeps the process alive by itself) forces exit(1) if
 * that takes longer than `timeoutMs`. Everything it touches is injected so it
 * can be tested without signals or a real process.
 *
 * `closeResources` is an async function (e.g. () => statsStore.close()).
 * Returns { shutdown(signal), install() }; install() hooks SIGTERM, SIGINT and SIGBREAK.
 */
export function createGracefulShutdown({
  server,
  closeResources = async () => {},
  proc = process,
  timeoutMs = SHUTDOWN_FORCE_EXIT_MS,
  log = console,
} = {}) {
  let running = null;
  let sweeper = null;

  function shutdown(signal = "SIGTERM") {
    if (running) return running;
    log.log(`[shutdown] ${signal} received: closing the server`);
    const timer = setTimeout(() => {
      log.error(`[shutdown] timed out after ${timeoutMs} ms, forcing exit`);
      proc.exit(1);
    }, timeoutMs);
    timer.unref?.();

    running = (async () => {
      let code = 0;
      try {
        // Answers sent from now on tell keep-alive clients to go away.
        server.prependListener?.("request", (_req, res) => {
          if (!res.headersSent) res.setHeader("Connection", "close");
        });
        const closed = new Promise((resolveClosed) => {
          // server.close() calls back once every connection has ended; the
          // error (server not running) only means there is nothing to wait for.
          server.close(() => resolveClosed());
        });
        // A keep-alive socket only becomes idle once its in-flight request is
        // answered, so sweep until the server reports it is closed.
        server.closeIdleConnections?.();
        sweeper = setInterval(() => server.closeIdleConnections?.(), SHUTDOWN_SWEEP_MS);
        sweeper.unref?.();
        await closed;
        clearInterval(sweeper);
        await closeResources();
      } catch (error) {
        log.error("[shutdown] error while closing:", error?.code ?? error?.name ?? "Error");
        code = 1;
      }
      clearInterval(sweeper);
      clearTimeout(timer);
      proc.exit(code);
    })();
    return running;
  }

  function install() {
    // SIGBREAK is what Windows sends on Ctrl+Break / console close. A second
    // signal while shutting down (double Ctrl+C) means "now": exit(1) at once.
    for (const signal of ["SIGTERM", "SIGINT", "SIGBREAK"]) {
      proc.on(signal, () => {
        if (running) {
          log.error(`[shutdown] second ${signal}: forcing exit`);
          proc.exit(1);
          return;
        }
        void shutdown(signal);
      });
    }
  }

  return { shutdown, install };
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  // First of all: it sets NODE_ENV, which everything below reads. Note: dependencies that read
  // NODE_ENV at import time (the static imports above) already saw the old value.
  for (const warning of applyProductionMode()) console.warn(`[config] WARNING: ${warning}`);
  const { errors, warnings } = checkStartupConfig();
  for (const warning of warnings) console.warn(`[config] Warning: ${warning}`);
  if (errors.length > 0) {
    // Fail fast, before building or listening. The exit code is set instead of
    // calling process.exit() so the messages are flushed first.
    for (const error of errors) console.error(`[config] Error: ${error}`);
    console.error("[config] Refusing to start with NODE_ENV=production.");
    process.exitCode = 1;
  } else {
    await bundleFrontend();
    const server = createApp().listen(port, () => {
      console.log(`Postava listening on port ${port}`);
    });
    createGracefulShutdown({
      server,
      closeResources: () => statsStore.close(),
    }).install();
  }
}
