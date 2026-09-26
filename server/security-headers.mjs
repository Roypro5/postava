/**
 * Security response headers, including the Content-Security-Policy.
 *
 * The CSP origin list below is a deliberate inventory of everything this app
 * actually loads (see the audit notes inline). Nothing here is guessed:
 * unresolved uncertainty (Clerk's direct Frontend API host used only outside
 * production) is handled by shipping Report-Only in that case instead of
 * silently allow-listing a guess.
 */

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

function buildDirectives({ includeClerkDevHosts }) {
  const scriptSrc = ["'self'", MEDIAPIPE_CDN, CLERK_TURNSTILE_HOST, "'wasm-unsafe-eval'"];
  const connectSrc = ["'self'", MEDIAPIPE_CDN, MEDIAPIPE_MODEL_HOST, CLERK_TELEMETRY_HOST];
  const frameSrc = [CLERK_TURNSTILE_HOST];

  if (includeClerkDevHosts) {
    scriptSrc.push(...CLERK_DEV_FRONTEND_API_HOSTS);
    connectSrc.push(...CLERK_DEV_FRONTEND_API_HOSTS);
    frameSrc.push(...CLERK_DEV_FRONTEND_API_HOSTS);
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

export function buildContentSecurityPolicy({ isProduction }) {
  return serialize(buildDirectives({ includeClerkDevHosts: !isProduction }));
}

export function securityHeaders({
  isProduction = process.env.NODE_ENV === "production",
} = {}) {
  const csp = buildContentSecurityPolicy({ isProduction });
  // Development/staging keep Clerk's direct Frontend API host reachable only
  // as Report-Only, since we cannot pin its exact subdomain (see the comment
  // above); production is fully proxied same-origin and ships enforced.
  const cspHeaderName = isProduction
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";

  return function applySecurityHeaders(_req, res, next) {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "strict-origin-when-cross-origin");
    res.set("X-Frame-Options", "DENY");
    res.set(cspHeaderName, csp);
    next();
  };
}
