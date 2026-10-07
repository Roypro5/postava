/* Persistencia de ajustes en localStorage: solo datos, sin DOM ni lógica del temporizador.
   app.js recoge/aplica los valores de los controles; aquí solo se lee y escribe el JSON.
   `storage` es opcional (por defecto localStorage) y se resuelve dentro del try: en
   algunos navegadores el mero acceso a localStorage lanza. */

export const STORE_KEY = "postava.v1";

export function writeSettings(data, storage) {
  try {
    (storage ?? localStorage).setItem(STORE_KEY, JSON.stringify(data));
  } catch {
    /* modo privado o almacenamiento lleno: seguimos sin persistir */
  }
}

export function readSettings(storage) {
  try {
    return JSON.parse((storage ?? localStorage).getItem(STORE_KEY) || "null");
  } catch {
    return null;
  }
}

/* ── Saneado ─────────────────────────────────────────────────────────────
   Lo guardado en localStorage es entrada no confiable (editable a mano, de otra
   versión o corrupta). sanitizeSettings devuelve siempre un objeto completo y válido.
   Los límites deben coincidir con min/max/step de los <input> de index.html
   (tests/settings.test.mjs lo comprueba). */
export const NUMERIC_LIMITS = Object.freeze({
  focus: Object.freeze({ min: 1, max: 180, step: 1 }),
  brk: Object.freeze({ min: 1, max: 60, step: 1 }),
  tolerance: Object.freeze({ min: 0.6, max: 1.8, step: 0.1 }),
  delay: Object.freeze({ min: 2, max: 30, step: 1 }),
});

/* Coinciden con los valores iniciales de index.html. */
export const SETTINGS_DEFAULTS = Object.freeze({
  focus: 25,
  brk: 5,
  tolerance: 1,
  delay: 5,
  sound: true,
  skeleton: true,
  hud: true,
  hideVideo: false,
  camOnlyRunning: true,
  notify: false,
});

const BOOLEAN_KEYS = ["sound", "skeleton", "hud", "hideVideo", "camOnlyRunning", "notify"];
const BASELINE_KEYS = ["neck", "width", "tilt", "side", "chin", "shoulderY"];

function sanitizeNumber(value, key) {
  const { min, max, step } = NUMERIC_LIMITS[key];
  // null, "", arrays vacíos, booleanos y objetos darían 0/1 con Number(): no son números.
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (typeof value === "string" && value.trim() === "") return SETTINGS_DEFAULTS[key];
  if (!Number.isFinite(n)) return SETTINGS_DEFAULTS[key];
  const clamped = Math.min(max, Math.max(min, n));
  const stepped = min + Math.round((clamped - min) / step) * step;
  const decimals = (String(step).split(".")[1] || "").length;
  return Math.min(max, Math.max(min, Number(stepped.toFixed(decimals))));
}

function sanitizeBaseline(b) {
  if (b === null || typeof b !== "object") return null;
  const out = {};
  for (const key of BASELINE_KEYS) {
    if (typeof b[key] !== "number" || !Number.isFinite(b[key])) return null;
    out[key] = b[key];
  }
  return out;
}

export function sanitizeSettings(raw) {
  const src = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const key of Object.keys(NUMERIC_LIMITS)) out[key] = sanitizeNumber(src[key], key);
  for (const key of BOOLEAN_KEYS) {
    out[key] = typeof src[key] === "boolean" ? src[key] : SETTINGS_DEFAULTS[key];
  }
  out.baseline = sanitizeBaseline(src.baseline);
  return out;
}
