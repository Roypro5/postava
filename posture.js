/* ─────────────────────────────────────────────────────────────────────────
   Postava · lógica pura de postura
   Sin DOM ni estado global: recibe landmarks y devuelve métricas/problemas.
   Así se puede razonar (y testear) sin cámara.
   ───────────────────────────────────────────────────────────────────────── */

/* Índices de landmarks de MediaPipe Pose (33 puntos) */
export const LM = {
  NOSE: 0,
  L_EYE: 2,
  R_EYE: 5,
  L_EAR: 7,
  R_EAR: 8,
  MOUTH_L: 9,
  MOUTH_R: 10,
  L_SHOULDER: 11,
  R_SHOULDER: 12,
  L_ELBOW: 13,
  R_ELBOW: 14,
  L_WRIST: 15,
  R_WRIST: 16,
  L_HIP: 23,
  R_HIP: 24,
};

/* Puntos imprescindibles para evaluar: si no se ven, no evaluamos */
export const KEY_POINTS = [LM.NOSE, LM.L_EAR, LM.R_EAR, LM.L_SHOULDER, LM.R_SHOULDER];

/* Umbrales base; se multiplican por la tolerancia elegida por el usuario */
export const TH = {
  neckDrop: 0.16,     // caída relativa de la distancia oreja–hombro
  proximity: 0.14,    // aumento relativo del ancho de hombros (acercarse)
  shoulderTilt: 9,    // grados de desnivel entre hombros
  sideLean: 0.22,     // desplazamiento lateral de la cabeza
  chinDown: 0.16,     // barbilla hacia el pecho
  slump: 0.20,        // hundimiento vertical en la silla
};

export const ISSUE_TEXT = {
  neckDrop: "Cuello hundido: estás encorvando la espalda.",
  proximity: "Te has acercado demasiado a la pantalla.",
  shoulderTilt: "Tienes los hombros desnivelados.",
  sideLean: "Estás cargando el cuerpo hacia un lado.",
  chinDown: "Cabeza muy inclinada hacia abajo.",
  slump: "Te estás deslizando hacia abajo en la silla.",
};

/**
 * ¿Se ven los puntos clave con confianza suficiente?
 * Algunas versiones del modelo no rellenan `visibility`; en ese caso
 * solo comprobamos que los puntos caigan dentro del encuadre.
 */
export function keyPointsVisible(lm, minVisibility = 0.4) {
  if (!lm) return false;
  let hasVisibilityData = false;
  let min = 1;

  for (const i of KEY_POINTS) {
    const p = lm[i];
    if (!p) return false;
    if (typeof p.visibility === "number") {
      if (p.visibility > 0) hasVisibilityData = true;
      min = Math.min(min, p.visibility);
    }
    // Un margen pequeño es normal: el modelo extrapola puntos al borde.
    if (p.x < -0.15 || p.x > 1.15 || p.y < -0.15 || p.y > 1.15) return false;
  }

  return hasVisibilityData ? min > minVisibility : true;
}

/* Una línea de hombros no tiene dirección: 0° y 180° representan la misma
   postura. Estas funciones mantienen los ángulos en [-90°, 90°) y calculan
   siempre el recorrido más corto, evitando saltos al cruzar ±180°. */
export function normalizeLineAngle(degrees) {
  return ((degrees + 90) % 180 + 180) % 180 - 90;
}

function signedLineAngleDelta(from, to) {
  return normalizeLineAngle(to - from);
}

export function lineAngleDifference(a, b) {
  return Math.abs(signedLineAngleDelta(a, b));
}

/**
 * Métricas de postura a partir de los landmarks normalizados [0,1].
 * La X se corrige por la relación de aspecto para que las distancias sean
 * comparables en ambos ejes; después casi todo se normaliza por el ancho de
 * hombros, de modo que las métricas no dependen de la distancia a la cámara.
 */
export function computeMetrics(lm, aspect = 4 / 3) {
  const P = (i) => ({ x: lm[i].x * aspect, y: lm[i].y });
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  const ls = P(LM.L_SHOULDER);
  const rs = P(LM.R_SHOULDER);
  const le = P(LM.L_EAR);
  const re = P(LM.R_EAR);
  const nose = P(LM.NOSE);

  const shoulderMid = mid(ls, rs);
  const earMid = mid(le, re);
  const shoulderW = Math.max(dist(ls, rs), 1e-4);

  return {
    // Cuello: separación vertical oreja→hombro. Al encorvarse, la cabeza
    // "se hunde" entre los hombros y este valor baja.
    neck: (shoulderMid.y - earMid.y) / shoulderW,
    // Cercanía a la pantalla: cuanto más cerca, más ancho se ve el torso.
    width: shoulderW,
    // Desnivel de hombros, en grados.
    tilt: normalizeLineAngle(
      (Math.atan2(rs.y - ls.y, rs.x - ls.x) * 180) / Math.PI
    ),
    // Desplazamiento lateral de la cabeza respecto al centro de los hombros.
    side: (earMid.x - shoulderMid.x) / shoulderW,
    // Barbilla hacia abajo: la nariz cae respecto a la línea de las orejas.
    chin: (nose.y - earMid.y) / shoulderW,
    // Altura de los hombros en el encuadre (para detectar deslizamiento).
    shoulderY: shoulderMid.y,
  };
}

/* Media exponencial para quitar el temblor entre fotogramas */
export function smooth(prev, next, alpha = 0.3) {
  if (!prev) return { ...next };
  const out = {};
  for (const k of Object.keys(next)) {
    out[k] = k === "tilt"
      ? normalizeLineAngle(prev[k] + signedLineAngleDelta(prev[k], next[k]) * alpha)
      : prev[k] * (1 - alpha) + next[k] * alpha;
  }
  return out;
}

/* Etiquetas cortas para el panel de métricas del lienzo */
export const METRIC_CODES = {
  neckDrop: "NECK",
  proximity: "DIST",
  shoulderTilt: "TILT",
  sideLean: "LEAN",
  chinDown: "CHIN",
  slump: "SLMP",
};

/**
 * Desviación de cada métrica respecto a la calibración.
 * `ratio` es la fracción del umbral consumida: 1 = justo en el límite.
 * Es la única fuente de verdad; findIssues() y el HUD leen de aquí.
 */
export function metricReport(m, baseline, tolerance = 1) {
  if (!m || !baseline) return [];

  const deviations = {
    neckDrop: (baseline.neck - m.neck) / Math.abs(baseline.neck || 1),
    proximity: (m.width - baseline.width) / baseline.width,
    shoulderTilt: lineAngleDifference(m.tilt, baseline.tilt),
    sideLean: Math.abs(m.side - baseline.side),
    chinDown: m.chin - baseline.chin,
    slump: (m.shoulderY - baseline.shoulderY) / baseline.width,
  };

  return Object.entries(deviations).map(([key, value]) => {
    const limit = TH[key] * tolerance;
    return { key, code: METRIC_CODES[key], value, limit, ratio: value / limit, exceeded: value > limit };
  });
}

/**
 * Problemas detectados, ordenados de más a menos grave
 * (`ratio` = cuántas veces se supera el umbral).
 */
export function findIssues(m, baseline, tolerance = 1) {
  return metricReport(m, baseline, tolerance)
    .filter((r) => r.exceeded)
    .sort((a, b) => b.ratio - a.ratio);
}

/* Promedio de las muestras tomadas durante la calibración */
export function averageMetrics(samples) {
  if (!samples.length) return null;
  const out = {};
  for (const k of Object.keys(samples[0])) {
    if (k === "tilt") {
      // Promedio circular con periodo de 180°: duplicar el ángulo convierte
      // orientaciones de línea en ángulos direccionales promediables.
      const sum = samples.reduce(
        (acc, s) => {
          const radians = (s[k] * 2 * Math.PI) / 180;
          acc.sin += Math.sin(radians);
          acc.cos += Math.cos(radians);
          return acc;
        },
        { sin: 0, cos: 0 }
      );
      out[k] = normalizeLineAngle(
        (Math.atan2(sum.sin, sum.cos) * 180) / (2 * Math.PI)
      );
    } else {
      out[k] = samples.reduce((acc, s) => acc + s[k], 0) / samples.length;
    }
  }
  return out;
}
