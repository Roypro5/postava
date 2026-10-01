/* Dibujo del overlay (canvas): esqueleto, HUD y modo mapa.
   Módulo sin DOM ni estado global: recibe el contexto 2D y un objeto de estado
   (`s`) con todo lo que varía por frame. posture-monitor.js reutiliza un único
   objeto `s` para no asignar memoria en el camino caliente.

   s = { badgeState, showSkeleton, showHud, hideVideo, calibrating,
         baseline, smoothed, tolerance }

   Se ejecuta en cada fotograma inferido (~15 veces por segundo): aquí no se crean
   closures, arrays ni objetos por llamada. Las tablas y los arrays que recibe el
   contexto (setLineDash) son constantes de módulo, los bucles son por índice y
   las cadenas repetidas (fuentes, porcentajes) se memorizan. La secuencia de
   llamadas al canvas es la misma que antes de esta optimización. */

import { LM, KEY_POINTS, metricReport } from "./posture.js";

const CONNECTIONS = [
  [LM.L_SHOULDER, LM.R_SHOULDER],
  [LM.L_SHOULDER, LM.L_EAR],
  [LM.R_SHOULDER, LM.R_EAR],
  [LM.L_EAR, LM.L_EYE],
  [LM.R_EAR, LM.R_EYE],
  [LM.L_EYE, LM.NOSE],
  [LM.R_EYE, LM.NOSE],
];

/* Puntos de contexto: no entran en ninguna métrica, solo dan cuerpo al
   esqueleto. Se dibujan más tenues y solo si el modelo los ve con confianza. */
const SECONDARY_CONNECTIONS = [
  [LM.L_SHOULDER, LM.L_ELBOW],
  [LM.R_SHOULDER, LM.R_ELBOW],
  [LM.L_ELBOW, LM.L_WRIST],
  [LM.R_ELBOW, LM.R_WRIST],
  [LM.L_SHOULDER, LM.L_HIP],
  [LM.R_SHOULDER, LM.R_HIP],
  [LM.L_HIP, LM.R_HIP],
  [LM.MOUTH_L, LM.MOUTH_R],
];
const SECONDARY_POINTS = [
  LM.MOUTH_L, LM.MOUTH_R, LM.L_ELBOW, LM.R_ELBOW,
  LM.L_WRIST, LM.R_WRIST, LM.L_HIP, LM.R_HIP,
];

/* Puntos que entran en las métricas (KEY_POINTS). El código lleva el índice
   real del landmark en MediaPipe. `below` evita que la etiqueta tape la cara. */
const POINT_INFO = {
  [LM.NOSE]: { code: "NOSE·00", name: "nariz", below: true },
  [LM.L_EAR]: { code: "EAR·07", name: "oreja", below: false },
  [LM.R_EAR]: { code: "EAR·08", name: "oreja", below: false },
  [LM.L_SHOULDER]: { code: "SHLD·11", name: "hombro", below: true },
  [LM.R_SHOULDER]: { code: "SHLD·12", name: "hombro", below: true },
};
/* Índices de POINT_INFO en orden ascendente, calculados una vez (es el orden en
   que los recorría antes Object.entries, sin crear arrays en cada fotograma). */
const LABEL_POINTS = Object.keys(POINT_INFO).map(Number);
const EYES = [LM.L_EYE, LM.R_EYE];

/* Constantes que se pasan al contexto o se recorren en cada fotograma. */
const DASH_NECK = [5, 5];
const DASH_REF = [6, 8];
/* Esquinas del encuadre (0 = izquierda/arriba, 1 = derecha/abajo) y signos de las
   cuatro escuadras del marcador, en el mismo orden de dibujo de siempre. */
const CORNER_X = [0, 1, 0, 1];
const CORNER_Y = [0, 0, 1, 1];
const SIGN_X = [-1, 1, -1, 1];
const SIGN_Y = [-1, -1, 1, 1];

const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/* Paleta del lienzo. Va siempre sobre vídeo o sobre el mapa oscuro, así que
   usa tonos más luminosos que los de la interfaz: sobre fondo oscuro un verde
   bosque no se lee. Mismo significado, distinto sustrato. */
const COLORS = { good: "#5fe3a0", warn: "#ffb454", bad: "#ff7a68" };
const MAP_BG = "#0d1014";
const MAP_GRID = "rgba(95, 227, 160, 0.09)";

/* Cadena de fuente por tamaño en px (los tamaños son enteros y pocos): se
   construye una vez y se reutiliza en vez de concatenar en cada etiqueta. */
const fontCache = [];
function font(size) {
  return fontCache[size] ?? (fontCache[size] = `${size}px ${MONO}`);
}

/* Texto del porcentaje del HUD ("  0%", " 42%", "100%"): pocos valores enteros
   distintos, así que se memorizan; fuera del rango 0..999 se calcula al vuelo. */
const pctCache = [];
function pctLabel(ratio) {
  const n = Math.round(ratio * 100);
  if (n >= 0 && n < 1000) return pctCache[n] ?? (pctCache[n] = `${n}%`.padStart(4));
  return `${n}%`.padStart(4);
}

/* Fondo del modo mapa: oscuro con una retícula tenue */
function drawMapBackground(ctx, w, h) {
  ctx.fillStyle = MAP_BG;
  ctx.fillRect(0, 0, w, h);

  const step = Math.max(16, Math.round(w / 22));
  ctx.strokeStyle = MAP_GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = step; x < w; x += step) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
  }
  for (let y = step; y < h; y += step) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
  }
  ctx.stroke();
}

/* El lienzo va espejado por CSS. Todo el texto se dibuja dentro de un contexto
   invertido (beginUnmirrored ... ctx.restore()) para que se lea del derecho en
   pantalla. */
function beginUnmirrored(ctx, w) {
  ctx.save();
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
}

/* Esquinas de encuadre: el marco de una interfaz de seguimiento */
function drawCornerBrackets(ctx, w, h, color) {
  const len = Math.round(Math.min(w, h) * 0.06);
  const inset = Math.round(w * 0.02);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = Math.max(1.5, w / 400);
  ctx.lineCap = "square";
  for (let n = 0; n < 4; n++) {
    const cx = CORNER_X[n];
    const cy = CORNER_Y[n];
    const x = cx ? w - inset : inset;
    const y = cy ? h - inset : inset;
    const dx = cx ? -len : len;
    const dy = cy ? -len : len;
    ctx.beginPath();
    ctx.moveTo(x + dx, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy);
    ctx.stroke();
  }
  ctx.restore();
}

/* Marcador de seguimiento: cuatro escuadras y un punto central */
function drawMarker(ctx, x, y, r, color, lineW) {
  const s = r * 2.1;
  const arm = s * 0.45;
  ctx.save();
  ctx.strokeStyle = "rgba(6, 8, 12, 0.6)";
  ctx.lineWidth = lineW * 1.6;
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) {
      ctx.strokeStyle = color;
      ctx.lineWidth = lineW * 0.8;
    }
    for (let n = 0; n < 4; n++) {
      const sx = SIGN_X[n];
      const sy = SIGN_Y[n];
      ctx.beginPath();
      ctx.moveTo(x + sx * s - sx * arm, y + sy * s);
      ctx.lineTo(x + sx * s, y + sy * s);
      ctx.lineTo(x + sx * s, y + sy * s - sy * arm);
      ctx.stroke();
    }
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(6, 8, 12, 0.65)";
  ctx.lineWidth = Math.max(1, lineW * 0.5);
  ctx.stroke();
  ctx.restore();
}

/* Rombo hueco para los puntos derivados (los que el cálculo usa de verdad) */
function drawDiamond(ctx, x, y, r, color, lineW) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineW * 0.8;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

/* Etiqueta de una o dos líneas, centrada en (x, y) del lienzo espejado.
   `second` es la segunda línea o null si solo hay una. */
function drawLabel(ctx, first, second, x, y, color, w) {
  const size = Math.max(10, Math.round(w / 56));
  const lh = Math.round(size * 1.3);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(-1, 1);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = font(size);

  const firstW = ctx.measureText(first).width;
  const textW = second === null ? firstW : Math.max(firstW, ctx.measureText(second).width);
  const boxW = textW + 12;
  const boxH = lh * (second === null ? 1 : 2) + 6;
  ctx.fillStyle = "rgba(8, 10, 14, 0.78)";
  ctx.fillRect(-boxW / 2, -boxH / 2, boxW, boxH);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 1;
  ctx.strokeRect(-boxW / 2 + 0.5, -boxH / 2 + 0.5, boxW - 1, boxH - 1);
  ctx.globalAlpha = 1;

  ctx.fillStyle = color;
  ctx.font = font(size);
  ctx.fillText(first, 0, -boxH / 2 + 3 + lh * 0.5);
  if (second !== null) {
    ctx.fillStyle = "rgba(190, 200, 215, 0.8)";
    ctx.font = font(size - 1);
    ctx.fillText(second, 0, -boxH / 2 + 3 + lh * 1.5);
  }
  ctx.restore();
}

/* Filas del informe de métricas del HUD: un único array reutilizado en cada
   fotograma (metricReport rellena sus filas en sitio). Solo es válido dentro de
   drawHud, que es síncrona. */
const hudRows = [];
const NO_ROWS = Object.freeze([]);

/* Panel de métricas en vivo: cuánto se ha consumido de cada umbral */
function drawHud(ctx, w, h, color, s) {
  const size = Math.max(10, Math.round(w / 50));
  const lh = Math.round(size * 1.55);
  const pad = Math.round(w * 0.022);
  const barW = size * 5;
  const rows = s.baseline && s.smoothed
    ? metricReport(s.smoothed, s.baseline, s.tolerance, hudRows)
    : NO_ROWS;

  const panelW = size * 4.2 + barW + size * 3.4 + pad * 2;
  const panelH = lh * (rows.length + 1) + pad * 1.4;
  // Debajo del corchete de encuadre, para que no se pisen
  const top = pad + Math.round(Math.min(w, h) * 0.06) + 6;

  beginUnmirrored(ctx, w);
  ctx.font = font(size);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  ctx.fillStyle = "rgba(8, 10, 14, 0.62)";
  ctx.fillRect(pad, top, panelW, panelH);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1;
  ctx.strokeRect(pad + 0.5, top + 0.5, panelW - 1, panelH - 1);
  ctx.globalAlpha = 1;

  const x0 = pad + pad * 0.6;
  let y = top + pad * 0.7 + lh / 2;

  ctx.fillStyle = color;
  ctx.fillText(rows.length ? "POSE · LIVE" : "POSE · SIN CALIBRAR", x0, y);

  for (let n = 0; n < rows.length; n++) {
    const row = rows[n];
    y += lh;
    const pct = Math.max(0, Math.min(1.35, row.ratio));
    const tone = row.exceeded ? COLORS.bad : pct > 0.7 ? COLORS.warn : color;

    ctx.fillStyle = "rgba(190, 200, 215, 0.85)";
    ctx.fillText(row.code, x0, y);

    const bx = x0 + size * 4.2;
    ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
    ctx.fillRect(bx, y - size * 0.32, barW, size * 0.64);
    ctx.fillStyle = tone;
    ctx.fillRect(bx, y - size * 0.32, barW * Math.min(pct, 1), size * 0.64);
    if (row.exceeded) ctx.fillRect(bx + barW + 2, y - size * 0.32, 2, size * 0.64);

    ctx.fillStyle = tone;
    ctx.fillText(pctLabel(row.ratio), bx + barW + size * 0.7, y);
  }
  ctx.restore();
}

/* ¿El modelo ve este punto con confianza? (algunas versiones no rellenan `visibility`) */
function seen(landmarks, i) {
  const p = landmarks[i];
  return p && (typeof p.visibility !== "number" || p.visibility > 0.5);
}

function drawSkeleton(ctx, landmarks, w, h, color, s) {
  const lineW = Math.max(2, w / 220);

  drawCornerBrackets(ctx, w, h, color);

  // ── Esqueleto de contexto: codos, muñecas, caderas, boca ───────────────
  ctx.lineCap = "round";
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineW * 0.7;
  for (let n = 0; n < SECONDARY_CONNECTIONS.length; n++) {
    const a = SECONDARY_CONNECTIONS[n][0];
    const b = SECONDARY_CONNECTIONS[n][1];
    if (!seen(landmarks, a) || !seen(landmarks, b)) continue;
    ctx.beginPath();
    ctx.moveTo(landmarks[a].x * w, landmarks[a].y * h);
    ctx.lineTo(landmarks[b].x * w, landmarks[b].y * h);
    ctx.stroke();
  }
  for (let n = 0; n < SECONDARY_POINTS.length; n++) {
    const i = SECONDARY_POINTS[n];
    if (!seen(landmarks, i)) continue;
    ctx.beginPath();
    ctx.arc(landmarks[i].x * w, landmarks[i].y * h, Math.max(2, w / 260), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // ── Esqueleto medido, con trazo oscuro debajo para leerse sobre cualquier fondo
  for (let pass = 0; pass < 2; pass++) {
    ctx.strokeStyle = pass ? color : "rgba(6, 8, 12, 0.55)";
    ctx.lineWidth = pass ? lineW : lineW * 2.4;
    for (let n = 0; n < CONNECTIONS.length; n++) {
      const a = CONNECTIONS[n][0];
      const b = CONNECTIONS[n][1];
      if (!landmarks[a] || !landmarks[b]) continue;
      ctx.beginPath();
      ctx.moveTo(landmarks[a].x * w, landmarks[a].y * h);
      ctx.lineTo(landmarks[b].x * w, landmarks[b].y * h);
      ctx.stroke();
    }
  }

  // ── Geometría derivada: puntos medios y vector de cuello (la métrica `neck`)
  const le = landmarks[LM.L_EAR];
  const re = landmarks[LM.R_EAR];
  const ls = landmarks[LM.L_SHOULDER];
  const rs = landmarks[LM.R_SHOULDER];

  if (le && re && ls && rs) {
    const earX = ((le.x + re.x) / 2) * w;
    const earY = ((le.y + re.y) / 2) * h;
    const shX = ((ls.x + rs.x) / 2) * w;
    const shY = ((ls.y + rs.y) / 2) * h;
    ctx.save();
    ctx.setLineDash(DASH_NECK);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = lineW * 0.7;
    ctx.beginPath();
    ctx.moveTo(earX, earY);
    ctx.lineTo(shX, shY);
    ctx.stroke();
    ctx.restore();
    drawDiamond(ctx, earX, earY, lineW * 2, color, lineW);
    drawDiamond(ctx, shX, shY, lineW * 2, color, lineW);
  }

  // ── Marcadores de seguimiento sobre los puntos medidos ─────────────────
  const r = Math.max(3, w / 170) * (s.calibrating ? 1.4 : 1);

  for (let n = 0; n < EYES.length; n++) {
    const p = landmarks[EYES[n]];
    if (!p) continue;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, r * 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  for (let n = 0; n < KEY_POINTS.length; n++) {
    const p = landmarks[KEY_POINTS[n]];
    if (!p) continue;
    const x = p.x * w;
    const y = p.y * h;
    if (s.calibrating) {
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r * 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    drawMarker(ctx, x, y, r, color, lineW);
  }

  // ── Códigos de landmark; al calibrar se añade el nombre en claro ───────
  const offset = Math.max(18, w / 22);
  for (let n = 0; n < LABEL_POINTS.length; n++) {
    const i = LABEL_POINTS[n];
    const p = landmarks[i];
    if (!p) continue;
    const info = POINT_INFO[i];
    drawLabel(ctx, info.code, s.calibrating ? info.name : null, p.x * w, p.y * h + (info.below ? offset : -offset), color, w);
  }

  // ── Línea de referencia de la calibración (altura de hombros ideal) ────
  if (s.baseline) {
    ctx.save();
    ctx.setLineDash(DASH_REF);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = Math.max(1, w / 420);
    ctx.beginPath();
    ctx.moveTo(0, s.baseline.shoulderY * h);
    ctx.lineTo(w, s.baseline.shoulderY * h);
    ctx.stroke();
    ctx.restore();

    beginUnmirrored(ctx, w);
    ctx.font = font(Math.max(9, Math.round(w / 62)));
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.6;
    ctx.fillText("REF·CALIB", w - w * 0.02, s.baseline.shoulderY * h - 4);
    ctx.restore();
  }
}

/* Mientras se calibra siempre se ve la cámara, aunque el modo mapa esté activo */
function videoHidden(s) {
  return s.hideVideo && !s.calibrating;
}

export function drawOverlay(ctx, w, h, landmarks, s) {
  ctx.clearRect(0, 0, w, h);

  const color = COLORS[s.badgeState] || COLORS.good;

  if (videoHidden(s)) drawMapBackground(ctx, w, h);

  // Durante la calibración el esqueleto se muestra siempre: es lo que se explica.
  if (landmarks && (s.showSkeleton || s.calibrating)) {
    drawSkeleton(ctx, landmarks, w, h, color, s);
  }

  // El panel va aparte: se puede querer solo los números, sin esqueleto.
  if (s.showHud) drawHud(ctx, w, h, color, s);
}
