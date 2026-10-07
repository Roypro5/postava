/**
 * Fail-fast checks of the environment the server needs, run once at startup
 * (see the `isMain` block of server.mjs) and never from createApp(), so tests
 * and local development keep working with throwaway values.
 *
 * In production a problem that would only surface as a 500 on the first login
 * is an error and the server refuses to start; outside production it is a
 * warning. The values themselves are never printed, only their length.
 */

import { isClerkSecretKeyConfigured } from "./clerk-config.mjs";

// HMAC-SHA256 key for the presence cookie: 256 bits is the size of the digest.
export const MIN_SESSION_SECRET_BYTES = 32;

// Length alone does not make a secret: "s".repeat(32) passes it. A random secret
// of the minimum length has a dozen distinct characters at the very least (32
// hex digits) and usually many more; fewer than this is something typed by hand.
export const MIN_SESSION_SECRET_DISTINCT_CHARS = 8;

// The example SESSION_SECRET values that ship in this repository
// (.claude/launch.json, playwright.config.mjs, tests/server-auth.test.mjs) are
// longer than the minimum but public, so in production they are as good as no
// secret at all. Matching on the fragments that make them recognizable (rather
// than on the exact strings) also catches the obvious variants of them. A random
// secret never contains one of these by chance.
const EXAMPLE_SESSION_SECRET_MARKERS = [
  "test-only-secret",
  "dev-only-secret",
  "not-for-production",
  "never-used-by-the-server",
  "changeme",
  "change-me",
];

export function isExampleSessionSecret(secret) {
  const value = String(secret).toLowerCase();
  return EXAMPLE_SESSION_SECRET_MARKERS.some((marker) => value.includes(marker));
}

// True when the value is one short unit repeated over the whole string
// ("abcabcabc...", "12345678" x 4), decided in linear time with the failure
// function of the string (the length of its longest border).
function isRepeatedPattern(value) {
  const chars = [...value];
  const border = new Array(chars.length).fill(0);
  for (let i = 1, k = 0; i < chars.length; i++) {
    while (k > 0 && chars[i] !== chars[k]) k = border[k - 1];
    if (chars[i] === chars[k]) k++;
    border[i] = k;
  }
  const period = chars.length - (border[chars.length - 1] ?? 0);
  return period < chars.length && chars.length % period === 0;
}

/**
 * Too predictable to be a secret whatever its length: fewer than
 * MIN_SESSION_SECRET_DISTINCT_CHARS distinct characters (this includes one
 * character repeated) or one short unit repeated. A random value does not trip
 * it: 48 random bytes in base64 have a few dozen distinct characters and 16 in
 * hex about a dozen, and neither is ever periodic.
 */
export function isLowEntropySessionSecret(secret) {
  const value = String(secret);
  return new Set(value).size < MIN_SESSION_SECRET_DISTINCT_CHARS || isRepeatedPattern(value);
}

/**
 * Decides the production mode before anything reads NODE_ENV (CSP, HSTS, the
 * Clerk proxy and checkStartupConfig all read it when they are created, never at
 * import time, so calling this first in the `isMain` block of server.mjs is
 * enough). Sets env.NODE_ENV = "production" when:
 *  - the `--production` flag is on the command line (`npm run start:prod`, a
 *    portable replacement for `NODE_ENV=production node ...`, which cmd.exe
 *    does not understand), or
 *  - NODE_ENV is unset and REPLIT_DEPLOYMENT === "1" (a Replit deployment, where
 *    nothing sets NODE_ENV for us). That inference is announced loudly.
 * An explicit NODE_ENV is never overridden by the Replit inference: a deployment
 * that sets NODE_ENV=development on purpose gets a warning, not a silent change.
 * Returns the warnings to print.
 */
export function applyProductionMode({ argv = process.argv.slice(2), env = process.env } = {}) {
  const warnings = [];
  const explicit = typeof env.NODE_ENV === "string" && env.NODE_ENV.trim() !== "";
  // Anything that looks like a flag but is not `--production` is most likely a typo
  // (`--prod`, `-production`) that would silently leave the server in development mode.
  for (const arg of argv) {
    if (typeof arg === "string" && arg.startsWith("-") && arg !== "--production") {
      warnings.push(
        `Unrecognized argument ${JSON.stringify(arg)} ignored (the only flag is --production): ` +
          "if you meant production mode, the server is NOT running in it.",
      );
    }
  }
  if (argv.includes("--production")) {
    if (explicit && env.NODE_ENV !== "production") {
      warnings.push(
        `--production overrides NODE_ENV=${JSON.stringify(env.NODE_ENV)}: running in PRODUCTION mode.`,
      );
    }
    env.NODE_ENV = "production";
  } else if (env.REPLIT_DEPLOYMENT === "1") {
    if (!explicit) {
      env.NODE_ENV = "production";
      warnings.push(
        "REPLIT_DEPLOYMENT=1 and NODE_ENV is not set: running in PRODUCTION mode " +
          "(enforced CSP, HSTS, Clerk proxy, fatal SESSION_SECRET checks). " +
          "Set NODE_ENV=production or start with `npm run start:prod` to make it explicit.",
      );
    } else if (env.NODE_ENV !== "production") {
      warnings.push(
        `REPLIT_DEPLOYMENT=1 but NODE_ENV=${JSON.stringify(env.NODE_ENV)}: this deployment runs WITHOUT ` +
          "production hardening (CSP is Report-Only, no HSTS, Clerk proxy off, weak SESSION_SECRET is not fatal).",
      );
    }
  }
  return warnings;
}

export function checkStartupConfig({
  env = process.env,
  isProduction = env.NODE_ENV === "production",
} = {}) {
  const errors = [];
  const warnings = [];
  // Weak or missing secrets: fatal in production, a warning elsewhere.
  const report = (message) => (isProduction ? errors : warnings).push(message);

  const secret = env.SESSION_SECRET;
  if (typeof secret !== "string" || secret === "") {
    report(
      "SESSION_SECRET is not set: sign-in cannot be completed and /api/auth/session, " +
        `/api/account and /api/stats answer 500. Set a random value of at least ${MIN_SESSION_SECRET_BYTES} bytes ` +
        "(for example `openssl rand -base64 48`) and keep it stable across restarts.",
    );
  } else if (Buffer.byteLength(secret, "utf8") < MIN_SESSION_SECRET_BYTES) {
    report(
      `SESSION_SECRET is too short (${Buffer.byteLength(secret, "utf8")} bytes, at least ` +
        `${MIN_SESSION_SECRET_BYTES} required): the presence cookie could be forged by brute force. ` +
        "Generate a longer random value (for example `openssl rand -base64 48`).",
    );
  } else if (isProduction && isExampleSessionSecret(secret)) {
    // Only in production: launch.json and the Playwright config run with these
    // on purpose. The value itself is never printed.
    errors.push(
      "SESSION_SECRET is a known example value from this repository (a development/test placeholder): " +
        "it is public, so anyone could forge the presence cookie. " +
        "Generate a random value (for example `openssl rand -base64 48`) and keep it stable across restarts.",
    );
  } else if (isProduction && isLowEntropySessionSecret(secret)) {
    // The value (and even its exact length) stays out of the message.
    errors.push(
      `SESSION_SECRET is too predictable (fewer than ${MIN_SESSION_SECRET_DISTINCT_CHARS} distinct characters, ` +
        "or a short pattern repeated): the presence cookie could be forged by guessing it. " +
        "Generate a random value (for example `openssl rand -base64 48`) and keep it stable across restarts.",
    );
  }

  if (isProduction && !isClerkSecretKeyConfigured(env.CLERK_SECRET_KEY)) {
    warnings.push(
      "CLERK_SECRET_KEY is not set: the Clerk proxy at /api/__clerk is disabled, sign-in " +
        "will not work in production and the account routes (/api/auth/session, /api/account, " +
        "/api/stats, /stats) answer 503 AUTH_UNAVAILABLE. The rest of the site, the " +
        "Pomodoro included, keeps working without accounts.",
    );
  }

  return { errors, warnings };
}
