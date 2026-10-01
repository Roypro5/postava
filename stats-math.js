// Pure, DOM-free helpers for the stats dashboard. Kept separate from
// stats.js (which runs DOM/network side effects as soon as it is imported)
// so this logic can be exercised directly with `node --test`, the same
// pattern already used for stats-session.js.

// Franjas horarias en hora LOCAL del navegador (el servidor solo agrupa los
// días por fecha UTC, ver replit.md; la fatiga se calcula aquí porque
// necesita la hora local real de cada sesión). Cubren las 24 h en bloques de
// 2 h para no descartar en silencio las sesiones nocturnas/de madrugada.
export const FATIGUE_BUCKETS = Array.from({ length: 12 }, (_, index) => {
  const start = index * 2;
  const end = start + 2;
  const pad = (value) => String(value).padStart(2, "0");
  return { label: `${pad(start)}–${pad(end)}`, start };
});

export function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function computeFatigue(days) {
  const byStart = new Map(FATIGUE_BUCKETS.map((bucket) => [bucket.start, { goodMs: 0, badMs: 0, sessions: 0 }]));
  (Array.isArray(days) ? days : []).forEach((day) => {
    (Array.isArray(day.sessions) ? day.sessions : []).forEach((session) => {
      if (typeof session.startedAt !== "string") return;
      const date = new Date(session.startedAt);
      if (Number.isNaN(date.getTime())) return;
      const hour = date.getHours();
      const bucketStart = FATIGUE_BUCKETS.find((bucket) => hour >= bucket.start && hour < bucket.start + 2)?.start;
      if (bucketStart === undefined) return;
      const bucket = byStart.get(bucketStart);
      bucket.goodMs += number(session.goodMs);
      bucket.badMs += number(session.badMs);
      bucket.sessions += 1;
    });
  });
  return FATIGUE_BUCKETS.flatMap(({ label, start }) => {
    const bucket = byStart.get(start);
    if (!bucket.sessions || bucket.goodMs + bucket.badMs === 0) return [];
    return [{ label, value: Math.round((bucket.badMs / (bucket.goodMs + bucket.badMs)) * 100) }];
  });
}

// Puntuación global ponderada por los minutos medidos de cada día: un día
// con más tiempo de cámara pesa más que uno con apenas unos minutos medidos.
// Los días sin puntuación (sin medición) no participan; si nadie midió nada,
// no hay puntuación (igual que antes).
export function computeScore(days) {
  let weightedSum = 0;
  let totalWeight = 0;
  (Array.isArray(days) ? days : []).forEach((day) => {
    if (day.score === null || day.score === undefined || !Number.isFinite(Number(day.score))) return;
    const weight = number(day.measuredMinutes);
    if (weight <= 0) return;
    weightedSum += number(day.score) * weight;
    totalWeight += weight;
  });
  return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : null;
}
