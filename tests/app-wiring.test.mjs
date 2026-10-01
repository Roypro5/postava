// Cableado de app.js REAL (temporizador, cámara, MediaPipe, sonido, notificaciones,
// estadísticas) contra un navegador simulado: DOM, cámara, MediaPipe, AudioContext,
// Notification, localStorage, fetch, reloj y requestAnimationFrame falsos.
//
// Los módulos del proyecto son los de verdad; solo se sustituye lo que es del
// navegador o de la red (nada sale a Internet ni crea cuentas: el usuario de Clerk
// es un objeto ficticio devuelto por un adaptador simulado).
//
// Aislamiento: el arnés instala los globales y los hooks de módulos al crear cada
// escenario y los deshace en `dispose()`. Cada escenario carga su propio grafo de
// módulos (sufijo `?wiring=<id>` en app.js y en todos sus imports relativos), de modo
// que el estado a nivel de módulo (sound.js, dom.js...) no se filtra de uno a otro.
// No se crea ningún temporizador real: setInterval y requestAnimationFrame son falsos
// y la espera activa (`waitFor`) usa setImmediate con un plazo medido con hrtime.
import assert from "node:assert/strict";
import nodeModule from "node:module";
import test from "node:test";
import { validateSessionPayload } from "../server/stats-store.mjs";

// Import por defecto: `registerHooks` no existe en Node < 22.15 y un import con
// nombre rompería el enlace del módulo antes de poder saltar el test.
const registerHooks = nodeModule.registerHooks;

const APP_URL = new URL("../app.js", import.meta.url);
const ROOT_URL = new URL("../", import.meta.url).href;
const CDN_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const PENDING_KEY_PREFIX = "postava.stats.pending.v2:";
const FOCUS_MS = 25 * 60_000;

/* ── Utilidades de espera ─────────────────────────────────────────────── */

/** Cede el turno al bucle de eventos una vez (sin temporizadores). */
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/** Espera activa hasta que `cond()` sea verdadera; falla con un mensaje claro al agotar el plazo. */
async function waitFor(cond, { what = "la condición esperada", timeoutMs = 2_000 } = {}) {
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
  for (;;) {
    const value = cond();
    if (value) return value;
    if (process.hrtime.bigint() > deadline) {
      throw new Error(`waitFor: no se cumplió «${what}» en ${timeoutMs} ms`);
    }
    await nextTurn();
  }
}

/** Para aserciones NEGATIVAS ("no ocurre nada"): deja pasar varios turnos del bucle. */
async function settle(turns = 20) {
  for (let i = 0; i < turns; i++) await nextTurn();
}

/* ── Landmarks sintéticos (33 puntos de MediaPipe Pose) ───────────────── */

const VISIBLE = 0.9;
function landmarks({ earY = 0.35 } = {}) {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: VISIBLE }));
  points[0] = { x: 0.5, y: 0.38, visibility: VISIBLE }; // nariz
  points[7] = { x: 0.45, y: earY, visibility: VISIBLE }; // oreja izquierda
  points[8] = { x: 0.55, y: earY, visibility: VISIBLE }; // oreja derecha
  points[11] = { x: 0.35, y: 0.6, visibility: VISIBLE }; // hombro izquierdo
  points[12] = { x: 0.65, y: 0.6, visibility: VISIBLE }; // hombro derecho
  return points;
}
const GOOD = landmarks();
const BAD = landmarks({ earY: 0.45 }); // orejas muy por debajo: cuello adelantado

/* ── Navegador simulado ───────────────────────────────────────────────── */

let runCounter = 0;

// Valores iniciales de los controles (lo que declara index.html).
const ELEMENT_DEFAULTS = {
  focusMins: { value: "25", min: "1", max: "180" },
  breakMins: { value: "5", min: "1", max: "60" },
  btnStart: { textContent: "Iniciar" },
  tolerance: { value: "1" },
  delaySeconds: { value: "2" },
  soundToggle: { checked: true },
  skeletonToggle: { checked: true },
  hudToggle: { checked: true },
  hideVideoToggle: { checked: false },
  camOnlyRunning: { checked: true },
  notifyToggle: { checked: true },
  video: { readyState: 4, currentTime: 0, videoWidth: 640, videoHeight: 480 },
  overlay: { width: 300, height: 200 },
  alertBanner: { hidden: true },
  camPlaceholder: { hidden: false },
  calibOverlay: { hidden: true },
};

/**
 * Crea un navegador simulado e instala sus globales. `dispose()` lo deshace todo.
 *  - user:    usuario ficticio devuelto por el adaptador de cuenta (null = invitado).
 *  - cdn:     "up" (la CDN de MediaPipe responde) | "down" (la carga falla) |
 *             "pending" (la carga queda retenida: `app.cdnGate.release()` / `.fail()`).
 *  - onFetch: respuesta de fetch (por defecto, fetch está prohibido: privacidad de invitado).
 *  - restore: () => Promise<user|null>, sustituye a adapter.restore() (Clerk lento, rechazos…).
 *  - loadAuth: () => Promise<adapter>, sustituye a loadAuth() (por defecto devuelve { restore }).
 *  - storage: entradas iniciales de localStorage ({ clave: valor en texto }).
 *  - audioFails: `new AudioContext()` lanza (política del navegador, demasiados contextos...).
 */
function createBrowser({ user = null, cdn = "up", onFetch, restore, loadAuth, storage: initialStorage = {}, audioFails = false } = {}) {
  const runId = `r${++runCounter}`;
  const tag = `?wiring=${runId}`;
  const undo = [];

  const setGlobal = (name, value) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, enumerable: true, writable: true, value });
    undo.push(() => (previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]));
  };
  const patch = (target, name, value) => {
    const previous = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { configurable: true, enumerable: true, writable: true, value });
    undo.push(() => (previous ? Object.defineProperty(target, name, previous) : delete target[name]));
  };

  /* Reloj falso: `perf` (performance.now, usado por el monitor de postura) y `date`
     (Date.now, usado por el temporizador y las estadísticas) avanzan juntos. */
  const clock = { perf: 10_000, date: Date.UTC(2026, 0, 5, 9, 0, 0) };
  /* setTimeout/clearTimeout falsos sobre ese mismo reloj: nunca crean handles reales
     y solo se disparan cuando `advance` alcanza su vencimiento (sin esperas reales). */
  const timeouts = { next: 1, pending: new Map(), created: [] }; // `created`: ms de cada plazo armado
  const advance = (ms) => {
    clock.perf += ms;
    clock.date += ms;
    for (const [id, timeout] of [...timeouts.pending]) {
      if (timeout.dueAt > clock.perf) continue;
      timeouts.pending.delete(id);
      timeout.fn(...timeout.args);
    }
  };
  patch(performance, "now", () => clock.perf);
  patch(Date, "now", () => clock.date);
  setGlobal("setTimeout", (fn, ms = 0, ...args) => {
    const id = timeouts.next++;
    timeouts.created.push(ms);
    timeouts.pending.set(id, { fn, ms, args, dueAt: clock.perf + ms });
    return id;
  });
  setGlobal("clearTimeout", (id) => {
    timeouts.pending.delete(id);
  });

  /* requestAnimationFrame / setInterval falsos: nunca crean handles reales. */
  const rafs = { next: 1, pending: new Map(), cancelled: [] };
  setGlobal("requestAnimationFrame", (cb) => {
    const id = rafs.next++;
    rafs.pending.set(id, cb);
    return id;
  });
  setGlobal("cancelAnimationFrame", (id) => {
    rafs.cancelled.push(id);
    rafs.pending.delete(id);
  });
  const intervals = [];
  setGlobal("setInterval", (fn, ms) => {
    intervals.push({ fn, ms });
    return intervals.length;
  });

  /* DOM falso con la semántica del navegador que importa: value/textContent se
     coaccionan a string (syncChips compara dataset.minutes con focusMins.value). */
  const ctxCalls = [];
  const ctxStub = new Proxy(
    { measureText: (text) => ({ width: String(text).length * 6 }) },
    {
      get: (target, prop) => (prop in target ? target[prop] : (...args) => { ctxCalls.push([String(prop), ...args]); }),
      set: (target, prop, value) => ((target[prop] = value), true),
    },
  );
  const elements = {};
  function makeElement(id) {
    const handlers = {};
    const classes = new Set();
    const attributes = {};
    let value = "";
    let text = "";
    const node = {
      id,
      style: {},
      dataset: {},
      className: "",
      srcObject: null,
      hidden: false,
      checked: false,
      disabled: false,
      get value() { return value; },
      set value(v) { value = String(v); },
      get textContent() { return text; },
      set textContent(v) { text = String(v); },
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
      },
      addEventListener(type, fn) { (handlers[type] ??= []).push(fn); },
      removeEventListener(type, fn) { handlers[type] = (handlers[type] || []).filter((f) => f !== fn); },
      /* Ejecuta los manejadores y devuelve sus resultados (los async se esperan fuera). */
      emit(type, extra = {}) { return (handlers[type] || []).map((fn) => fn({ type, target: node, ...extra })); },
      dispatchEvent(event) { node.emit(event.type); return true; },
      setAttribute(name, v) { attributes[name] = String(v); },
      getAttribute: (name) => attributes[name] ?? null,
      after() {},
      append() {},
      replaceChildren() {},
      play: async () => {},
      getContext: () => ctxStub,
      getTotalLength: () => 700,
    };
    Object.assign(node, ELEMENT_DEFAULTS[id]);
    return node;
  }
  const chips = ["25", "50", "60", "90"].map((minutes) => {
    const chip = makeElement(`chip-${minutes}`);
    chip.dataset.minutes = minutes;
    return chip;
  });
  const documentHandlers = {};
  const fakeDocument = {
    hidden: false,
    title: "",
    getElementById: (id) => (elements[id] ??= makeElement(id)),
    querySelectorAll: (selector) => (selector === ".chip" ? chips : []),
    querySelector: () => null,
    createElement: () => makeElement("x"),
    addEventListener(type, fn) { (documentHandlers[type] ??= []).push(fn); },
  };
  setGlobal("document", fakeDocument);
  setGlobal("window", globalThis);
  /* Eventos de `window` (pagehide, beforeunload, pageshow…): se registran y se pueden disparar. */
  const windowHandlers = {};
  setGlobal("addEventListener", (type, fn) => {
    (windowHandlers[type] ??= []).push(fn);
  });
  setGlobal("location", { search: "?debug=1" });

  const store = new Map(Object.entries(initialStorage));
  const storageWrites = [];
  setGlobal("localStorage", {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      storageWrites.push([key, value]);
      store.set(key, value);
    },
  });

  const fetchCalls = [];
  setGlobal("fetch", async (url, init) => {
    fetchCalls.push({ url, init });
    if (!onFetch) throw new Error("fetch no permitido en el flujo de invitado");
    return onFetch(url, init);
  });

  const audio = { oscillators: 0 };
  setGlobal("AudioContext", class {
    constructor() {
      if (audioFails) throw new Error("no se pudo crear el AudioContext (simulado)");
      this.currentTime = 0;
      this.state = "running";
      this.destination = {};
    }
    createOscillator() {
      audio.oscillators++;
      return { frequency: { setValueAtTime() {} }, connect: (node) => node, start() {}, stop() {} };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (node) => node };
    }
    resume() { return Promise.resolve(); }
  });

  const notes = [];
  setGlobal("Notification", class {
    static permission = "granted";
    static requestPermission = async () => "granted";
    constructor(title, options) { notes.push({ title, options }); }
    close() {}
  });

  const track = {
    stopped: 0,
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    removeEventListener(type) { delete this.listeners[type]; },
    stop() { this.stopped++; },
  };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  /* `hold`: promesa que retiene getUserMedia (el aviso de permiso del navegador). */
  const camera = { calls: 0, fail: false, hold: null };
  setGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => {
        camera.calls++;
        if (camera.hold) await camera.hold;
        if (camera.fail) throw new Error("denegado");
        return stream;
      },
    },
  });

  /* Consola capturada (el motor y la cámara registran mensajes informativos). */
  const logs = [];
  for (const level of ["error", "info", "warn"]) {
    patch(console, level, (...args) => logs.push({ level, args }));
  }

  /* Rechazos no manejados: se recogen para poder aseverar que no hay ninguno. */
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  /* Estado que leen los módulos simulados (MediaPipe y adaptador de cuenta). */
  const mp = { calls: [], detected: 0, frame: null };
  const cdnRequests = [];
  /* Compuerta de la CDN ("pending"): el módulo simulado de MediaPipe espera a esta
     promesa antes de evaluarse, así que el motor queda en estado "cargando" hasta que
     el test la libera o la hace fallar. */
  const cdnGate = {};
  const gatePromise = new Promise((resolve, reject) => {
    cdnGate.release = resolve;
    cdnGate.fail = () => reject(new Error("CDN de MediaPipe inaccesible (simulado)"));
  });
  gatePromise.catch(() => {}); // si falla antes de que el módulo la espere, no es un rechazo sin manejar
  /* Cuenta: `loadAuth` y `restore` se pueden sustituir (Clerk lento o que rechaza) y se cuentan. */
  const authCalls = { loadAuth: 0, restore: 0 };
  const wiring = {
    mp,
    user,
    gate: cdn === "pending" ? gatePromise : null,
    loadAuth: () => {
      authCalls.loadAuth++;
      if (loadAuth) return loadAuth();
      return Promise.resolve({
        restore: () => {
          authCalls.restore++;
          return restore ? restore() : Promise.resolve(user);
        },
      });
    },
  };
  setGlobal("__postavaWiring", wiring);

  const stubs = {
    [`stub:mediapipe-${runId}`]: `
      const gate = globalThis.__postavaWiring.gate;
      if (gate) await gate;
      export const FilesetResolver = {
        forVisionTasks: async (base) => { globalThis.__postavaWiring.mp.calls.push(["wasm", base]); return {}; },
      };
      export const PoseLandmarker = {
        createFromOptions: async (vision, options) => {
          const mp = globalThis.__postavaWiring.mp;
          mp.calls.push(["create", options.baseOptions.delegate, JSON.stringify(options)]);
          return { detectForVideo: () => { mp.detected += 1; return { landmarks: mp.frame ? [mp.frame] : [] }; } };
        },
      };`,
    [`stub:auth-${runId}`]: `
      export async function loadAuth() {
        return globalThis.__postavaWiring.loadAuth();
      }`,
  };

  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith(CDN_URL)) {
        cdnRequests.push(specifier);
        return { url: cdn === "down" ? `stub:cdn-down-${runId}` : `stub:mediapipe-${runId}`, shortCircuit: true };
      }
      if (specifier === "/assets/auth-adapter.bundle.js") {
        return { url: `stub:auth-${runId}`, shortCircuit: true };
      }
      const resolved = next(specifier, context);
      const isProjectModule = resolved.url.startsWith(ROOT_URL) && !resolved.url.includes("/node_modules/");
      if (isProjectModule && context.parentURL?.includes(tag)) return { ...resolved, url: resolved.url + tag };
      return resolved;
    },
    load(url, context, next) {
      if (stubs[url]) return { format: "module", source: stubs[url], shortCircuit: true };
      if (url === `stub:cdn-down-${runId}`) throw new Error("CDN de MediaPipe inaccesible (simulado)");
      return next(url, context);
    },
  });

  let disposed = false;
  const app = {
    clock,
    advance,
    rafs,
    intervals,
    timeouts,
    cdnGate,
    authCalls,
    ctxCalls,
    chips,
    store,
    storageWrites,
    fetchCalls,
    audio,
    notes,
    camera,
    track,
    mp,
    logs,
    unhandled,
    cdnRequests,
    document: fakeDocument,
    get debug() { return globalThis.postavaDebug; },

    /* Elemento por id; falla con claridad si app.js nunca lo pidió. */
    el(id) {
      const node = elements[id];
      assert.ok(node, `app.js no ha pedido el elemento #${id}`);
      return node;
    },
    /** Pulsa un elemento; los manejadores async se esperan (los sync no devuelven nada). */
    click: (id) => Promise.all(app.el(id).emit("click")),
    /** Pulsa una tecla en `document` (el foco está en `tagName`, `extra`: ctrlKey, metaKey, altKey, repeat...); devuelve el evento para ver si se canceló. */
    key(code, key, tagName = "BODY", extra = {}) {
      const event = { target: { tagName }, code, key, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; }, ...extra };
      (documentHandlers.keydown || []).forEach((fn) => fn(event));
      return event;
    },
    /** Dispara un evento de `window` (pagehide, beforeunload, pageshow…). */
    emitWindow: (type, extra = {}) => (windowHandlers[type] || []).forEach((fn) => fn({ type, ...extra })),
    windowHandlerCount: (type) => (windowHandlers[type] || []).length,
    /** Fija los landmarks que devolverá el detector (null = nadie delante). */
    pose(frame) { mp.frame = frame; },

    /** Un fotograma: avanza el reloj y el vídeo y ejecuta el último rAF pendiente. */
    frame(ms = 100) {
      advance(ms);
      app.el("video").currentTime += ms / 1000;
      const entries = [...rafs.pending];
      assert.ok(entries.length > 0, "hay un requestAnimationFrame pendiente");
      const [id, callback] = entries.at(-1);
      rafs.pending.delete(id);
      callback();
    },
    frames(count, ms = 100) { for (let i = 0; i < count; i++) app.frame(ms); },
    /** Fotogramas hasta que se cumpla `cond` (tope duro para no colgarse). */
    framesUntil(cond, { max = 300, ms = 100, what = "la condición esperada" } = {}) {
      for (let i = 0; i < max; i++) {
        if (cond()) return i;
        app.frame(ms);
      }
      assert.ok(cond(), `tras ${max} fotogramas no se cumplió «${what}»`);
      return max;
    },
    /** Dispara el setInterval del temporizador (el reloj lo mueve `advance`). */
    tick() { intervals.forEach(({ fn }) => fn()); },

    /** Importa el app.js real con un grafo de módulos propio de este escenario. */
    load() {
      const url = new URL(APP_URL);
      url.search = tag;
      return import(url.href);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      hooks.deregister();
      process.off("unhandledRejection", onUnhandled);
      rafs.pending.clear();
      while (undo.length) undo.pop()();
    },
  };
  return app;
}

/** Crea el navegador, carga app.js y garantiza `dispose()` al terminar el subtest. */
async function bootApp(t, options) {
  const app = createBrowser(options);
  t.after(() => app.dispose());
  await app.load();
  return app;
}

/**
 * Los pasos de un escenario dependen del anterior (arranque -> calibrar -> avisar...).
 * Si uno falla, los siguientes se omiten para no llenar el informe de fallos en cascada.
 */
function stepper(t) {
  let broken = false;
  return (name, fn) =>
    t.test(name, { skip: broken ? "omitido: falló un paso previo del escenario" : false }, async (step) => {
      try {
        await fn(step);
      } catch (error) {
        broken = true;
        throw error;
      }
    });
}

const postsTo = (app, path) =>
  app.fetchCalls.filter((call) => call.url === path && call.init?.method === "POST");
const pendingWrites = (app) => app.storageWrites.filter(([key]) => key.startsWith(PENDING_KEY_PREFIX));

/**
 * `restore()` de Clerk controlado por el test: cada llamada queda retenida (Clerk lento) hasta que
 * el test la resuelve o la rechaza. Tras `resolveAll(user)` las llamadas siguientes resuelven al momento.
 */
function slowAccount() {
  const held = [];
  let resolved = false;
  let current = null;
  return {
    restore: () => (resolved ? Promise.resolve(current) : new Promise((resolve, reject) => held.push({ resolve, reject }))),
    resolveAll(user) {
      resolved = true;
      current = user;
      held.forEach((call) => call.resolve(user));
    },
    rejectAll(error) {
      held.forEach((call) => call.reject(error));
    },
  };
}

/**
 * Pulsa «Iniciar» y espera a que el temporizador esté en marcha: el manejador de clic no devuelve
 * la promesa de startTimer(), así que `app.click("btnStart")` por sí solo no espera a que arranque.
 */
async function pressStart(app) {
  await app.click("btnStart");
  await waitFor(() => app.el("btnStart").textContent === "Pausar", { what: "temporizador en marcha" });
}

/**
 * Mientras Iniciar espera a la cuenta, el botón se marca `aria-disabled="true"` y NUNCA `disabled`:
 * deshabilitar de verdad el botón enfocado le quita el foco a quien usa el teclado. Los clics se ignoran
 * por código (startPending), no por el atributo.
 */
const startBusy = (app) => {
  assert.equal(app.el("btnStart").disabled, false, "btnStart no se deshabilita de verdad (perdería el foco)");
  return app.el("btnStart").getAttribute("aria-disabled") === "true";
};

const VALID_BASELINE = { neck: 0.75, width: 0.533, tilt: 0, side: 0, chin: 0.094, shoulderY: 0.85 };
const ENGINE_READY = "Modelo de postura listo.";
const ENGINE_DOWN_MESSAGE = "Modelo de postura no disponible. El temporizador funciona igual, pero sin control de postura.";
const ACCOUNT_TIMEOUT_MESSAGE = "No se pudo comprobar tu sesión a tiempo. Si tienes cuenta, este bloque no se guardará en estadísticas.";

/* ── Pruebas ───────────────────────────────────────────────────────────── */

// Guarda estática: sin comportamiento observable no hay test de cableado posible. Antes, la rama
// «descanso terminado» de onComplete asignaba el texto del botón a "Iniciar" y, dos líneas más abajo,
// lo sobrescribía según `timer.running` (asignación muerta que confundía sobre cuál manda).
test("app.js: onComplete fija el texto de btnStart una sola vez, según timer.running", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = (await readFile(APP_URL, "utf8")).replace(/\r\n/g, "\n");
  const start = source.indexOf("onComplete:");
  const end = source.indexOf("updateStats(true);", start);
  assert.ok(start !== -1 && end > start, "no se encontró el bloque onComplete de app.js");
  const block = source.slice(start, end);
  const assignments = block.match(/el\.btnStart\.textContent\s*=/g) ?? [];
  assert.equal(assignments.length, 1, "onComplete debe asignar btnStart.textContent una única vez");
  assert.match(block, /el\.btnStart\.textContent = timer\.running \? "Pausar" : "Iniciar";/);
});

test(
  "app.js real: cableado de temporizador, cámara, MediaPipe y estadísticas con navegador simulado",
  { skip: registerHooks ? false : "requiere module.registerHooks (Node >= 22.15)" },
  async (t) => {
    await t.test("invitado: flujo completo sin cuenta ni red", async (guest) => {
      const step = stepper(guest);
      const app = await bootApp(guest);
      const el = (id) => app.el(id);
      await waitFor(() => el("engineStatus").textContent === "Modelo de postura listo.", { what: "motor de postura listo" });

      await step("arranque: la CDN de MediaPipe se importa una vez y con la versión fijada", () => {
        assert.deepEqual(app.cdnRequests, [CDN_URL]);
      });

      await step("initEngine: wasm, delegado GPU y modelo lite", () => {
        assert.deepEqual(app.mp.calls[0], ["wasm", `${CDN_URL}/wasm`]);
        assert.equal(app.mp.calls[1][1], "GPU");
        assert.match(app.mp.calls[1][2], /pose_landmarker_lite\.task/);
      });

      await step("motor listo: texto y botones habilitados", () => {
        assert.equal(el("engineStatus").textContent, "Modelo de postura listo.");
        assert.equal(el("btnCalibrate").disabled, false);
        assert.equal(el("btnCamera").disabled, false);
      });

      await step("arranque: badge 'Sin monitorizar' y temporizador 25:00", () => {
        assert.equal(el("postureBadge").textContent, "Sin monitorizar");
        assert.equal(el("postureBadge").dataset.state, "idle");
        assert.equal(el("timerDisplay").textContent, "25:00");
        assert.equal(el("phaseLabel").textContent, "Enfoque");
      });

      await step("postavaDebug (?debug=1): mismas claves y state.posture accesible", () => {
        assert.deepEqual(Object.keys(app.debug), [
          "state", "setBaseline", "forceCamera", "evaluate", "draw", "startCalibration", "handleCalibration",
        ]);
        assert.deepEqual(Object.keys(app.debug.state), ["posture", "timer"]);
        assert.equal(typeof app.debug.evaluate, "function");
        assert.equal(typeof app.debug.draw, "function");
      });

      await step("chips de minutos: el activo sigue al valor y un clic cambia la duración", async () => {
        const pressed = () => app.chips.filter((chip) => chip.getAttribute("aria-pressed") === "true").map((c) => c.dataset.minutes);
        assert.equal(app.chips.length, 4, "el arnés expone los chips de index.html");
        assert.deepEqual(pressed(), ["25"], "arranca con el chip de 25 min activo");

        await Promise.all(app.chips[1].emit("click")); // 50 min
        assert.equal(el("focusMins").value, "50");
        assert.equal(el("timerDisplay").textContent, "50:00");
        assert.deepEqual(pressed(), ["50"]);
        assert.equal(JSON.parse(app.store.get("postava.v1")).focus, 50, "el cambio se persiste");

        await Promise.all(app.chips[0].emit("click")); // vuelta a 25 min
        assert.equal(el("timerDisplay").textContent, "25:00");
        assert.deepEqual(pressed(), ["25"]);
      });

      await step("minutos fuera de rango se acotan a [min, max] del input", () => {
        el("focusMins").value = "999";
        el("focusMins").dispatchEvent(new Event("change"));
        assert.equal(el("focusMins").value, "180");
        assert.equal(el("timerDisplay").textContent, "180:00");

        el("focusMins").value = "0";
        el("focusMins").dispatchEvent(new Event("change"));
        assert.equal(el("focusMins").value, "1");
        assert.equal(el("timerDisplay").textContent, "01:00");

        el("focusMins").value = "25";
        el("focusMins").dispatchEvent(new Event("change"));
        assert.equal(el("timerDisplay").textContent, "25:00");
      });

      await step("Iniciar: enciende la cámara, muestra 'Pausar' y arranca el bucle", async () => {
        await app.click("btnStart");
        await waitFor(() => el("postureMsg").textContent.startsWith("Pulsa"), { what: "cámara encendida y mensaje de calibrar" });
        assert.equal(app.camera.calls, 1);
        assert.equal(el("overlay").width, 640);
        assert.equal(el("camPlaceholder").hidden, true);
        assert.equal(el("btnCamera").textContent, "Apagar cámara");
        assert.equal(el("btnStart").textContent, "Pausar");
        assert.equal(el("timerHint").textContent, "en marcha");
        assert.equal(app.rafs.pending.size, 1);
      });

      await step("Iniciar sin calibración previa: pide calibrar", () => {
        assert.equal(el("postureMsg").textContent, "Pulsa «Calibrar postura» sentado como quieres estar durante la sesión.");
      });

      await step("el setInterval de 250 ms avanza el temporizador con el reloj falso", () => {
        assert.deepEqual(app.intervals.map((i) => i.ms), [250], "un único intervalo de tick cada 250 ms");
        app.tick();
        assert.equal(el("timerDisplay").textContent, "25:00", "sin tiempo transcurrido no cambia");

        app.advance(5_000);
        app.tick();
        assert.equal(el("timerDisplay").textContent, "24:55");
        assert.equal(app.document.title, "24:55 · Enfoque · Postava");
        assert.equal(app.debug.state.timer.remaining, FOCUS_MS - 5_000);
        assert.equal(el("timerHint").textContent, "en marcha");
      });

      app.pose(GOOD);
      await step("sin calibración, el bucle pinta 'Sin calibrar'", () => {
        app.frames(2);
        assert.equal(el("postureBadge").textContent, "Sin calibrar");
      });

      await step("tecla C: arranca la calibración (overlay, botón, dataset, pista, mensaje, badge)", () => {
        app.key("KeyC", "c");
        assert.equal(el("calibOverlay").hidden, false);
        assert.equal(el("btnCalibrate").disabled, true);
        assert.equal(el("stage").dataset.calibrating, "true");
        assert.equal(el("calibHint").textContent, "Siéntate recto y mira a la pantalla");
        assert.equal(el("postureBadge").textContent, "Calibrando…");
        assert.equal(el("postureMsg").textContent, "Estos son los puntos que voy a medir: orejas, nariz y hombros.");
      });

      await step("calibración: cuenta atrás visible", () => {
        app.frames(3);
        assert.ok(Number(el("calibCount").textContent) >= 1);
      });

      await step("calibrado: overlay oculto, modo mapa, baseline persistida, badge y mensaje", () => {
        app.framesUntil(() => el("calibOverlay").hidden === true, { what: "fin de la calibración" });
        app.frames(2);
        assert.equal(el("calibOverlay").hidden, true);
        assert.equal(el("stage").dataset.calibrating, "false");
        assert.equal(el("btnCalibrate").disabled, false);
        assert.equal(el("hideVideoToggle").checked, true);
        assert.equal(el("stage").dataset.hideVideo, "true");
        const saved = JSON.parse(app.store.get("postava.v1"));
        assert.ok(saved.baseline && typeof saved.baseline.neck === "number");
        assert.equal(saved.hideVideo, true);
        assert.equal(el("postureBadge").textContent, "Postura correcta");
        assert.equal(el("postureMsg").textContent, "Calibrado. Oculto la imagen y dejo solo el mapa de puntos; te avisaré si te desvías.");
        assert.equal(app.debug.state.posture.baseline.neck, saved.baseline.neck);
      });

      const oscillatorsBefore = app.audio.oscillators;
      app.document.hidden = true; // pestaña oculta: el aviso debe llegar como notificación del sistema
      app.pose(BAD);

      await step("mala postura antes del retardo: 'Postura mejorable', barra ámbar, sin aviso", () => {
        app.frames(15); // 1,5 s de un retardo de 2 s
        assert.equal(el("postureBadge").textContent, "Postura mejorable");
        assert.equal(el("alertBanner").hidden, true);
        assert.equal(el("holdFill").style.background, "var(--warn)");
        assert.match(el("holdFill").style.width, /%$/);
        assert.equal(app.notes.length, 0);
      });

      await step("aviso tras el retardo: banner, sonido, notificación, contador y barra roja", () => {
        app.frames(8);
        assert.equal(el("alertBanner").hidden, false);
        assert.ok(el("alertReason").textContent.length > 0);
        assert.equal(el("postureMsg").textContent, el("alertReason").textContent);
        assert.equal(el("postureBadge").textContent, "Corrige la postura");
        assert.equal(app.audio.oscillators - oscillatorsBefore, 2, "dos tonos de aviso");
        assert.equal(app.notes.length, 1);
        assert.equal(app.notes[0].options.tag, "postava-posture");
        assert.equal(app.notes[0].options.renotify, true);
        assert.equal(app.notes[0].options.body, el("alertReason").textContent);
        assert.equal(el("alertCount").textContent, "1");
        assert.equal(el("holdFill").style.background, "var(--bad)");
        assert.equal(app.debug.state.posture.alerts, 1);
      });
      app.document.hidden = false;

      await step("recuperación: banner oculto, mensaje, badge y barra a 0", () => {
        app.pose(GOOD);
        app.frames(14);
        assert.equal(el("alertBanner").hidden, true);
        assert.equal(el("postureMsg").textContent, "Bien, postura recuperada.");
        assert.equal(el("postureBadge").textContent, "Postura correcta");
        assert.equal(el("holdFill").style.width, "0%");
        assert.equal(app.debug.state.posture.alerting, false);
      });

      await step("no detectado: badge 'No te veo' y, pasados 3 s, mensaje de colocarse", () => {
        app.pose(null);
        app.frames(5);
        assert.equal(el("postureBadge").textContent, "No te veo");
        assert.equal(el("holdFill").style.width, "0%");
        app.frames(35);
        assert.equal(el("postureMsg").textContent, "No detecto tu cabeza y hombros. Colócate frente a la cámara.");
      });

      await step("postavaDebug: setBaseline, evaluate y draw funcionan sin cámara real", () => {
        const baseline = { neck: 0.75, width: 0.533, tilt: 0, side: 0, chin: 0.094, shoulderY: 0.85 };
        app.debug.setBaseline(baseline);
        assert.equal(app.debug.state.posture.baseline.neck, 0.75);
        assert.equal(app.debug.state.posture.smoothed.neck, 0.75);
        app.debug.evaluate(baseline, app.clock.perf + 100);
        app.debug.draw(null);
        app.debug.draw(GOOD);
      });

      await step("Pausar (cámara solo en marcha): 'Reanudar', rAF cancelado, cámara y pistas apagadas", async () => {
        const cancelledBefore = app.rafs.cancelled.length;
        await app.click("btnStart");
        assert.equal(el("btnStart").textContent, "Reanudar");
        assert.equal(el("timerHint").textContent, "en pausa");
        assert.ok(app.rafs.cancelled.length > cancelledBefore, "stop() canceló el rAF");
        assert.equal(app.rafs.pending.size, 0);
        assert.equal(el("camPlaceholder").hidden, false);
        assert.equal(el("btnCamera").textContent, "Encender cámara");
        assert.ok(app.track.stopped >= 1);
        assert.equal(el("video").srcObject, null);
        assert.equal(el("postureBadge").textContent, "Sin monitorizar");
        assert.equal(el("holdFill").style.width, "0%");
        assert.equal(el("alertBanner").hidden, true);
        assert.ok(app.ctxCalls.some((call) => call[0] === "clearRect"));
      });

      await step("botón de cámara: enciende de nuevo y reprograma el bucle", async () => {
        await app.click("btnCamera");
        await waitFor(() => el("btnCamera").textContent === "Apagar cámara", { what: "cámara encendida" });
        assert.equal(app.camera.calls, 2);
        assert.equal(app.rafs.pending.size, 1);
      });

      await step("botón de cámara: apaga y cancela el rAF", async () => {
        await app.click("btnCamera");
        assert.equal(el("btnCamera").textContent, "Encender cámara");
        assert.equal(app.rafs.pending.size, 0);
      });

      await step("calibrar con la cámara apagada: la enciende y calibra", async () => {
        await app.click("btnCalibrate");
        await waitFor(() => el("stage").dataset.calibrating === "true", { what: "calibración iniciada" });
        assert.equal(app.camera.calls, 3);
        assert.equal(app.debug.state.posture.calibrating, true);
      });

      await step("apagar la cámara durante la calibración la cancela (overlay, dataset, botón)", async () => {
        await app.click("btnCamera");
        assert.equal(app.debug.state.posture.calibrating, false);
        assert.equal(el("calibOverlay").hidden, true);
        assert.equal(el("stage").dataset.calibrating, "false");
        assert.equal(el("btnCalibrate").disabled, false);
      });

      await step("segunda sesión: el estado se reutiliza y vuelve a avisar", async () => {
        await app.click("btnStart"); // estaba en pausa: reanuda y enciende la cámara
        await waitFor(() => app.rafs.pending.size === 1, { what: "bucle de postura activo" });
        app.pose(BAD);
        app.frames(35);
        assert.ok(app.debug.state.posture.alerts >= 1);
      });

      await step("saltar la fase de enfoque: sin aviso, en descanso y con la cámara apagada", async () => {
        await app.click("btnSkip");
        assert.equal(el("alertBanner").hidden, true);
        assert.equal(el("timerHint").textContent, "descansa y estírate");
        assert.equal(el("phaseLabel").textContent, "Descanso");
        assert.equal(app.rafs.pending.size, 0);
      });

      await step("reiniciar: contadores a 0 y 'Sesión 1'", async () => {
        await app.click("btnReset");
        const posture = app.debug.state.posture;
        assert.equal(posture.goodMs, 0);
        assert.equal(posture.badMs, 0);
        assert.equal(posture.alerts, 0);
        assert.equal(posture.badSince, null);
        assert.equal(el("alertCount").textContent, "0");
        assert.equal(el("cycleLabel").textContent, "Sesión 1");
      });

      await step("pomodoro completado como invitado: descanso, aviso del sistema y sin red", async () => {
        const oscillatorsBefore = app.audio.oscillators;
        const notesBefore = app.notes.length;
        await app.click("btnStart");
        await waitFor(() => el("btnCamera").textContent === "Apagar cámara", { what: "cámara encendida" });

        app.advance(FOCUS_MS);
        app.tick();

        assert.equal(el("phaseLabel").textContent, "Descanso");
        assert.equal(el("timerHint").textContent, "descansa y estírate");
        assert.equal(el("focusDone").textContent, "1");
        assert.equal(el("btnCamera").textContent, "Encender cámara", "la cámara se apaga al acabar el enfoque");
        assert.equal(app.audio.oscillators - oscillatorsBefore, 3, "tres tonos de fin de fase");
        assert.equal(app.notes.length - notesBefore, 1);
        const note = app.notes.at(-1);
        assert.equal(note.options.tag, "postava-phase");
        assert.equal(note.options.body, "Fase de enfoque terminada. Toca descansar.");
        assert.equal(note.options.renotify, true);
        assert.deepEqual(pendingWrites(app), [], "sin cuenta no se encola nada");
        await settle();
        assert.deepEqual(app.fetchCalls, []);
      });

      await step("permiso de cámara denegado: mensaje y badge 'Sin cámara'", async () => {
        app.camera.fail = true;
        await app.click("btnCamera");
        await waitFor(() => el("postureBadge").textContent === "Sin cámara", { what: "badge 'Sin cámara'" });
        assert.match(el("postureMsg").textContent, /^Permiso de cámara denegado/);
      });

      await step("ningún fetch en todo el flujo de invitado", () => {
        assert.deepEqual(app.fetchCalls, []);
      });

      await step("sin rechazos no manejados ni errores de consola inesperados", () => {
        assert.deepEqual(app.unhandled, []);
        const errors = app.logs.filter((entry) => entry.level === "error");
        assert.equal(errors.length, 1, "solo el error del permiso denegado");
        assert.equal(errors[0].args[0]?.message, "denegado");
      });
    });

    await t.test("cuenta ficticia: saltar no registra estadísticas; completar registra una vez", async (account) => {
      const step = stepper(account);
      const USER_ID = "user_test12345678";
      const app = await bootApp(account, {
        user: { id: USER_ID },
        onFetch: () => ({ ok: true, status: 200 }),
      });
      const el = (id) => app.el(id);
      await waitFor(() => el("engineStatus").textContent === "Modelo de postura listo.", { what: "motor de postura listo" });

      await step("iniciar el enfoque enciende la cámara", async () => {
        await app.click("btnStart");
        await waitFor(() => el("btnCamera").textContent === "Apagar cámara", { what: "cámara encendida" });
        assert.equal(el("timerHint").textContent, "en marcha");
      });

      await step("saltar el enfoque no registra ni encola nada (aunque ya haya tiempo acumulado)", async () => {
        // Con tiempo activo (elapsedMs > 0) la única barrera es el `!skipped` de app.js.
        app.advance(10 * 60_000);
        app.tick();
        assert.equal(el("timerDisplay").textContent, "15:00");
        await app.click("btnSkip");
        assert.equal(el("phaseLabel").textContent, "Descanso");
        assert.equal(el("focusDone").textContent, "0");
        assert.equal(app.debug.state.timer.completed, 0);
        // recordCompletedFocus escribe la cola de forma síncrona: si se hubiera llamado, ya habría constancia.
        assert.deepEqual(pendingWrites(app), []);
        assert.deepEqual(postsTo(app, "/api/stats/sessions"), []);
        await settle();
        assert.deepEqual(postsTo(app, "/api/stats/sessions"), []);
      });

      await step("saltar el descanso pasa a la sesión 2 en enfoque, parado", async () => {
        await app.click("btnSkip");
        assert.equal(el("phaseLabel").textContent, "Enfoque");
        assert.equal(el("cycleLabel").textContent, "Sesión 2");
        assert.equal(el("btnStart").textContent, "Iniciar");
        assert.equal(app.debug.state.timer.running, false);
        assert.deepEqual(postsTo(app, "/api/stats/sessions"), []);
      });

      await step("un pomodoro completado registra exactamente una sesión con la duración real", async () => {
        const focusStartedAt = app.clock.date;
        await app.click("btnStart");
        await waitFor(() => el("btnCamera").textContent === "Apagar cámara", { what: "cámara encendida" });

        app.advance(FOCUS_MS);
        app.tick();

        await waitFor(() => postsTo(app, "/api/stats/sessions").length >= 1, { what: "envío de la sesión completada" });
        await settle();
        assert.equal(postsTo(app, "/api/stats/sessions").length, 1, "una sola sesión registrada por pomodoro completado");
        const [post] = postsTo(app, "/api/stats/sessions");
        assert.equal(post.init.credentials, "same-origin");
        const body = JSON.parse(post.init.body);
        assert.equal(body.type, "focus");
        assert.equal(body.completed, true);
        assert.equal(body.expectedUserId, USER_ID, "la sesión se atribuye a la cuenta presente al empezar");
        assert.equal(body.durationMinutes, 25, "elapsedMs > 0 y equivalente a 25 min");
        assert.equal(body.startedAt, new Date(focusStartedAt).toISOString());
        assert.ok(
          validateSessionPayload(body, app.clock.date),
          "el cuerpo real que sale del cliente lo acepta el validador del servidor (sin claves de más)",
        );

        assert.equal(el("focusDone").textContent, "1");
        assert.equal(el("phaseLabel").textContent, "Descanso");
        assert.equal(app.debug.state.timer.completed, 1);
      });

      await step("no hay envíos duplicados y la cola queda vacía", async () => {
        await settle();
        app.tick();
        app.tick();
        await settle();
        assert.equal(postsTo(app, "/api/stats/sessions").length, 1);
        assert.equal(app.fetchCalls.length, 1, "ninguna otra petición de red");
        assert.equal(app.store.get(`${PENDING_KEY_PREFIX}${USER_ID}`), "[]");
        assert.deepEqual(app.unhandled, []);
      });
    });

    await t.test("cámara: arranques concurrentes, cancelados y salida de la página", async (cam) => {
      const step = stepper(cam);
      const app = await bootApp(cam);
      const el = (id) => app.el(id);
      await waitFor(() => el("engineStatus").textContent === "Modelo de postura listo.", { what: "motor de postura listo" });
      /** Retiene getUserMedia (aviso de permiso pendiente) y devuelve la función que lo concede. */
      const holdPermission = () => {
        let release;
        app.camera.hold = new Promise((resolve) => (release = resolve));
        return () => {
          app.camera.hold = null;
          release();
        };
      };

      await step("botón de cámara + tecla C con el permiso pendiente: UN getUserMedia y UN bucle", async () => {
        const grant = holdPermission();
        await app.click("btnCamera");
        app.key("KeyC", "c"); // calibrar con la cámara apagada también pide la cámara
        await settle();
        assert.equal(app.camera.calls, 1, "solo un getUserMedia en vuelo");

        grant();
        await waitFor(() => el("btnCamera").textContent === "Apagar cámara", { what: "cámara encendida" });
        await waitFor(() => el("stage").dataset.calibrating === "true", { what: "calibración iniciada" });
        assert.equal(app.camera.calls, 1, "no se abrió un segundo stream");
        assert.equal(app.track.stopped, 0, "ninguna pista parada mientras la cámara está encendida");
        assert.equal(app.rafs.pending.size, 1, "un solo bucle de inferencia");
      });

      await step("apagar la cámara la deja apagada (pistas paradas, sin bucle)", async () => {
        await app.click("btnCamera");
        assert.equal(el("btnCamera").textContent, "Encender cámara");
        assert.ok(app.track.stopped >= 1);
        assert.equal(app.rafs.pending.size, 0);
      });

      await step("pausar mientras el permiso está pendiente cancela el arranque: sin error, sin cámara y sin bucle", async () => {
        const callsBefore = app.camera.calls;
        const stoppedBefore = app.track.stopped;
        const grant = holdPermission();
        await app.click("btnStart"); // inicia el enfoque y pide la cámara
        await waitFor(() => app.camera.calls === callsBefore + 1, { what: "getUserMedia en vuelo" });
        assert.equal(app.debug.state.timer.running, true);

        await app.click("btnStart"); // pausar: apaga la cámara (camOnlyRunning) con el arranque aún pendiente
        assert.equal(el("btnStart").textContent, "Reanudar");
        grant(); // el permiso llega tarde
        await settle();

        assert.equal(el("btnCamera").textContent, "Encender cámara", "la cámara no se enciende tras cancelar");
        assert.equal(el("camPlaceholder").hidden, false);
        assert.equal(app.rafs.pending.size, 0, "no arranca el bucle");
        assert.ok(app.track.stopped > stoppedBefore, "las pistas del stream tardío se paran");
        assert.equal(el("postureBadge").textContent, "Sin monitorizar");
        assert.doesNotMatch(el("postureMsg").textContent, /tardó|denegado|no permite|desconect/i, "cancelar no es un error para el usuario");
        assert.equal(el("timerHint").textContent, "en pausa");
        assert.deepEqual(app.unhandled, []);
      });

      await step("volver a encender tras una cancelación funciona", async () => {
        await app.click("btnCamera");
        await waitFor(() => el("btnCamera").textContent === "Apagar cámara", { what: "cámara encendida" });
        assert.equal(app.rafs.pending.size, 1);
      });

      await step("pagehide y beforeunload sueltan las pistas con la misma lógica", () => {
        assert.equal(app.windowHandlerCount("pagehide"), 1);
        assert.equal(app.windowHandlerCount("beforeunload"), 1);
        const before = app.track.stopped;
        app.emitWindow("pagehide");
        assert.equal(app.track.stopped, before + 1, "pagehide para las pistas");
        app.emitWindow("beforeunload");
        assert.equal(app.track.stopped, before + 2, "beforeunload también");
      });

      await step("pageshow desde bfcache apaga la cámara (pistas ya paradas); una carga normal no toca nada", () => {
        app.emitWindow("pageshow", { persisted: false });
        assert.equal(el("btnCamera").textContent, "Apagar cámara", "carga normal: sin cambios");
        app.emitWindow("pageshow", { persisted: true });
        assert.equal(el("btnCamera").textContent, "Encender cámara");
        assert.equal(el("camPlaceholder").hidden, false);
        assert.equal(app.rafs.pending.size, 0);
        assert.equal(el("video").srcObject, null);
      });

      await step("sin rechazos no manejados", () => {
        assert.deepEqual(app.unhandled, []);
      });
    });

    // Regla de uso anónimo: el temporizador debe funcionar SIN cámara ni modelo.
    // app.js importa MediaPipe de forma dinámica (`mediapipe: () => import(CDN)`), así
    // que con la CDN caída el módulo sigue enlazando y el fallo llega a `onEngineError`.
    await t.test(
      "CDN de MediaPipe caída: app.js carga, el temporizador arranca y avanza, y se informa del fallo del modelo",
      async (scenario) => {
        const app = createBrowser({ cdn: "down" });
        scenario.after(() => app.dispose());
        await assert.doesNotReject(() => app.load(), "app.js debe cargar aunque la CDN de MediaPipe falle");

        const el = (id) => app.el(id);
        assert.equal(el("timerDisplay").textContent, "25:00");
        await app.click("btnStart");
        await waitFor(() => el("btnStart").textContent === "Pausar", { what: "temporizador en marcha" });
        assert.equal(el("timerHint").textContent, "en marcha");

        app.advance(5_000);
        app.tick();
        assert.equal(el("timerDisplay").textContent, "24:55");

        await waitFor(() => el("engineStatus").classList.contains("error"), { what: "aviso de fallo del modelo" });
        assert.match(el("engineStatus").textContent, /No se pudo cargar el modelo de visión/);
        assert.equal(el("btnCalibrate").disabled, true, "sin modelo no se puede calibrar");
      },
    );

    /* ── Motor de postura caído: modo "solo temporizador" ────────────────── */

    await t.test("motor caído: Iniciar arranca el temporizador y NO enciende la cámara (ni con C ni con el botón)", async (down) => {
      const step = stepper(down);
      const app = await bootApp(down, { cdn: "down" });
      const el = (id) => app.el(id);
      await waitFor(() => el("engineStatus").classList.contains("error"), { what: "aviso de fallo del modelo" });

      await step("Iniciar: el temporizador corre y no se llama a getUserMedia", async () => {
        await pressStart(app);
        assert.equal(el("btnStart").textContent, "Pausar");
        assert.equal(startBusy(app), false);
        assert.equal(el("timerHint").textContent, "en marcha");
        assert.equal(app.camera.calls, 0, "sin modelo no se pide la cámara");
        assert.equal(app.rafs.pending.size, 0);
        assert.equal(el("btnCamera").textContent, "Encender cámara");
        assert.equal(el("camPlaceholder").hidden, false);
        app.advance(5_000);
        app.tick();
        assert.equal(el("timerDisplay").textContent, "24:55");
      });

      await step("el aviso del modelo sigue visible y se explica el modo solo temporizador", async () => {
        assert.equal(el("engineStatus").classList.contains("error"), true);
        assert.match(el("engineStatus").textContent, /^No se pudo cargar el modelo de visión/);
        await waitFor(() => el("postureMsg").textContent === ENGINE_DOWN_MESSAGE, { what: "mensaje de solo temporizador" });
        assert.equal(el("btnCamera").disabled, true);
        assert.equal(el("btnCalibrate").disabled, true);
      });

      await step("tecla C: ni enciende la cámara ni calibra", async () => {
        app.key("KeyC", "c");
        await settle();
        assert.equal(app.camera.calls, 0);
        assert.equal(el("calibOverlay").hidden, true);
        assert.equal(app.debug.state.posture.calibrating, false);
      });

      await step("botón de cámara (aunque el real está deshabilitado): no la enciende", async () => {
        await app.click("btnCamera");
        await settle();
        assert.equal(app.camera.calls, 0);
        assert.equal(el("btnCamera").textContent, "Encender cámara");
        assert.equal(app.rafs.pending.size, 0);
      });

      await step("pausar y reanudar tampoco la encienden", async () => {
        await app.click("btnStart");
        assert.equal(el("btnStart").textContent, "Reanudar");
        await app.click("btnStart");
        assert.equal(el("btnStart").textContent, "Pausar");
        assert.equal(app.camera.calls, 0);
      });

      await step("descanso y un nuevo enfoque: el temporizador sigue sin cámara", async () => {
        await app.click("btnSkip"); // enfoque -> descanso (en marcha)
        await app.click("btnSkip"); // descanso -> enfoque (parado)
        assert.equal(el("phaseLabel").textContent, "Enfoque");
        await pressStart(app);
        await settle();
        assert.equal(app.camera.calls, 0);
      });

      await step("sin red ni rechazos no manejados", () => {
        assert.deepEqual(app.fetchCalls, []);
        assert.deepEqual(app.unhandled, []);
      });
    });

    await t.test("motor cargando: Iniciar enciende la cámara como siempre; si el modelo falla después, se apaga", async (loading) => {
      const step = stepper(loading);
      const app = await bootApp(loading, { cdn: "pending" });
      const el = (id) => app.el(id);

      await step("cargando: Iniciar enciende la cámara (comportamiento actual)", async () => {
        assert.equal(el("engineStatus").classList.contains("error"), false);
        await app.click("btnStart");
        await waitFor(() => el("btnCamera").textContent === "Apagar cámara", { what: "cámara encendida" });
        assert.equal(app.camera.calls, 1);
        assert.equal(app.rafs.pending.size, 1);
        assert.equal(el("btnStart").textContent, "Pausar");
      });

      await step("el modelo falla con la cámara encendida: la cámara se apaga y el temporizador sigue", async () => {
        app.cdnGate.fail();
        await waitFor(() => el("engineStatus").classList.contains("error"), { what: "aviso de fallo del modelo" });
        assert.equal(el("btnCamera").textContent, "Encender cámara", "sin modelo no hay detección ni botón para apagarla");
        assert.ok(app.track.stopped >= 1);
        assert.equal(el("video").srcObject, null);
        assert.equal(app.rafs.pending.size, 0);
        assert.equal(el("camPlaceholder").hidden, false);
        assert.equal(el("btnStart").textContent, "Pausar");
        assert.equal(app.debug.state.timer.running, true);
        assert.deepEqual(app.unhandled, []);
      });
    });

    await t.test("motor cargando con el permiso de cámara pendiente: si el modelo falla, la cámara no llega a encenderse", async (pending) => {
      const app = await bootApp(pending, { cdn: "pending" });
      const el = (id) => app.el(id);
      let grant;
      app.camera.hold = new Promise((resolve) => (grant = resolve));

      const started = app.click("btnStart"); // startTimer queda esperando el permiso de cámara
      await waitFor(() => app.camera.calls === 1, { what: "getUserMedia en vuelo" });
      app.cdnGate.fail();
      await waitFor(() => el("engineStatus").classList.contains("error"), { what: "aviso de fallo del modelo" });

      app.camera.hold = null;
      grant(); // el permiso llega tarde, con el modelo ya caído
      await started;
      await waitFor(() => el("postureMsg").textContent === ENGINE_DOWN_MESSAGE, { what: "mensaje de solo temporizador" });
      await settle();

      assert.equal(el("btnCamera").textContent, "Encender cámara");
      assert.equal(el("camPlaceholder").hidden, false);
      assert.equal(app.rafs.pending.size, 0, "no arranca el bucle");
      assert.ok(app.track.stopped >= 1, "el stream tardío se para");
      assert.equal(el("btnStart").textContent, "Pausar", "el temporizador sigue");
      assert.equal(el("postureMsg").textContent, ENGINE_DOWN_MESSAGE);
      assert.deepEqual(app.unhandled, []);
    });

    await t.test("el modelo falla: el mensaje de postura explica el modo solo temporizador (también si falla después de iniciar)", async (engine) => {
      await engine.test("falla con el temporizador ya en marcha: el aviso de calibrar deja paso al de modelo no disponible", async (late) => {
        const app = await bootApp(late, { cdn: "pending" });
        await app.click("btnStart");
        await waitFor(() => app.el("postureMsg").textContent.startsWith("Pulsa"), { what: "aviso de calibrar (cámara encendida)" });

        app.cdnGate.fail();
        await waitFor(() => app.el("engineStatus").classList.contains("error"), { what: "aviso de fallo del modelo" });
        assert.equal(app.el("postureMsg").textContent, ENGINE_DOWN_MESSAGE);
        assert.equal(app.debug.state.timer.running, true, "el temporizador sigue");
      });

      await engine.test("falla al cargar la página, sin pulsar nada: el mensaje ya está puesto", async (boot) => {
        const app = await bootApp(boot, { cdn: "down" });
        await waitFor(() => app.el("engineStatus").classList.contains("error"), { what: "aviso de fallo del modelo" });
        assert.equal(app.el("postureMsg").textContent, ENGINE_DOWN_MESSAGE);
      });
    });

    /* ── Iniciar no se queda esperando a Clerk ───────────────────────────── */

    await t.test("Clerk lento: Iniciar espera como mucho 2 s, arranca como invitado y no cancela la resolución", async (slow) => {
      const step = stepper(slow);
      const account = slowAccount();
      const LATE_USER = { id: "user_late12345678" };
      const app = await bootApp(slow, { restore: account.restore, onFetch: () => ({ ok: true, status: 200 }) });
      const el = (id) => app.el(id);
      await waitFor(() => el("engineStatus").textContent === ENGINE_READY, { what: "motor de postura listo" });
      await waitFor(() => app.authCalls.restore === 1, { what: "resolución de cuenta del arranque (resumePending)" });
      let started;

      await step("Iniciar con Clerk sin responder: botón aria-disabled (sin perder el foco) y un único plazo de 2 s", async () => {
        started = app.click("btnStart");
        await waitFor(() => app.authCalls.restore === 2, { what: "resolución de cuenta de Iniciar" });
        assert.equal(startBusy(app), true);
        assert.equal(el("btnStart").textContent, "Iniciar");
        assert.equal(app.debug.state.timer.running, false);
        assert.deepEqual(app.timeouts.created, [2000]);
        assert.equal(app.timeouts.pending.size, 1);
      });

      await step("antes del plazo no arranca, y ni Espacio ni un clic con el botón aria-disabled reentran", async () => {
        app.advance(1_999);
        await settle();
        assert.equal(app.debug.state.timer.running, false);
        app.key("Space", " ");
        app.key("Space", " ");
        await app.click("btnStart"); // aria-disabled no bloquea el clic: se ignora por código
        await app.click("btnStart");
        await settle();
        assert.equal(app.authCalls.restore, 2, "Espacio ni el clic lanzan otra resolución de cuenta");
        assert.deepEqual(app.timeouts.created, [2000], "ni otro plazo");
        assert.equal(startBusy(app), true);
        assert.equal(app.debug.state.timer.running, false);
      });

      await step("a los 2 s arranca como invitado: temporizador en marcha, cámara encendida y plazo liberado", async () => {
        app.advance(1);
        await started;
        await waitFor(() => el("btnStart").textContent === "Pausar", { what: "temporizador en marcha" });
        assert.equal(startBusy(app), false);
        assert.equal(el("timerHint").textContent, "en marcha");
        assert.equal(app.debug.state.timer.running, true);
        assert.equal(app.timeouts.pending.size, 0);
        assert.equal(app.camera.calls, 1, "una sola cámara aunque se pulsara Espacio dos veces");
        assert.deepEqual(app.fetchCalls, []);
      });

      await step("la cuenta que llega tarde NO se adjunta al bloque ya iniciado: no se encola ni se envía", async () => {
        account.resolveAll(LATE_USER);
        await settle();
        app.advance(FOCUS_MS);
        app.tick();
        await settle();
        assert.equal(el("focusDone").textContent, "1");
        assert.equal(el("phaseLabel").textContent, "Descanso");
        assert.deepEqual(pendingWrites(app), [], "el bloque de invitado no se encola");
        assert.deepEqual(app.fetchCalls, [], "ni se envía nada al servidor");
      });

      await step("el siguiente bloque, ya con la cuenta resuelta, sí se asocia a ella y se envía una vez", async () => {
        await app.click("btnSkip"); // fin del descanso: sesión 2, enfoque parado
        assert.equal(el("phaseLabel").textContent, "Enfoque");
        await pressStart(app);
        app.advance(FOCUS_MS);
        app.tick();
        await waitFor(() => postsTo(app, "/api/stats/sessions").length >= 1, { what: "envío de la sesión completada" });
        await settle();
        const posts = postsTo(app, "/api/stats/sessions");
        assert.equal(posts.length, 1);
        assert.equal(JSON.parse(posts[0].init.body).expectedUserId, LATE_USER.id);
        assert.equal(app.fetchCalls.length, 1);
        assert.deepEqual(app.unhandled, []);
      });
    });

    await t.test("Clerk a tiempo: Iniciar arranca al momento, arma el plazo de 2 s y lo cancela", async (fast) => {
      const step = stepper(fast);
      const USER_ID = "user_fast12345678";
      const app = await bootApp(fast, { user: { id: USER_ID }, onFetch: () => ({ ok: true, status: 200 }) });
      const el = (id) => app.el(id);
      await waitFor(() => el("engineStatus").textContent === ENGINE_READY, { what: "motor de postura listo" });

      await step("Iniciar no espera el plazo: arranca sin avanzar el reloj y no deja plazos pendientes", async () => {
        await pressStart(app);
        assert.equal(el("btnStart").textContent, "Pausar");
        assert.equal(startBusy(app), false);
        assert.equal(app.debug.state.timer.running, true);
        assert.deepEqual(app.timeouts.created, [2000], "se armó el plazo de 2 s");
        assert.equal(app.timeouts.pending.size, 0, "y se canceló al resolver la cuenta");
      });

      await step("el bloque se asocia a la cuenta y, al completarse, se envía una sola vez", async () => {
        app.advance(FOCUS_MS);
        app.tick();
        await waitFor(() => postsTo(app, "/api/stats/sessions").length >= 1, { what: "envío de la sesión completada" });
        await settle();
        const posts = postsTo(app, "/api/stats/sessions");
        assert.equal(posts.length, 1);
        assert.equal(JSON.parse(posts[0].init.body).expectedUserId, USER_ID);
        assert.deepEqual(app.unhandled, []);
      });
    });

    await t.test("Iniciar nunca deshabilita el botón (ni un instante, ni con la cuenta a tiempo): el foco del teclado se conserva", async (focus) => {
      const app = await bootApp(focus, { user: { id: "user_focus1234567" }, onFetch: () => ({ ok: true, status: 200 }) });
      await waitFor(() => app.el("engineStatus").textContent === ENGINE_READY, { what: "motor de postura listo" });
      // Espía la propiedad real: en un navegador, disabled = true sobre el botón enfocado lo desenfoca.
      const button = app.el("btnStart");
      const disabledWrites = [];
      Object.defineProperty(button, "disabled", {
        configurable: true,
        get: () => false,
        set: (value) => disabledWrites.push(value),
      });

      await pressStart(app);
      assert.deepEqual(disabledWrites, [], "startTimer no toca `disabled`");
      assert.equal(startBusy(app), false);
    });

    await t.test("loadAuth (clerk.load) sin responder: Iniciar también arranca a los 2 s como invitado y sin red", async (noLoad) => {
      const app = await bootApp(noLoad, { loadAuth: () => new Promise(() => {}) });
      const el = (id) => app.el(id);
      await waitFor(() => el("engineStatus").textContent === ENGINE_READY, { what: "motor de postura listo" });

      const started = app.click("btnStart");
      await settle();
      assert.equal(startBusy(app), true);
      assert.equal(app.debug.state.timer.running, false);

      app.advance(2_000);
      await started;
      await waitFor(() => el("btnStart").textContent === "Pausar", { what: "temporizador en marcha" });
      assert.equal(startBusy(app), false);
      assert.equal(app.debug.state.timer.running, true);

      app.advance(FOCUS_MS);
      app.tick();
      await settle();
      assert.equal(el("focusDone").textContent, "1");
      assert.deepEqual(app.fetchCalls, []);
      assert.deepEqual(pendingWrites(app), []);
      assert.deepEqual(app.unhandled, []);
    });

    await t.test("restore rechaza: antes del plazo arranca como invitado al instante; después no deja rechazos sin manejar", async (rejects) => {
      await rejects.test("rechazo antes del plazo", async (early) => {
        const app = await bootApp(early, { restore: () => Promise.reject(new Error("clerk caído")) });
        await waitFor(() => app.el("engineStatus").textContent === ENGINE_READY, { what: "motor de postura listo" });
        await pressStart(app);
        assert.equal(app.debug.state.timer.running, true);
        assert.equal(app.timeouts.pending.size, 0);
        assert.deepEqual(app.fetchCalls, []);
        assert.deepEqual(app.unhandled, []);
      });

      await rejects.test("rechazo tardío, con el bloque ya iniciado como invitado", async (late) => {
        const account = slowAccount();
        const app = await bootApp(late, { restore: account.restore });
        await waitFor(() => app.el("engineStatus").textContent === ENGINE_READY, { what: "motor de postura listo" });
        const started = app.click("btnStart");
        await waitFor(() => app.authCalls.restore === 2, { what: "resolución de cuenta de Iniciar" });
        app.advance(2_000);
        await started;
        await waitFor(() => app.el("btnStart").textContent === "Pausar", { what: "temporizador en marcha" });
        assert.equal(app.debug.state.timer.running, true);

        account.rejectAll(new Error("clerk caído"));
        await settle();
        assert.deepEqual(app.unhandled, [], "el rechazo tardío ya lo atendió Promise.race");
        app.advance(FOCUS_MS);
        app.tick();
        await settle();
        assert.equal(app.el("focusDone").textContent, "1");
        assert.deepEqual(app.fetchCalls, []);
      });
    });

    /* ── Etiqueta del botón al saltar de fase ────────────────────────────── */

    await t.test("saltar de fase deja el botón coherente con el estado real del temporizador", async (skip) => {
      const step = stepper(skip);
      const app = await bootApp(skip);
      const el = (id) => app.el(id);
      await waitFor(() => el("engineStatus").textContent === ENGINE_READY, { what: "motor de postura listo" });

      await step("parado: saltar el enfoque arranca el descanso solo y el botón pasa a 'Pausar'", async () => {
        assert.equal(el("btnStart").textContent, "Iniciar");
        assert.equal(app.debug.state.timer.running, false);
        await app.click("btnSkip");
        assert.equal(el("phaseLabel").textContent, "Descanso");
        assert.equal(app.debug.state.timer.running, true);
        assert.equal(el("btnStart").textContent, "Pausar");
      });

      await step("saltar el descanso deja el enfoque parado y el botón en 'Iniciar'", async () => {
        await app.click("btnSkip");
        assert.equal(el("phaseLabel").textContent, "Enfoque");
        assert.equal(app.debug.state.timer.running, false);
        assert.equal(el("btnStart").textContent, "Iniciar");
      });

      await step("en pausa: saltar el enfoque también deja el descanso en marcha con 'Pausar'", async () => {
        await app.click("btnStart");
        await waitFor(() => el("btnCamera").textContent === "Apagar cámara", { what: "cámara encendida" });
        await app.click("btnStart");
        assert.equal(el("btnStart").textContent, "Reanudar");
        await app.click("btnSkip");
        assert.equal(el("phaseLabel").textContent, "Descanso");
        assert.equal(app.debug.state.timer.running, true);
        assert.equal(el("btnStart").textContent, "Pausar");
      });

      await step("el botón coherente funciona: un clic pausa el descanso ('Reanudar')", async () => {
        await app.click("btnStart");
        assert.equal(app.debug.state.timer.running, false);
        assert.equal(el("btnStart").textContent, "Reanudar");
      });
    });

    /* ── Baseline guardado sin validar ───────────────────────────────────── */

    await t.test("baseline guardado: solo se aplica con las 6 métricas numéricas y finitas", async (saved) => {
      const seed = (baseline) => ({ "postava.v1": JSON.stringify({ focus: 25, baseline }) });
      const { shoulderY: _omitted, ...withoutShoulderY } = VALID_BASELINE;
      const invalid = {
        "objeto vacío": {},
        "claves ausentes": { neck: 0.75 },
        "falta shoulderY": withoutShoulderY,
        "valor en texto": { ...VALID_BASELINE, width: "0.533" },
        "valor null (NaN e Infinity se guardan como null)": { ...VALID_BASELINE, tilt: null },
        "array": [],
        "texto": "calibrado",
        "número": 1,
        "true": true,
      };

      await saved.test("válido: se aplica y avisa de la calibración anterior", async (valid) => {
        const app = await bootApp(valid, { storage: seed(VALID_BASELINE) });
        assert.deepEqual(app.debug.state.posture.baseline, VALID_BASELINE);
        assert.equal(app.el("postureMsg").textContent, "Calibración anterior cargada. Si has movido la cámara o la silla, vuelve a calibrar.");
      });

      for (const [name, baseline] of Object.entries(invalid)) {
        await saved.test(`inválido (${name}): se ignora como si no hubiera calibración guardada`, async (bad) => {
          const app = await bootApp(bad, { storage: seed(baseline) });
          assert.equal(app.debug.state.posture.baseline, null);
          assert.doesNotMatch(app.el("postureMsg").textContent, /Calibración anterior/);
          assert.equal(app.el("focusMins").value, "25", "el resto de ajustes guardados se sigue aplicando");
        });
      }

      await saved.test("sin baseline utilizable, Iniciar pide calibrar (igual que sin calibración guardada)", async (start) => {
        const app = await bootApp(start, { storage: seed({ neck: 0.75 }) });
        await waitFor(() => app.el("engineStatus").textContent === ENGINE_READY, { what: "motor de postura listo" });
        await app.click("btnStart");
        await waitFor(() => app.el("postureMsg").textContent.startsWith("Pulsa"), { what: "mensaje de calibrar" });
        assert.equal(app.debug.state.posture.baseline, null);
      });
    });

    /* ── Tecla Espacio con el foco en un botón ───────────────────────────── */

    await t.test("tecla Espacio: con el foco en un botón o enlace no alterna el temporizador (lo hace el propio control)", async (space) => {
      const step = stepper(space);
      const app = await bootApp(space);
      const el = (id) => app.el(id);
      await waitFor(() => el("engineStatus").textContent === ENGINE_READY, { what: "motor de postura listo" });

      for (const tagName of ["BUTTON", "A"]) {
        await step(`Espacio con el foco en ${tagName}: se ignora y no se cancela el evento`, async () => {
          const event = app.key("Space", " ", tagName);
          await settle();
          assert.equal(event.defaultPrevented, false, "el navegador debe poder activar el control");
          assert.equal(app.debug.state.timer.running, false);
          assert.equal(el("btnStart").textContent, "Iniciar");
          assert.equal(app.camera.calls, 0);
        });
      }

      await step("Espacio con el foco en INPUT sigue sin alternar (escribir)", async () => {
        app.key("Space", " ", "INPUT");
        await settle();
        assert.equal(app.debug.state.timer.running, false);
      });

      await step("Espacio con el foco en el documento alterna como siempre: inicia y pausa", async () => {
        const start = app.key("Space", " ");
        assert.equal(start.defaultPrevented, true);
        await waitFor(() => el("btnStart").textContent === "Pausar", { what: "temporizador en marcha" });
        assert.equal(app.debug.state.timer.running, true);
        app.key("Space", " ");
        assert.equal(el("btnStart").textContent, "Reanudar");
        assert.equal(app.debug.state.timer.running, false);
      });

      await step("la tecla C con el foco en un botón sigue calibrando (solo se ignora Espacio)", async () => {
        app.key("KeyC", "c", "BUTTON");
        await waitFor(() => el("stage").dataset.calibrating === "true", { what: "calibración iniciada" });
      });
    });

    /* ── Sin audio: el temporizador no depende de WebAudio ──────────────── */

    await t.test("AudioContext que lanza: Iniciar arranca igual, sin sonido, y el fin del enfoque cambia de fase", async (mute) => {
      const app = await bootApp(mute, { audioFails: true });
      const el = (id) => app.el(id);
      await waitFor(() => el("engineStatus").textContent === ENGINE_READY, { what: "motor de postura listo" });

      await app.click("btnStart");
      await waitFor(() => el("btnStart").textContent === "Pausar", { what: "temporizador en marcha (aunque falle el audio)" });
      assert.equal(app.debug.state.timer.running, true);
      assert.equal(el("timerHint").textContent, "en marcha");

      app.advance(FOCUS_MS);
      assert.doesNotThrow(() => app.tick(), "el sonido de fin de fase no puede romper el cambio de fase");
      assert.equal(el("phaseLabel").textContent, "Descanso");
      assert.equal(el("focusDone").textContent, "1");
      assert.equal(app.audio.oscillators, 0, "sin contexto no hay tonos");
      assert.deepEqual(app.unhandled, []);
    });

    /* ── Atajos de teclado: modificadores, repetición y <summary> ────────── */

    await t.test("atajos de teclado: ignoran Ctrl/Cmd/Alt, la tecla mantenida y el <summary> de Ajustes", async (shortcuts) => {
      const step = stepper(shortcuts);
      const app = await bootApp(shortcuts);
      const el = (id) => app.el(id);
      await waitFor(() => el("engineStatus").textContent === ENGINE_READY, { what: "motor de postura listo" });
      const MODIFIERS = { Ctrl: { ctrlKey: true }, Cmd: { metaKey: true }, Alt: { altKey: true } };

      for (const [name, modifier] of Object.entries(MODIFIERS)) {
        await step(`${name}+C (p. ej. copiar) no lanza la calibración ni pide la cámara`, async () => {
          app.key("KeyC", "c", "BODY", modifier);
          await settle();
          assert.equal(app.camera.calls, 0, "no se pide la cámara");
          assert.equal(app.debug.state.posture.calibrating, false);
          assert.equal(el("calibOverlay").hidden, true);
          assert.equal(el("stage").dataset.calibrating, undefined);
        });

        await step(`${name}+Espacio no alterna el temporizador ni cancela el evento`, async () => {
          const event = app.key("Space", " ", "BODY", modifier);
          await settle();
          assert.equal(event.defaultPrevented, false);
          assert.equal(app.debug.state.timer.running, false);
          assert.equal(el("btnStart").textContent, "Iniciar");
          assert.equal(app.camera.calls, 0);
        });
      }

      await step("C mantenida (repeat): no calibra", async () => {
        app.key("KeyC", "c", "BODY", { repeat: true });
        await settle();
        assert.equal(app.camera.calls, 0);
        assert.equal(app.debug.state.posture.calibrating, false);
      });

      await step("Espacio con el foco en el <summary> de Ajustes lo alterna el propio <summary>: aquí se ignora y no se cancela", async () => {
        const event = app.key("Space", " ", "SUMMARY");
        await settle();
        assert.equal(event.defaultPrevented, false, "el navegador debe poder abrir/cerrar el desplegable");
        assert.equal(app.debug.state.timer.running, false);
        assert.equal(el("btnStart").textContent, "Iniciar");
        assert.equal(app.camera.calls, 0);
      });

      await step("Espacio mantenida (repeat): solo el primer keydown alterna; las repeticiones no pausan ni reanudan", async () => {
        const first = app.key("Space", " ");
        assert.equal(first.defaultPrevented, true);
        await waitFor(() => el("btnStart").textContent === "Pausar", { what: "temporizador en marcha" });
        for (let i = 0; i < 3; i++) app.key("Space", " ", "BODY", { repeat: true });
        await settle();
        assert.equal(app.debug.state.timer.running, true, "las repeticiones no pausan");
        assert.equal(el("btnStart").textContent, "Pausar");
        assert.equal(app.camera.calls, 1, "una sola cámara");
      });

      await step("sin modificadores ni repetición, Espacio y C siguen funcionando como siempre", async () => {
        app.key("Space", " "); // pausa
        assert.equal(el("btnStart").textContent, "Reanudar");
        app.key("KeyC", "c");
        await waitFor(() => el("stage").dataset.calibrating === "true", { what: "calibración iniciada" });
      });
    });

    /* ── Reiniciar / Saltar durante la espera de la cuenta ───────────────── */

    await t.test("Iniciar espera a la cuenta: Reiniciar o Saltar durante esos 2 s cancelan el arranque pendiente", async (pendingStart) => {
      /** Arranque con Clerk sin responder: cada Iniciar queda esperando el plazo de 2 s. */
      const bootSlow = async (sub) => {
        const app = await bootApp(sub, { restore: slowAccount().restore });
        await waitFor(() => app.el("engineStatus").textContent === ENGINE_READY, { what: "motor de postura listo" });
        return app;
      };
      /** Pulsa Iniciar y espera a que startTimer esté esperando la cuenta (plazo de 2 s armado). */
      const pressStartAndWait = async (app) => {
        await app.click("btnStart");
        await waitFor(() => app.timeouts.pending.size === 1, { what: "plazo de 2 s de la cuenta armado" });
      };

      await pendingStart.test("Reiniciar: al vencer el plazo no arranca el reloj ni se pide la cámara; el siguiente Iniciar sí funciona", async (reset) => {
        const app = await bootSlow(reset);
        const el = (id) => app.el(id);
        await pressStartAndWait(app);
        await app.click("btnReset");
        app.advance(2_000);
        await settle();

        const timer = app.debug.state.timer;
        assert.equal(timer.running, false, "el arranque cancelado no pone en marcha el reloj");
        assert.equal(timer.remaining, FOCUS_MS);
        assert.equal(el("btnStart").textContent, "Iniciar");
        assert.equal(el("timerHint").textContent, "listo para empezar");
        assert.equal(startBusy(app), false, "el botón se libera");
        assert.equal(app.camera.calls, 0, "no se pide la cámara");

        // Flujo normal después de cancelar: el siguiente Iniciar espera su plazo y arranca.
        await pressStartAndWait(app);
        app.advance(2_000);
        await waitFor(() => el("btnStart").textContent === "Pausar", { what: "temporizador en marcha" });
        assert.equal(timer.running, true);
        assert.equal(el("timerHint").textContent, "en marcha");
        assert.deepEqual(app.unhandled, []);
      });

      await pendingStart.test("Saltar: el descanso que arranca solo no se re-ancla ni cambia de texto al vencer el plazo", async (skip) => {
        const app = await bootSlow(skip);
        const el = (id) => app.el(id);
        await pressStartAndWait(app);
        await app.click("btnSkip"); // enfoque -> descanso en marcha
        const timer = app.debug.state.timer;
        assert.equal(el("phaseLabel").textContent, "Descanso");
        assert.equal(timer.running, true);
        const endAt = timer.endAt;

        app.advance(2_000);
        await settle();
        assert.equal(timer.endAt, endAt, "el arranque cancelado no vuelve a anclar el fin del descanso");
        assert.equal(el("timerHint").textContent, "descansa y estírate");
        assert.equal(el("btnStart").textContent, "Pausar");
        assert.equal(startBusy(app), false);
        assert.equal(app.camera.calls, 0, "el descanso no pide la cámara");
      });

      await pendingStart.test("Saltar y pausar con Espacio: al vencer el plazo el arranque cancelado no reanuda la pausa", async (paused) => {
        const app = await bootSlow(paused);
        const el = (id) => app.el(id);
        await pressStartAndWait(app);
        await app.click("btnSkip"); // el descanso arranca solo
        app.key("Space", " "); // con el temporizador en marcha, Espacio pausa
        assert.equal(el("btnStart").textContent, "Reanudar");
        assert.equal(app.debug.state.timer.running, false);

        app.advance(2_000);
        await settle();
        assert.equal(app.debug.state.timer.running, false, "la pausa se respeta");
        assert.equal(el("btnStart").textContent, "Reanudar");
        assert.equal(el("timerHint").textContent, "en pausa");
        assert.equal(startBusy(app), false);
        assert.equal(app.camera.calls, 0);
        assert.deepEqual(app.unhandled, []);
      });
    });

    /* ── Aviso cuando la cuenta no responde a tiempo ─────────────────────── */

    await t.test("plazo de la cuenta vencido: se avisa de que el bloque no se guardará, solo en ese caso", async (notice) => {
      /** Pulsa Iniciar y deja que corra el plazo de 2 s (si la cuenta no responde) hasta que el arranque termine. */
      const startAndFinish = async (app, { expire }) => {
        await app.click("btnStart");
        if (expire) {
          await waitFor(() => app.timeouts.pending.size === 1, { what: "plazo de 2 s de la cuenta armado" });
          app.advance(2_000);
        }
        await waitFor(() => app.el("btnStart").textContent === "Pausar", { what: "temporizador en marcha" });
        await settle();
      };

      await notice.test("Clerk sin responder: al vencer el plazo aparece el aviso y el aviso de calibrar no lo pisa", async (slow) => {
        const app = await bootApp(slow, { restore: slowAccount().restore });
        await waitFor(() => app.el("engineStatus").textContent === ENGINE_READY, { what: "motor de postura listo" });
        await app.click("btnStart");
        await waitFor(() => app.timeouts.pending.size === 1, { what: "plazo de 2 s de la cuenta armado" });
        app.advance(1_999);
        await settle();
        assert.notEqual(app.el("postureMsg").textContent, ACCOUNT_TIMEOUT_MESSAGE, "antes del plazo no se avisa");

        app.advance(1);
        await waitFor(() => app.el("btnStart").textContent === "Pausar", { what: "temporizador en marcha" });
        await waitFor(() => app.el("btnCamera").textContent === "Apagar cámara", { what: "cámara encendida" });
        await settle();
        assert.equal(app.debug.state.posture.baseline, null, "sin calibración previa, startTimer pediría calibrar");
        assert.equal(app.el("postureMsg").textContent, ACCOUNT_TIMEOUT_MESSAGE);
        assert.equal(app.debug.state.timer.running, true, "el temporizador arranca igual, como invitado");
        assert.deepEqual(app.fetchCalls, []);
      });

      await notice.test("Clerk sin responder con el motor caído: el aviso de cuenta tampoco lo pisa el de solo temporizador", async (down) => {
        const app = await bootApp(down, { cdn: "down", restore: slowAccount().restore });
        await waitFor(() => app.el("engineStatus").classList.contains("error"), { what: "aviso de fallo del modelo" });
        await app.click("btnStart");
        await waitFor(() => app.timeouts.pending.size === 1, { what: "plazo de 2 s de la cuenta armado" });
        app.advance(2_000);
        await waitFor(() => app.el("btnStart").textContent === "Pausar", { what: "temporizador en marcha" });
        await settle();
        assert.equal(app.el("postureMsg").textContent, ACCOUNT_TIMEOUT_MESSAGE);
      });

      await notice.test("cuenta resuelta a tiempo: sin aviso, y sigue el aviso de calibrar de siempre", async (fast) => {
        const app = await bootApp(fast, { user: { id: "user_fast12345678" }, onFetch: () => ({ ok: true, status: 200 }) });
        await waitFor(() => app.el("engineStatus").textContent === ENGINE_READY, { what: "motor de postura listo" });
        await startAndFinish(app, { expire: false });
        await waitFor(() => app.el("postureMsg").textContent.startsWith("Pulsa"), { what: "mensaje de calibrar" });
        assert.notEqual(app.el("postureMsg").textContent, ACCOUNT_TIMEOUT_MESSAGE);
      });

      await notice.test("invitado sin sesión (restore devuelve null): sin aviso", async (guest) => {
        const app = await bootApp(guest);
        await waitFor(() => app.el("engineStatus").textContent === ENGINE_READY, { what: "motor de postura listo" });
        await startAndFinish(app, { expire: false });
        await waitFor(() => app.el("postureMsg").textContent.startsWith("Pulsa"), { what: "mensaje de calibrar" });
        assert.notEqual(app.el("postureMsg").textContent, ACCOUNT_TIMEOUT_MESSAGE);
      });

      await notice.test("restore rechaza antes del plazo: arranca como invitado y sin aviso", async (rejects) => {
        const app = await bootApp(rejects, { restore: () => Promise.reject(new Error("clerk caído")) });
        await waitFor(() => app.el("engineStatus").textContent === ENGINE_READY, { what: "motor de postura listo" });
        await startAndFinish(app, { expire: false });
        await waitFor(() => app.el("postureMsg").textContent.startsWith("Pulsa"), { what: "mensaje de calibrar" });
        assert.notEqual(app.el("postureMsg").textContent, ACCOUNT_TIMEOUT_MESSAGE);
        assert.deepEqual(app.unhandled, []);
      });
    });
  },
);
