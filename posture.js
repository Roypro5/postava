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
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
    if (Number.isFinite(p.visibility)) {
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
 *
 * Devuelve `null` si `lm` falta o si alguno de los puntos clave usados
 * (los mismos que exige `keyPointsVisible`) no está definido o tiene x/y no
 * finitos. Los llamadores deben comprobar `keyPointsVisible(lm)` antes de
 * invocar esta función; con esa comprobación previa, este caso nunca ocurre
 * en la práctica, pero queda como red de seguridad para nuevos llamadores.
 *
 * `out` (opcional): objeto ya existente donde escribir el resultado en lugar de
 * crear uno nuevo. Lo usa el bucle de inferencia (una llamada por fotograma) para
 * no asignar memoria; las operaciones y su orden son idénticos, así que los
 * valores son los mismos bit a bit con o sin `out`.
 */
export function computeMetrics(lm, aspect = 4 / 3, out = null) {
  if (!lm) return null;
  for (const i of KEY_POINTS) {
    const p = lm[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  }
  // Coordenadas con la X corregida por la relación de aspecto (escalares: sin
  // objetos intermedios en el camino caliente).
  const lsx = lm[LM.L_SHOULDER].x * aspect;
  const lsy = lm[LM.L_SHOULDER].y;
  const rsx = lm[LM.R_SHOULDER].x * aspect;
  const rsy = lm[LM.R_SHOULDER].y;
  const lex = lm[LM.L_EAR].x * aspect;
  const ley = lm[LM.L_EAR].y;
  const rex = lm[LM.R_EAR].x * aspect;
  const rey = lm[LM.R_EAR].y;
  const noseY = lm[LM.NOSE].y;

  const shoulderMidX = (lsx + rsx) / 2;
  const shoulderMidY = (lsy + rsy) / 2;
  const earMidX = (lex + rex) / 2;
  const earMidY = (ley + rey) / 2;
  const shoulderW = Math.max(Math.hypot(lsx - rsx, lsy - rsy), 1e-4);

  // Cuello: separación vertical oreja→hombro. Al encorvarse, la cabeza
  // "se hunde" entre los hombros y este valor baja.
  const neck = (shoulderMidY - earMidY) / shoulderW;
  // Desnivel de hombros, en grados.
  const tilt = normalizeLineAngle((Math.atan2(rsy - lsy, rsx - lsx) * 180) / Math.PI);
  // Desplazamiento lateral de la cabeza respecto al centro de los hombros.
  const side = (earMidX - shoulderMidX) / shoulderW;
  // Barbilla hacia abajo: la nariz cae respecto a la línea de las orejas.
  const chin = (noseY - earMidY) / shoulderW;

  // `width` (cercanía a la pantalla: cuanto más cerca, más ancho se ve el torso)
  // es shoulderW; `shoulderY` (altura de los hombros en el encuadre, para
  // detectar deslizamiento) es shoulderMidY.
  if (out) {
    out.neck = neck;
    out.width = shoulderW;
    out.tilt = tilt;
    out.side = side;
    out.chin = chin;
    out.shoulderY = shoulderMidY;
    return out;
  }
  return { neck, width: shoulderW, tilt, side, chin, shoulderY: shoulderMidY };
}

/* Intervalo nominal de inferencia (INFER_INTERVAL en app.js), usado solo para
   derivar SMOOTH_TAU_MS abajo: no depende de app.js en tiempo de ejecución. */
const NOMINAL_INFER_INTERVAL_MS = 66;
/* alpha fijo que tenía smooth() antes de depender del tiempo transcurrido */
const LEGACY_ALPHA_AT_NOMINAL_RATE = 0.3;

/* Constante de tiempo del filtro exponencial. Se elige tau para que, a la
   frecuencia nominal de inferencia (~66 ms/fotograma, ver INFER_INTERVAL en
   app.js), alpha = 1 - exp(-dt/tau) reproduzca el alpha fijo de 0.3 que
   usaba antes smooth(): despejando, tau = -dt / ln(1 - alpha)
   = -66 / ln(0.7) ≈ 185 ms. Con esta tau, si el bucle tarda más en llamar a
   smooth() (dt mayor: pestaña en segundo plano, pausas) el filtro avanza más
   hacia el valor nuevo -que es lo correcto tras un hueco largo-, y si dt es
   más pequeño, suaviza más que antes en vez de aplicar siempre el mismo salto
   fijo por fotograma. */
export const SMOOTH_TAU_MS =
  -NOMINAL_INFER_INTERVAL_MS / Math.log(1 - LEGACY_ALPHA_AT_NOMINAL_RATE);

/**
 * Media exponencial para quitar el temblor entre fotogramas, dependiente del
 * tiempo real transcurrido (`dtMs`) en vez de un alpha fijo por llamada.
 * El llamador debe acotar `dtMs` a un rango razonable (por ejemplo,
 * descartando saltos larguísimos tras una pestaña oculta o una pausa) antes
 * de invocar esta función.
 */
export function smooth(prev, next, dtMs, tau = SMOOTH_TAU_MS) {
  return smoothInto({}, prev, next, dtMs, tau);
}

/**
 * Igual que `smooth`, pero escribe el resultado en `out` (que puede ser el propio
 * `prev`: cada clave solo lee su valor anterior antes de sobrescribirlo) en vez
 * de crear un objeto nuevo. Lo usa el bucle de inferencia para no asignar
 * memoria por fotograma; los valores son idénticos bit a bit a los de `smooth`.
 * `for...in` recorre las claves propias de `next` en el mismo orden que
 * `Object.keys`, sin crear el array intermedio.
 */
export function smoothInto(out, prev, next, dtMs, tau = SMOOTH_TAU_MS) {
  if (!prev) {
    for (const k in next) out[k] = next[k];
    return out;
  }
  const alpha = 1 - Math.exp(-Math.max(dtMs, 0) / tau);
  for (const k in next) {
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
 *
 * `out` (opcional): array de trabajo reutilizable. Sus filas se rellenan en
 * sitio (se crean solo la primera vez) y se devuelve el propio `out`, de modo que
 * el bucle de inferencia y el HUD no asignan objetos por fotograma. Las filas
 * son entonces válidas solo hasta la siguiente llamada con el mismo `out`.
 * Sin `out` se devuelve, como siempre, un array nuevo de filas nuevas.
 */
export function metricReport(m, baseline, tolerance = 1, out = null) {
  const rows = out || [];
  if (!m || !baseline) {
    rows.length = 0;
    return rows;
  }

  // Orden fijo de las filas: neckDrop, proximity, shoulderTilt, sideLean, chinDown, slump.
  // neckDrop se normaliza por baseline.neck (y no por baseline.width, como
  // proximity/slump) porque `neck` ya es una distancia relativa al ancho de
  // hombros (ver computeMetrics): dividir de nuevo por el ancho contaría esa
  // normalización dos veces. Aquí lo que interesa es qué fracción de la
  // propia separación oreja-hombro calibrada se ha perdido al encorvarse,
  // así que la referencia correcta es baseline.neck.
  fillRow(rows, 0, "neckDrop", (baseline.neck - m.neck) / Math.abs(baseline.neck || 1), tolerance);
  fillRow(rows, 1, "proximity", (m.width - baseline.width) / baseline.width, tolerance);
  fillRow(rows, 2, "shoulderTilt", lineAngleDifference(m.tilt, baseline.tilt), tolerance);
  fillRow(rows, 3, "sideLean", Math.abs(m.side - baseline.side), tolerance);
  fillRow(rows, 4, "chinDown", m.chin - baseline.chin, tolerance);
  fillRow(rows, 5, "slump", (m.shoulderY - baseline.shoulderY) / baseline.width, tolerance);
  rows.length = 6;
  return rows;
}

function fillRow(rows, index, key, value, tolerance) {
  const limit = TH[key] * tolerance;
  const row = rows[index] ?? (rows[index] = { key, code: "", value, limit, ratio: 0, exceeded: false });
  row.key = key;
  row.code = METRIC_CODES[key];
  row.value = value;
  row.limit = limit;
  row.ratio = value / limit;
  row.exceeded = value > limit;
}

/**
 * Filtra las filas de `metricReport` que superan su umbral y las deja en `out`
 * ordenadas de más a menos grave (ordenación estable: a igual `ratio` se conserva
 * el orden de las filas). Equivale a `.filter(exceeded).sort(por ratio desc)` sin
 * crear arrays temporales; con como mucho 6 filas, la inserción directa basta.
 * Devuelve `out`, cuyas entradas son las propias filas (no copias).
 */
export function collectIssues(rows, out = []) {
  let count = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.exceeded) continue;
    let j = count++;
    while (j > 0 && out[j - 1].ratio < row.ratio) {
      out[j] = out[j - 1];
      j--;
    }
    out[j] = row;
  }
  out.length = count;
  return out;
}

/**
 * Problemas detectados, ordenados de más a menos grave
 * (`ratio` = cuántas veces se supera el umbral).
 */
export function findIssues(m, baseline, tolerance = 1) {
  return collectIssues(metricReport(m, baseline, tolerance));
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

/* Fracción de cada umbral de aviso (TH) que se tolera como dispersión
   (desviación típica) durante la calibración. Si te mueves mientras se
   toman las muestras, la media puede salir razonable pero el rango de
   referencia queda mal definido, y luego se disparan avisos falsos o se
   dejan pasar posturas malas. 0.4 (40 % del umbral normal) se eligió porque
   deja margen al temblor natural de estar sentado quieto, pero atrapa un
   cambio de postura real durante los 3 s de muestreo. */
export const CALIB_SPREAD_FRACTION = 0.4;

export const CALIB_SPREAD_TH = {
  neck: TH.neckDrop * CALIB_SPREAD_FRACTION,
  width: TH.proximity * CALIB_SPREAD_FRACTION,
  tilt: TH.shoulderTilt * CALIB_SPREAD_FRACTION,
  shoulderY: TH.slump * CALIB_SPREAD_FRACTION,
};

function stdDev(values, mean) {
  if (values.length < 2) return 0;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Dispersión (desviación típica) de las métricas clave tomadas durante la
 * calibración, en las mismas unidades relativas que usan sus umbrales TH:
 * - neck: ya normalizado por el ancho de hombros en cada muestra (ver
 *   computeMetrics), se compara directo con TH.neckDrop.
 * - width: se usa la variación relativa a su propia media, como hace
 *   `proximity` en metricReport.
 * - shoulderY: no viene normalizado (es una posición en pantalla), así que
 *   se divide por el ancho medio de hombros, igual que `slump`.
 * - tilt: respeta la periodicidad de 180° de una línea (ver
 *   normalizeLineAngle) calculando la distancia angular con signo a la media
 *   circular antes de sacar la desviación típica.
 * Devuelve `null` si no hay al menos 2 muestras.
 */
export function calibrationSpread(samples) {
  if (!samples || samples.length < 2) return null;
  const mean = averageMetrics(samples);
  const widthMean = mean.width || 1;

  const neckValues = samples.map((s) => s.neck);
  const widthRatios = samples.map((s) => s.width / widthMean - 1);
  const tiltDeltas = samples.map((s) => signedLineAngleDelta(mean.tilt, s.tilt));
  const shoulderYRatios = samples.map((s) => (s.shoulderY - mean.shoulderY) / widthMean);

  return {
    neck: stdDev(neckValues, mean.neck),
    width: stdDev(widthRatios, 0),
    tilt: stdDev(tiltDeltas, 0),
    shoulderY: stdDev(shoulderYRatios, 0),
  };
}

/**
 * Valida que las muestras de calibración sean suficientes y estables.
 * No lanza: devuelve `{ ok: true }` o `{ ok: false, reason }` para que quien
 * llame decida el mensaje. `reason` es "insufficient" (pocas muestras
 * válidas) o "movement" (te has movido mientras se calibraba).
 */
export function validateCalibrationSamples(samples, minSamples = 8) {
  if (!samples || samples.length < minSamples) {
    return { ok: false, reason: "insufficient" };
  }
  const spread = calibrationSpread(samples);
  const moved = Object.entries(CALIB_SPREAD_TH).some(
    ([key, limit]) => spread[key] > limit
  );
  if (moved) return { ok: false, reason: "movement" };
  return { ok: true };
}
