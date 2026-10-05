/**
 * Canonical Clerk Frontend API proxy. Keep this middleware before body parsers:
 * it forwards the incoming request stream without reconstructing its body.
 */
import { createProxyMiddleware } from "http-proxy-middleware";
import { createRateLimiter } from "../rate-limit.mjs";
import { isClerkSecretKeyConfigured } from "../clerk-config.mjs";

const CLERK_FAPI = "https://frontend-api.clerk.dev";
export const CLERK_PROXY_PATH = "/api/__clerk";

// Clerk answers in well under a second; if the upstream goes silent this long
// (connecting, or between chunks of the answer) the client gets a 504 instead
// of a hung request. Responses that arrive without a Content-Length are held in
// memory before being sent, so they have a ceiling too (502 when exceeded).
export const CLERK_PROXY_UPSTREAM_TIMEOUT_MS = 10_000;
export const CLERK_PROXY_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

const TIMED_OUT = Symbol("postava.clerkProxyTimedOut");

function sendProxyError(res, status, error) {
  if (res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
  });
  res.end(body);
}

// Express matches the mount point without regard to case, and so does the guard
// below, so the prefix is removed the same way.
const PROXY_MOUNT_PREFIX = new RegExp(`^${CLERK_PROXY_PATH}`, "i");

/** `path` as http-proxy-middleware hands it over, with the mount prefix (any case) removed. */
export function stripClerkProxyMount(path) {
  return path.replace(PROXY_MOUNT_PREFIX, "");
}

// Every request that reaches Clerk spends this deployment's secret key and
// quota, so a client gets a per-IP ceiling. It is generous for what clerk-js
// does (a handful of calls per page load plus token refreshes) but stops a
// loop; users behind one NAT share it. Only forwarded requests count.
export const CLERK_PROXY_RATE_LIMIT = Object.freeze({ windowMs: 60_000, max: 300 });

// Only what clerk-js needs: every Frontend API call it makes goes through
// `/v1/...` (its default `pathPrefix`; the adapter bundles clerk-js with
// esbuild, so nothing is loaded from `/npm/...`). The proxy adds the Clerk
// secret key to whatever it forwards, so anything else is answered here.
export const CLERK_PROXY_ALLOWED_METHODS = Object.freeze([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
// Positive allowlist for the path (query string aside): `/v1` followed by
// segments made only of unreserved characters, so no encoded slashes or
// backslashes, `@`, `;`, `:`, spaces or empty segments (`//`) get through.
const CLERK_PROXY_PATH_PATTERN = /^\/v1(?:\/[A-Za-z0-9_.~-]+)*\/?$/;
// The allowlist admits dots, so `.` and `..` segments (which could climb out of
// `/v1`) are refused separately. The query string is left alone: redirect URLs
// there may legitimately contain them.
const DOT_SEGMENT_PATTERN = /(?:^|\/)\.{1,2}(?:\/|$)/;

// Headers a client can use to claim an IP address of its choosing. The real
// address comes from `req.ip` and is sent as X-Forwarded-For instead.
const SPOOFABLE_CLIENT_IP_HEADERS = [
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "forwarded",
];
// Headers with which a client could claim a different public host or port.
const CLIENT_FORWARDED_ORIGIN_HEADERS = ["x-forwarded-host", "x-forwarded-port"];

// Cookies owned by this app (the `__Host-postava_presence` marker, with or
// without the `__Host-`/`__Secure-` prefixes) have no business at Clerk. The
// rest of the Cookie header must still reach it: in proxy mode Clerk's own
// `__client` cookie lives on this origin and is how the Frontend API
// recognises the browser (@clerk/backend's own proxy forwards it as well).
const APP_COOKIE_NAME = /^(?:__Host-|__Secure-)?postava/i;

export function stripAppCookies(cookieHeader) {
  if (typeof cookieHeader !== "string") return "";
  return cookieHeader
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => {
      if (!pair) return false;
      const separator = pair.indexOf("=");
      const name = separator < 0 ? pair : pair.slice(0, separator).trim();
      return !APP_COOKIE_NAME.test(name);
    })
    .join("; ");
}

/** `url` is the mount-relative request URL (`/v1/client?x=1`), as Express hands it to the proxy. */
export function isAllowedClerkProxyPath(url) {
  if (typeof url !== "string") return false;
  const queryStart = url.indexOf("?");
  const path = queryStart < 0 ? url : url.slice(0, queryStart);
  return CLERK_PROXY_PATH_PATTERN.test(path) && !DOT_SEGMENT_PATTERN.test(path);
}

// host[:port] as a browser sends it: a DNS name (labels of letters, digits and
// hyphens, at most 63 characters each), an IPv4 literal (which is the same
// shape) or an IPv6 literal in brackets, and an optional port of up to 5 digits.
// It ends up inside the `Clerk-Proxy-Url` header, so nothing else (`/`, `?`,
// `#`, `@`, spaces, control characters) may pass.
const PROXY_HOST_PATTERN =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]{2,45}\])(?::[0-9]{1,5})?$/;

export function isValidProxyHost(host) {
  return typeof host === "string" && host.length <= 261 && PROXY_HOST_PATTERN.test(host);
}

function trustsForwardedHost(req) {
  // Mirrors how Express itself decides whether to honor X-Forwarded-* headers
  // (req.hostname, req.protocol, req.ip), based on the app's "trust proxy"
  // setting, instead of trusting X-Forwarded-Host unconditionally.
  const trustFn = req.app?.get?.("trust proxy fn");
  if (typeof trustFn !== "function") return false;
  const remoteAddress = req.socket?.remoteAddress ?? req.connection?.remoteAddress;
  return trustFn(remoteAddress, 0);
}

export function getClerkProxyHost(req) {
  if (trustsForwardedHost(req)) {
    const forwarded = req.headers["x-forwarded-host"];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const firstHop = raw?.split(",")[0]?.trim();
    if (firstHop) return firstHop;
  }
  return req.headers.host?.trim() || undefined;
}

/**
 * `http` or `https` as claimed by X-Forwarded-Proto, or undefined. The header
 * is only honored from a trusted hop (see trustsForwardedHost), only its first
 * value counts, and only exactly `http` or `https` is accepted.
 */
export function getTrustedForwardedProtocol(req) {
  if (!trustsForwardedHost(req)) return undefined;
  const forwarded = req.headers?.["x-forwarded-proto"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const proto = raw?.split(",")[0]?.trim().toLowerCase();
  return proto === "http" || proto === "https" ? proto : undefined;
}

/**
 * Public protocol advertised to Clerk. Like the host, X-Forwarded-Proto is
 * only honored from a trusted hop, and only when it is exactly `http` or
 * `https`; anything else (a list, garbage, another scheme) falls back to
 * `https`, which is what production always serves.
 */
export function getClerkProxyProtocol(req) {
  return getTrustedForwardedProtocol(req) ?? "https";
}

export function clerkProxyMiddleware({
  isProduction = process.env.NODE_ENV === "production",
  secretKey = process.env.CLERK_SECRET_KEY,
  // Overridable so tests can point the proxy at a local stand-in for Clerk.
  target = CLERK_FAPI,
  rateLimit = CLERK_PROXY_RATE_LIMIT,
  upstreamTimeoutMs = CLERK_PROXY_UPSTREAM_TIMEOUT_MS,
  maxBufferedBytes = CLERK_PROXY_MAX_BUFFERED_BYTES,
} = {}) {
  if (!isProduction) {
    return (_req, _res, next) => next();
  }

  // The same definition of "configured" as the rest of the server (a blank key is none).
  if (!isClerkSecretKeyConfigured(secretKey)) {
    return (_req, _res, next) => next();
  }

  // Per client IP (`req.ip`, which honors "trust proxy"), for this route only.
  const limiter = createRateLimiter({
    windowMs: rateLimit.windowMs,
    max: rateLimit.max,
    keyFn: (req) => req.ip,
  });
  limiter.startCleanup();

  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    selfHandleResponse: true,
    pathRewrite: stripClerkProxyMount,
    on: {
      error: (_err, req, res) => {
        // Own handler (the library's default answers in plain text).
        if (req[TIMED_OUT]) return sendProxyError(res, 504, "UPSTREAM_TIMEOUT");
        return sendProxyError(res, 502, "UPSTREAM_ERROR");
      },
      proxyReq: (proxyReq, req) => {
        // Inactivity timeout on the upstream socket; it also covers the wait
        // between chunks while the answer is being read.
        proxyReq.setTimeout(upstreamTimeoutMs, () => {
          req[TIMED_OUT] = true;
          proxyReq.destroy();
        });
        const protocol = getClerkProxyProtocol(req);
        const host = getClerkProxyHost(req) || "";
        proxyReq.setHeader(
          "Clerk-Proxy-Url",
          `${protocol}://${host}${CLERK_PROXY_PATH}`,
        );
        proxyReq.setHeader("Clerk-Secret-Key", secretKey);
        proxyReq.setHeader("X-Forwarded-Proto", protocol);

        // Express resolves req.ip from the "trust proxy" setting, so a value
        // the client put in X-Forwarded-For can never be picked up as its IP.
        for (const name of SPOOFABLE_CLIENT_IP_HEADERS) {
          proxyReq.removeHeader(name);
        }
        // The public host and port are conveyed by Clerk-Proxy-Url; whatever
        // the client sent about them must not reach Clerk.
        for (const name of CLIENT_FORWARDED_ORIGIN_HEADERS) {
          proxyReq.removeHeader(name);
        }
        const clientIp = req.ip || req.socket?.remoteAddress || "";
        if (clientIp) proxyReq.setHeader("X-Forwarded-For", clientIp);
        else proxyReq.removeHeader("x-forwarded-for");

        const cookie = stripAppCookies(req.headers.cookie);
        if (cookie) proxyReq.setHeader("Cookie", cookie);
        else proxyReq.removeHeader("cookie");
      },
      proxyRes: (proxyRes, req, res) => {
        const headers = { ...proxyRes.headers };
        delete headers["transfer-encoding"];
        delete headers.connection;
        delete headers["keep-alive"];

        const status = proxyRes.statusCode ?? 502;
        if (status < 200 || status === 204) delete headers["content-length"];
        const bodyless =
          req.method === "HEAD" ||
          status < 200 ||
          status === 204 ||
          status === 304;
        if (headers["content-length"] !== undefined || bodyless) {
          res.writeHead(status, headers);
          proxyRes.on("error", () => res.destroy());
          proxyRes.pipe(res);
          return;
        }

        const chunks = [];
        let buffered = 0;
        let failed = false;
        proxyRes.on("data", (chunk) => {
          if (failed) return;
          buffered += chunk.length;
          if (buffered > maxBufferedBytes) {
            failed = true;
            chunks.length = 0;
            proxyRes.destroy();
            sendProxyError(res, 502, "UPSTREAM_TOO_LARGE");
            return;
          }
          chunks.push(chunk);
        });
        proxyRes.on("end", () => {
          if (failed) return;
          const body = Buffer.concat(chunks);
          headers["content-length"] = String(body.length);
          res.writeHead(status, headers);
          res.end(body);
        });
        proxyRes.on("error", () => {
          if (failed) return;
          failed = true;
          if (req[TIMED_OUT]) sendProxyError(res, 504, "UPSTREAM_TIMEOUT");
          else sendProxyError(res, 502, "UPSTREAM_ERROR");
        });
      },
    },
  });

  return function guardedClerkProxy(req, res, next) {
    // Mounted anywhere other than CLERK_PROXY_PATH this would forward the
    // whole site (with the secret key) to Clerk: refuse and fall through.
    if (req.baseUrl?.toLowerCase() !== CLERK_PROXY_PATH.toLowerCase()) {
      return next();
    }
    if (!CLERK_PROXY_ALLOWED_METHODS.includes(req.method)) {
      res.set("Allow", CLERK_PROXY_ALLOWED_METHODS.join(", "));
      return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
    }
    if (!isAllowedClerkProxyPath(req.url)) {
      return res.status(404).json({ error: "NOT_FOUND" });
    }
    // The host is copied into the Clerk-Proxy-Url header: refuse anything that
    // is not a plain host[:port] instead of forwarding it.
    if (!isValidProxyHost(getClerkProxyHost(req))) {
      return res.status(400).json({ error: "BAD_REQUEST" });
    }
    return limiter.middleware(req, res, () => proxy(req, res, next));
  };
}
