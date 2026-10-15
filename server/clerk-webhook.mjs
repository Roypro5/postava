/**
 * Clerk webhook handler for Postora (task T3.2 / A13).
 *
 * Listens for machine-to-machine webhook events from Clerk via Svix.
 *
 * Security & Design decisions:
 * - RULE 4 COMPLIANCE: This is a server-to-server (M2M) webhook endpoint,
 *   not a browser user session. Authentication is established cryptographically
 *   using Svix HMAC-SHA256 signatures with CLERK_WEBHOOK_SIGNING_SECRET. It does
 *   not use the browser presence cookie, and does not violate Rule 4.
 * - ZERO THIRD-PARTY DEPENDENCIES: Verified natively using Node's `node:crypto`
 *   (HMAC-SHA256, timingSafeEqual), avoiding supply-chain risks and external npm
 *   packages.
 * - IDEMPOTENCY: Upon receiving `user.deleted`, it calls `store.deleteAll(userId)`.
 *   If the user has no sessions or the event is delivered again, it returns 200 OK.
 * - UNHANDLED EVENTS: Any validly-signed event other than `user.deleted` returns
 *   200 OK (ignored) so Clerk does not reattempt delivery.
 * - PRIVACY: Logs never print the `user_id`, raw request, or secrets.
 */

import crypto from "node:crypto";
import { describeDbError } from "./stats-store.mjs";

export const DEFAULT_TOLERANCE_SECONDS = 300; // 5 minutes
const CLERK_USER_ID_PATTERN = /^user_[a-zA-Z0-9_-]{1,160}$/;

/**
 * Decodes a Svix signing secret.
 * Svix secrets can be prefixed with "whsec_" and are base64-encoded.
 */
export function parseSigningSecret(secret) {
  if (typeof secret !== "string" || !secret.trim()) {
    throw new Error("SECRET_REQUIRED");
  }
  const trimmed = secret.trim();
  const clean = trimmed.startsWith("whsec_") ? trimmed.slice("whsec_".length) : trimmed;
  return Buffer.from(clean, "base64");
}

/**
 * Helper to compute Svix headers (used in tests or signature creation).
 */
export function generateSvixHeaders({
  payload,
  secret,
  svixId = `msg_${crypto.randomBytes(12).toString("hex")}`,
  timestamp = Math.floor(Date.now() / 1000),
}) {
  const secretBuf = parseSigningSecret(secret);
  const bodyBuf = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  const prefix = Buffer.from(`${svixId}.${timestamp}.`, "utf8");
  const toSign = Buffer.concat([prefix, bodyBuf]);
  const sig = crypto.createHmac("sha256", secretBuf).update(toSign).digest("base64");
  return {
    "svix-id": svixId,
    "svix-timestamp": String(timestamp),
    "svix-signature": `v1,${sig}`,
  };
}

/**
 * Verifies a Svix webhook signature.
 *
 * @param {Object} options
 * @param {Buffer|string} options.payload - Raw request body
 * @param {Object} options.headers - HTTP request headers
 * @param {string} options.secret - CLERK_WEBHOOK_SIGNING_SECRET
 * @param {number} [options.toleranceSeconds] - Max clock drift in seconds (default 300)
 * @param {Function} [options.now] - Current time in ms (default Date.now)
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifySvixSignature({
  payload,
  headers,
  secret,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  now = () => Date.now(),
}) {
  if (!secret) {
    return { valid: false, reason: "SECRET_MISSING" };
  }

  // Header lookup (case-insensitive)
  const getHeader = (name) => {
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers || {})) {
      if (key.toLowerCase() === target) {
        return typeof value === "string" ? value : Array.isArray(value) ? value[0] : null;
      }
    }
    return null;
  };

  const svixId = getHeader("svix-id");
  const svixTimestamp = getHeader("svix-timestamp");
  const svixSignature = getHeader("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return { valid: false, reason: "MISSING_HEADERS" };
  }

  if (!/^\d+$/.test(svixTimestamp)) {
    return { valid: false, reason: "INVALID_TIMESTAMP" };
  }

  const timestampNum = parseInt(svixTimestamp, 10);
  if (!Number.isFinite(timestampNum)) {
    return { valid: false, reason: "INVALID_TIMESTAMP" };
  }

  const nowSec = Math.floor(now() / 1000);
  if (Math.abs(nowSec - timestampNum) > toleranceSeconds) {
    return { valid: false, reason: "TIMESTAMP_OUT_OF_RANGE" };
  }

  let secretBuf;
  try {
    secretBuf = parseSigningSecret(secret);
    if (secretBuf.length === 0) {
      return { valid: false, reason: "INVALID_SECRET" };
    }
  } catch {
    return { valid: false, reason: "INVALID_SECRET" };
  }

  const bodyBuf = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === "string" ? payload : "", "utf8");
  const prefix = Buffer.from(`${svixId}.${svixTimestamp}.`, "utf8");
  const messageToSign = Buffer.concat([prefix, bodyBuf]);

  const computedDigest = crypto
    .createHmac("sha256", secretBuf)
    .update(messageToSign)
    .digest();

  // svix-signature contains space-separated items, e.g. "v1,base64 v1,base64"
  const signatures = svixSignature.trim().split(/\s+/);
  for (const item of signatures) {
    const [version, sigBase64] = item.split(",");
    if (version !== "v1" || !sigBase64) continue;

    try {
      const sigBuf = Buffer.from(sigBase64, "base64");
      if (sigBuf.length === computedDigest.length && crypto.timingSafeEqual(sigBuf, computedDigest)) {
        return { valid: true };
      }
    } catch {
      // Malformed base64, continue checking others
    }
  }

  return { valid: false, reason: "SIGNATURE_MISMATCH" };
}

/**
 * Creates the Express request handler for POST /api/webhooks/clerk.
 */
export function createClerkWebhookHandler({
  store,
  webhookSecret = process.env.CLERK_WEBHOOK_SIGNING_SECRET,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  now = () => Date.now(),
  log = console,
} = {}) {
  return async function handleClerkWebhook(req, res) {
    if (!webhookSecret) {
      log.warn?.("[webhook] CLERK_WEBHOOK_SIGNING_SECRET is not configured");
      return res.status(503).json({ error: "WEBHOOK_UNCONFIGURED" });
    }

    const rawBody = req.body;
    if (!rawBody || (!Buffer.isBuffer(rawBody) && typeof rawBody !== "string")) {
      return res.status(400).json({ error: "MISSING_RAW_BODY" });
    }

    const verification = verifySvixSignature({
      payload: rawBody,
      headers: req.headers,
      secret: webhookSecret,
      toleranceSeconds,
      now,
    });

    if (!verification.valid) {
      return res.status(400).json({ error: "INVALID_SIGNATURE" });
    }

    let event;
    try {
      const rawString = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
      event = JSON.parse(rawString);
    } catch {
      return res.status(400).json({ error: "INVALID_JSON" });
    }

    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      return res.status(400).json({ error: "INVALID_PAYLOAD" });
    }

    if (event.type === "user.deleted") {
      const userId = event.data?.id;
      if (typeof userId !== "string" || !CLERK_USER_ID_PATTERN.test(userId)) {
        return res.status(400).json({ error: "INVALID_USER_ID" });
      }

      try {
        const deleted = await store.deleteAll(userId);
        // Privacy: Log count only, never the user_id
        log.info?.("[webhook] user.deleted processed", { rows: deleted });
        return res.status(200).json({ received: true, deleted });
      } catch (error) {
        log.error?.("[webhook] Database error while processing user.deleted:", describeDbError(error));
        return res.status(503).json({ error: "STATS_UNAVAILABLE" });
      }
    }

    // Acknowledge other valid Clerk events with 200 OK so Clerk does not re-send
    return res.status(200).json({ received: true, ignored: true });
  };
}
