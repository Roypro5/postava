/**
 * Security response headers, including the Content-Security-Policy.
 *
 * The CSP origin list below is a deliberate inventory of everything this app
 * actually loads (see the audit notes inline). Nothing here is guessed:
 * unresolved uncertainty (Clerk's direct Frontend API host used only outside
 * production) is handled by shipping Report-Only in that case instead of
 * silently allow-listing a guess.
 *
 * One origin is dynamic: with no Clerk proxy configured (`proxyUrl` empty),
 * clerk-js talks straight to the Frontend API host encoded in the publishable
 * key, so that exact host (see clerkFrontendApiOrigin) is added to connect-src.
 */
import { parsePublishableKey } from "@clerk/shared/keys";

// MediaPipe Tasks Vision: the PoseLandmarker module (app.js `import`) and its
// wasm runtime/model glue are both fetched from jsDelivr.
const MEDIAPIPE_CDN = "https://cdn.jsdelivr.net";
// The actual pose_landmarker_lite model file is hosted on Google Cloud
// Storage and pulled with `fetch()` from app.js (MODEL_URL).
const MEDIAPIPE_MODEL_HOST = "https://storage.googleapis.com";
// clerk-js dynamically injects a Cloudflare Turnstile <script> for bot
// protection (see node_modules/@clerk/clerk-js/dist/clerk.mjs, "challenges.
// cloudflare.com/turnstile/v0/api.js") and Turnstile renders its widget in an
// iframe from the same host.
const CLERK_TURNSTILE_HOST = "https://challenges.cloudflare.com";
// clerk-js reports anonymized usage telemetry to this fixed host unless a
// caller disables it explicitly; auth-adapter.js does not, so it must stay
// reachable from connect-src.
const CLERK_TELEMETRY_HOST = "https://clerk-telemetry.com";
// styles.css `@import`s the Google Fonts stylesheet, which itself references
// font files served from fonts.gstatic.com.
const GOOGLE_FONTS_CSS_HOST = "https://fonts.googleapis.com";
const GOOGLE_FONTS_FILE_HOST = "https://fonts.gstatic.com";

// Outside production, server/middlewares/clerkProxyMiddleware.mjs is a
// passthrough (see its NODE_ENV check), so `/api/auth/config` hands the
// browser an empty proxyUrl and clerk-js falls back to talking to Clerk's
// Frontend API directly at a host derived from the publishable key
// (https://clerk.com/docs/security/clerk-csp documents this as
// "https://*.clerk.accounts.dev" for development instances). We cannot know
// the exact per-project subdomain from here, and wildcarding it in an
// *enforced* policy would be guessing at a security boundary, so development
// gets these extra hosts allow-listed under Report-Only instead of a blind
// guess enforced in the browser. Production always proxies Clerk traffic
// through this same origin and never needs them.
const CLERK_DEV_FRONTEND_API_HOSTS = [
  "https://*.clerk.accounts.dev",
  "https://*.accounts.dev",
];

// Sensitive browser features: the pose monitor needs this origin's camera
// (getUserMedia with `audio: false`); nothing here uses the microphone or
// geolocation, and no embedded frame (Turnstile) may ask for the camera.
const PERMISSIONS_POLICY = "camera=(self), microphone=(), geolocation=()";
// Six months, this host only: long enough to matter, short enough to back out
// of, and no `includeSubDomains`/`preload` since we don't control the rest of
// the domain. Only sent in production (browsers ignore it over plain HTTP).
const HSTS = "max-age=15552000";

// A plain DNS name: lowercase letters, digits and hyphens in labels of at most
// 63 characters, at least two labels, and a TLD that starts with a letter (so
// no IPv4 literal). No wildcard, port, path, userinfo or anything that could
// add a source or a directive to the header.
const CLERK_FRONTEND_API_HOST =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isSafeFrontendOrigin(origin) {
  return (
    typeof origin === "string" &&
    origin.startsWith("https://") &&
    CLERK_FRONTEND_API_HOST.test(origin.slice("https://".length))
  );
}

/**
 * The origin clerk-js contacts directly (`https://<frontendApi>`), or null.
 *
 * With a proxy (`proxyUrl` set, same-origin in production) the browser only
 * talks to this server and nothing has to be added. Without one, clerk-js uses
 * the Frontend API host encoded in the publishable key. That host is validated
 * as a strict DNS name here because in production it can derive from the
 * request's Host header (see publishableKeyFromHost) and ends up in a header.
 * An invalid key or host adds nothing.
 */
export function clerkFrontendApiOrigin({ publishableKey, proxyUrl } = {}) {
  if (proxyUrl) return null;
  if (typeof publishableKey !== "string") return null;
  let frontendApi;
  try {
    frontendApi = parsePublishableKey(publishableKey)?.frontendApi;
  } catch {
    return null;
  }
  if (typeof frontendApi !== "string") return null;
  const origin = `https://${frontendApi.toLowerCase()}`;
  return isSafeFrontendOrigin(origin) ? origin : null;
}

function buildDirectives({ includeClerkDevHosts, clerkFrontendOrigin }) {
  // No 'unsafe-inline': every script is a same-origin file. The theme
  // bootstrap that used to be inline in the <head> lives in /theme-init.js and
  // loads synchronously, so it still runs before the first paint.
  const scriptSrc = ["'self'", MEDIAPIPE_CDN, CLERK_TURNSTILE_HOST, "'wasm-unsafe-eval'"];
  const connectSrc = ["'self'", MEDIAPIPE_CDN, MEDIAPIPE_MODEL_HOST, CLERK_TELEMETRY_HOST];
  const frameSrc = [CLERK_TURNSTILE_HOST];

  if (includeClerkDevHosts) {
    scriptSrc.push(...CLERK_DEV_FRONTEND_API_HOSTS);
    connectSrc.push(...CLERK_DEV_FRONTEND_API_HOSTS);
    frameSrc.push(...CLERK_DEV_FRONTEND_API_HOSTS);
  }

  // Only connect-src: clerk-js is bundled same-origin (auth-adapter.js) and
  // never injects a <script> or <iframe> from the Frontend API host.
  if (isSafeFrontendOrigin(clerkFrontendOrigin) && !connectSrc.includes(clerkFrontendOrigin)) {
    connectSrc.push(clerkFrontendOrigin);
  }

  return {
    "default-src": ["'none'"],
    "base-uri": ["'none'"],
    "object-src": ["'none'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
    "script-src": scriptSrc,
    // No `<style>` blocks, no `style="…"` attributes, and app.js only ever
    // sets individual `element.style.prop` values (never `cssText`), so
    // style-src needs no 'unsafe-inline'.
    "style-src": ["'self'", GOOGLE_FONTS_CSS_HOST],
    "font-src": ["'self'", GOOGLE_FONTS_FILE_HOST],
    "img-src": ["'self'"],
    "connect-src": connectSrc,
    "frame-src": frameSrc,
    // clerk-js creates a Worker from a Blob URL for background session
    // polling.
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
  };
}

function serialize(directiveMap) {
  return Object.entries(directiveMap)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

export function buildContentSecurityPolicy({ isProduction, clerkFrontendOrigin } = {}) {
  return serialize(
    buildDirectives({ includeClerkDevHosts: !isProduction, clerkFrontendOrigin }),
  );
}

/**
 * `clerkFrontendOrigin(req)` (optional) returns the Clerk Frontend API origin
 * the browser will contact directly for that request, or null; see
 * clerkFrontendApiOrigin. A provider that throws or returns anything but a
 * strict `https://host` leaves the CSP unchanged.
 *
 * That origin can come from the request's host, so the same URL may carry a
 * different CSP for a different Host (or X-Forwarded-Host behind a trusted
 * proxy). `cspVariesByHost(req)` says whether it does for this request; then the
 * response says so with `Vary`, or a cache could serve the policy of one host to
 * another (a hostile Host would leave the baseline policy in the cache, and the
 * real site would lose its Clerk origin). Default: whenever there is a provider.
 * A predicate that throws counts as "varies".
 */
export function securityHeaders({
  isProduction = process.env.NODE_ENV === "production",
  clerkFrontendOrigin,
  cspVariesByHost = () => typeof clerkFrontendOrigin === "function",
} = {}) {
  const baseCsp = buildContentSecurityPolicy({ isProduction });
  // A deployment has one Frontend API origin, so remembering the last CSP built
  // is enough to avoid re-serializing it on every request.
  let lastOrigin = null;
  let lastCsp = baseCsp;
  function cspFor(req) {
    let origin = null;
    try {
      origin = clerkFrontendOrigin?.(req) ?? null;
    } catch {
      origin = null;
    }
    if (!isSafeFrontendOrigin(origin)) return baseCsp;
    if (origin !== lastOrigin) {
      lastCsp = buildContentSecurityPolicy({ isProduction, clerkFrontendOrigin: origin });
      lastOrigin = origin;
    }
    return lastCsp;
  }
  function variesByHost(req) {
    try {
      return Boolean(cspVariesByHost(req));
    } catch {
      return true;
    }
  }
  // Development/staging keep Clerk's direct Frontend API host reachable only
  // as Report-Only, since we cannot pin its exact subdomain (see the comment
  // above); production is fully proxied same-origin and ships enforced.
  const cspHeaderName = isProduction
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";

  return function applySecurityHeaders(req, res, next) {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "strict-origin-when-cross-origin");
    res.set("X-Frame-Options", "DENY");
    res.set("Permissions-Policy", PERMISSIONS_POLICY);
    // Isolates this page's browsing context group from any window that opens
    // it or that it opens (clerk-js signs in with same-page requests, not popups).
    res.set("Cross-Origin-Opener-Policy", "same-origin");
    if (isProduction) res.set("Strict-Transport-Security", HSTS);
    res.set(cspHeaderName, cspFor(req));
    if (variesByHost(req)) {
      res.vary("Host");
      res.vary("X-Forwarded-Host");
    }
    next();
  };
}
