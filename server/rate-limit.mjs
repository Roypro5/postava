/**
 * Small in-memory fixed-window rate limiter, built by hand instead of a
 * dependency: per-key request counts reset on a rolling window, and a
 * periodic sweep drops stale keys so the map cannot grow without bound.
 *
 * `now` is injectable so tests can fast-forward without real timers, and the
 * cleanup sweep is exposed separately from `startCleanup` so tests can call
 * it directly instead of waiting on a real interval.
 */
export function createRateLimiter({
  windowMs,
  max,
  keyFn = (req) => req.ip,
  now = () => Date.now(),
} = {}) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error("createRateLimiter requires a positive windowMs");
  }
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error("createRateLimiter requires a positive max");
  }

  const hits = new Map(); // key -> { count, resetAt }

  function middleware(req, res, next) {
    const key = keyFn(req) || "unknown";
    const at = now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= at) {
      entry = { count: 0, resetAt: at + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - at) / 1000));
      res.set("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ error: "RATE_LIMITED" });
    }
    return next();
  }

  function sweep() {
    const at = now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= at) hits.delete(key);
    }
  }

  function startCleanup(intervalMs = windowMs) {
    const timer = setInterval(sweep, intervalMs);
    // Never keep the process alive just to prune this map.
    timer.unref?.();
    return timer;
  }

  return {
    middleware,
    sweep,
    startCleanup,
    size: () => hits.size,
  };
}
