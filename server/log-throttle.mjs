/**
 * Frequency limit for operator log lines: at most one line per key every
 * `intervalMs`, counting what was left out so the next line can say how many
 * requests it stands for. Unlike a "warn once" flag it keeps reporting a
 * persistent problem, and one noisy key never hides another.
 *
 * `key` must come from a small closed set chosen by the server, never from a
 * request: that keeps the map bounded and the log free of client-controlled text.
 * The default clock is monotonic, so a wall-clock adjustment cannot silence it.
 */
export function createLogThrottle({ intervalMs = 60_000, now = () => performance.now() } = {}) {
  const state = new Map();

  /** `{ log, suppressed }`: whether to write the line now, and how many were skipped since the last one. */
  return function admit(key) {
    const time = now();
    const entry = state.get(key);
    if (!entry) {
      state.set(key, { last: time, suppressed: 0 });
      return { log: true, suppressed: 0 };
    }
    if (time < entry.last || time - entry.last >= intervalMs) {
      const suppressed = entry.suppressed;
      entry.last = time;
      entry.suppressed = 0;
      return { log: true, suppressed };
    }
    entry.suppressed += 1;
    return { log: false, suppressed: entry.suppressed };
  };
}
