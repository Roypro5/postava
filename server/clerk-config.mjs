/**
 * What "a Clerk secret key is configured" means, defined once. A value made only
 * of whitespace (an empty secret rendered by a secrets manager, a stray newline)
 * is not a key: the SDK would send it to Clerk and fail on every call. The
 * authentication wrapper (server.mjs), the Clerk proxy (clerkProxyMiddleware.mjs)
 * and the production startup warning (startup-config.mjs) all ask this function,
 * so they can never disagree about whether Clerk is set up.
 */
export function isClerkSecretKeyConfigured(value) {
  return typeof value === "string" && value.trim() !== "";
}
