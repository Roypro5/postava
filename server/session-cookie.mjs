import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { getClerkProxyHost } from "./middlewares/clerkProxyMiddleware.mjs";

export const APP_SESSION_COOKIE = "__Host-postava_presence";
export const PRESENCE_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signature(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function findCookie(header, name) {
  if (!header) return undefined;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      return item.slice(separator + 1).trim();
    }
  }
  return undefined;
}

export function createPresenceValue(
  sessionId,
  remember,
  secret,
  now = Date.now(),
) {
  if (!sessionId || typeof remember !== "boolean" || !secret) {
    throw new TypeError("A session id, remember choice, and secret are required");
  }
  const payload = encode({
    sessionId,
    remember,
    expiresAt: now + PRESENCE_LIFETIME_SECONDS * 1000,
  });
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyPresenceValue(
  value,
  expectedSessionId,
  secret,
  now = Date.now(),
) {
  if (!value || !expectedSessionId || !secret) return null;
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = value.slice(0, separator);
  const supplied = Buffer.from(value.slice(separator + 1), "base64url");
  const expected = Buffer.from(signature(payload, secret), "base64url");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return null;
  }

  try {
    const marker = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (
      marker.sessionId !== expectedSessionId ||
      typeof marker.remember !== "boolean" ||
      !Number.isFinite(marker.expiresAt) ||
      marker.expiresAt <= now
    ) {
      return null;
    }
    return { remember: marker.remember, expiresAt: marker.expiresAt };
  } catch {
    return null;
  }
}

export function createPresenceCookie(
  sessionId,
  remember,
  secret,
  now = Date.now(),
) {
  const parts = [
    `${APP_SESSION_COOKIE}=${createPresenceValue(sessionId, remember, secret, now)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ];
  if (remember) parts.push(`Max-Age=${PRESENCE_LIFETIME_SECONDS}`);
  return parts.join("; ");
}

export function clearPresenceCookie() {
  return [
    `${APP_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ].join("; ");
}

export function readPresenceCookie(
  cookieHeader,
  expectedSessionId,
  secret,
  now = Date.now(),
) {
  return verifyPresenceValue(
    findCookie(cookieHeader, APP_SESSION_COOKIE),
    expectedSessionId,
    secret,
    now,
  );
}

export function requestHasPublicOrigin(req) {
  const origin = req.headers.origin;
  const publicHost = getClerkProxyHost(req);
  if (typeof origin !== "string" || !publicHost) return false;

  try {
    const originUrl = new URL(origin);
    if (originUrl.username || originUrl.password) return false;
    const forwardedProto = req.headers["x-forwarded-proto"];
    const rawProto = Array.isArray(forwardedProto)
      ? forwardedProto[0]
      : forwardedProto;
    const publicProtocol =
      rawProto?.split(",")[0]?.trim().toLowerCase() || req.protocol;
    return (
      originUrl.host.toLowerCase() === publicHost.toLowerCase() &&
      (!publicProtocol ||
        originUrl.protocol.toLowerCase() === `${publicProtocol}:`)
    );
  } catch {
    return false;
  }
}