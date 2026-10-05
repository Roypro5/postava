import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createUi } from "../ui.js";

/* DOM falso mínimo: nodos con las propiedades que ui.js escribe */
function node(extra = {}) {
  return {
    textContent: "",
    hidden: false,
    checked: false,
    disabled: false,
    className: "",
    value: "",
    width: 0,
    height: 0,
    dataset: {},
    style: {},
    ...extra,
  };
}

/* Nodo que además recuerda los atributos escritos con setAttribute (aria-*) */
function attrNode(extra = {}) {
  const attrs = {};
  return node({
    attrs,
    setAttribute(name, value) {
      attrs[name] = value;
    },
    ...extra,
  });
}

function fakeDoc({ chips = [], actions = null } = {}) {
  const created = [];
  return {
    title: "",
    created,
    querySelectorAll: (sel) => (sel === ".chip" ? chips : []),
    querySelector: (sel) => (sel === ".card-timer .actions" ? actions : null),
    createElement: (tag) => {
      const n = node({
        tag,
        children: [],
        attrs: {},
        listeners: {},
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
        addEventListener(type, fn) {
          this.listeners[type] = fn;
        },
        replaceChildren() {
          this.children = [];
        },
        append(...items) {
          this.children.push(...items);
        },
        after(sibling) {
          this.placedAfter = sibling;
        },
      });
      created.push(n);
      return n;
    },
  };
}

function fakeEl(overrides = {}) {
  return {
    badge: node(),
    postureMsg: node(),
    phase: node(),
    ring: node({ getTotalLength: () => 100 }),
    time: node(),
    focusMins: node({ value: "25" }),
    tolerance: attrNode(),
    tolValue: node(),
    delaySeconds: attrNode(),
    delayValue: node(),
    notifyToggle: node({ checked: true }),
    notifyStatus: node(),
    goodPct: node(),
    alertCount: node(),
    focusDone: node(),
    alertBanner: node({ hidden: true }),
    alertReason: node(),
    alertLive: node(),
    overlay: node(),
    placeholder: node({ hidden: false }),
    btnCamera: node({ textContent: "Encender cámara" }),
    ...overrides,
  };
}

function setup(elOverrides, docOptions) {
  const el = fakeEl(elOverrides);
  const doc = fakeDoc(docOptions);
  return { el, doc, ui: createUi(el, { doc }) };
}

test("setBadge fija estado, clase y texto para cada estado", () => {
  const { el, ui } = setup();
  for (const [state, text] of [
    ["idle", "Sin monitorizar"],
    ["good", "Postura correcta"],
    ["warn", "Postura mejorable"],
    ["bad", "Corrige la postura"],
  ]) {
    ui.setBadge(state, text);
    assert.equal(el.badge.dataset.state, state);
    assert.equal(el.badge.className, `badge badge-${state}`);
    assert.equal(el.badge.textContent, text);
  }
});

test("setMessage escribe el texto en el mensaje de postura", () => {
  const { el, ui } = setup();
  ui.setMessage("Bien, postura recuperada.");
  assert.equal(el.postureMsg.textContent, "Bien, postura recuperada.");
});

/* Nodo que cuenta cuántas veces se escribe cada propiedad (el DOM real reprocesaría estilos/texto) */
function countingBadge() {
  const writes = { state: 0, className: 0, textContent: 0 };
  const values = { state: "", className: "", textContent: "" };
  const dataset = {};
  Object.defineProperty(dataset, "state", {
    get: () => values.state,
    set: (v) => { writes.state += 1; values.state = v; },
  });
  const badge = { dataset };
  for (const prop of ["className", "textContent"]) {
    Object.defineProperty(badge, prop, {
      get: () => values[prop],
      set: (v) => { writes[prop] += 1; values[prop] = v; },
    });
  }
  return { badge, writes, values };
}

test("setBadge solo escribe en el DOM lo que cambia (el bucle lo llama en cada fotograma)", () => {
  const { badge, writes, values } = countingBadge();
  const { ui } = setup({ badge });

  ui.setBadge("good", "Postura correcta");
  assert.deepEqual(writes, { state: 1, className: 1, textContent: 1 }, "la primera llamada escribe todo");

  for (let i = 0; i < 100; i++) ui.setBadge("good", "Postura correcta");
  assert.deepEqual(writes, { state: 1, className: 1, textContent: 1 }, "100 llamadas idénticas no escriben nada");

  ui.setBadge("good", "Otro texto"); // solo cambia el texto
  assert.deepEqual(writes, { state: 1, className: 1, textContent: 2 });

  ui.setBadge("warn", "Otro texto"); // solo cambia el estado
  assert.deepEqual(writes, { state: 2, className: 2, textContent: 2 });

  ui.setBadge("bad", "Corrige la postura"); // cambian ambos
  assert.deepEqual(writes, { state: 3, className: 3, textContent: 3 });

  // El resultado visible es el de la última llamada
  assert.equal(values.state, "bad");
  assert.equal(values.className, "badge badge-bad");
  assert.equal(values.textContent, "Corrige la postura");

  // Volver a un valor anterior sí se escribe (se compara con lo ÚLTIMO escrito, no con el histórico)
  ui.setBadge("good", "Postura correcta");
  assert.deepEqual(writes, { state: 4, className: 4, textContent: 4 });
  assert.equal(values.className, "badge badge-good");
  assert.equal(values.textContent, "Postura correcta");
});

test("setMessage solo escribe cuando el texto cambia y alternar A/B/A escribe las tres veces", () => {
  let writes = 0;
  let value = "";
  const postureMsg = {};
  Object.defineProperty(postureMsg, "textContent", {
    get: () => value,
    set: (v) => { writes += 1; value = v; },
  });
  const { ui } = setup({ postureMsg });

  ui.setMessage("Cuello hundido");
  for (let i = 0; i < 50; i++) ui.setMessage("Cuello hundido");
  assert.equal(writes, 1);
  assert.equal(value, "Cuello hundido");

  ui.setMessage("Bien, postura recuperada.");
  ui.setMessage("Cuello hundido");
  assert.equal(writes, 3);
  assert.equal(value, "Cuello hundido");

  ui.setMessage(""); // vaciar el mensaje también es un cambio
  assert.equal(writes, 4);
  assert.equal(value, "");
});

test("dos instancias de ui no comparten la memoria de lo último escrito", () => {
  const first = countingBadge();
  const second = countingBadge();
  const a = setup({ badge: first.badge }).ui;
  const b = setup({ badge: second.badge }).ui;
  a.setBadge("good", "Postura correcta");
  b.setBadge("good", "Postura correcta");
  assert.deepEqual(first.writes, { state: 1, className: 1, textContent: 1 });
  assert.deepEqual(second.writes, { state: 1, className: 1, textContent: 1 });
});

test("renderPhase: enfoque/descanso con su color de aro", () => {
  const { el, ui } = setup();
  ui.renderPhase("focus");
  assert.equal(el.phase.textContent, "Enfoque");
  assert.equal(el.ring.style.stroke, "var(--accent)");
  ui.renderPhase("break");
  assert.equal(el.phase.textContent, "Descanso");
  assert.equal(el.ring.style.stroke, "var(--warn)");
});

test("renderTimer: cronómetro mm:ss, offset del aro y título según fase y ejecución", () => {
  const { el, doc, ui } = setup();
  // longitud por defecto del aro (753.98) hasta que initRing() la recalcula
  ui.renderTimer({ remaining: 25 * 60000, total: 25 * 60000, phase: "focus", running: false });
  assert.equal(el.time.textContent, "25:00");
  assert.equal(el.ring.style.strokeDashoffset, "0");
  assert.equal(doc.title, "Postava · Pomodoro con postura");

  ui.renderTimer({ remaining: 12.5 * 60000, total: 25 * 60000, phase: "focus", running: true });
  assert.equal(el.time.textContent, "12:30");
  assert.equal(el.ring.style.strokeDashoffset, String(753.98 * 0.5));
  assert.equal(doc.title, "12:30 · Enfoque · Postava");

  ui.renderTimer({ remaining: 4001, total: 5 * 60000, phase: "break", running: true });
  assert.equal(el.time.textContent, "00:05"); // redondea hacia arriba
  assert.equal(doc.title, "00:05 · Descanso · Postava");
});

test("renderTimer con total 0 no divide por cero (progreso 0)", () => {
  const { el, ui } = setup();
  ui.renderTimer({ remaining: 0, total: 0, phase: "focus", running: false });
  assert.equal(el.time.textContent, "00:00");
  assert.equal(el.ring.style.strokeDashoffset, "0");
});

test("initRing usa la longitud real del SVG y la aplica al dasharray y al progreso", () => {
  const { el, ui } = setup({ ring: node({ getTotalLength: () => 200 }) });
  ui.initRing();
  assert.equal(el.ring.style.strokeDasharray, "200");
  ui.renderTimer({ remaining: 50, total: 100, phase: "focus", running: false });
  assert.equal(el.ring.style.strokeDashoffset, "100");
});

test("initRing conserva la longitud por defecto si el SVG no la sabe medir", () => {
  const { el, ui } = setup({ ring: node() });
  ui.initRing();
  assert.equal(el.ring.style.strokeDasharray, undefined);
  const { el: el2, ui: ui2 } = setup({ ring: node({ getTotalLength: () => 0 }) });
  ui2.initRing();
  assert.equal(el2.ring.style.strokeDasharray, "753.98");
});

test("syncChips marca aria-pressed solo en el chip de la duración actual", () => {
  const chips = ["15", "25", "50"].map((m) => {
    const c = node({ dataset: { minutes: m }, attrs: {} });
    c.setAttribute = (k, v) => {
      c.attrs[k] = v;
    };
    return c;
  });
  const { ui } = setup({ focusMins: node({ value: "25" }) }, { chips });
  ui.syncChips();
  assert.deepEqual(chips.map((c) => c.attrs["aria-pressed"]), ["false", "true", "false"]);
});

test("renderTolerance y renderDelay mantienen los textos y umbrales", () => {
  const { el, ui } = setup();
  for (const [v, text] of [[0.5, "estricta"], [0.89, "estricta"], [0.9, "normal"], [1.3, "normal"], [1.31, "relajada"]]) {
    ui.renderTolerance(v);
    assert.equal(el.tolValue.textContent, text, String(v));
  }
  ui.renderDelay("7");
  assert.equal(el.delayValue.textContent, "7 s");
});

test("los deslizadores anuncian el texto visible con aria-valuetext (no solo «1» o «5»)", () => {
  const { el, ui } = setup();
  for (const [v, text] of [[0.6, "estricta"], [1, "normal"], [1.8, "relajada"]]) {
    ui.renderTolerance(v);
    assert.equal(el.tolerance.attrs["aria-valuetext"], text, String(v));
    assert.equal(el.tolerance.attrs["aria-valuetext"], el.tolValue.textContent, "mismo texto que se ve");
  }
  for (const seconds of ["2", 5, "30"]) {
    ui.renderDelay(seconds);
    assert.equal(el.delaySeconds.attrs["aria-valuetext"], `${seconds} s`);
    assert.equal(el.delaySeconds.attrs["aria-valuetext"], el.delayValue.textContent, "mismo texto que se ve");
  }
});

test("renderNotifyStatus: sin soporte desmarca y deshabilita; con soporte solo pone el texto", () => {
  const { el, ui } = setup();
  ui.renderNotifyStatus({ unsupported: false, text: "Activadas" });
  assert.equal(el.notifyToggle.checked, true);
  assert.equal(el.notifyToggle.disabled, false);
  assert.equal(el.notifyStatus.textContent, "Activadas");
  ui.renderNotifyStatus({ unsupported: true, text: "No disponible" });
  assert.equal(el.notifyToggle.checked, false);
  assert.equal(el.notifyToggle.disabled, true);
  assert.equal(el.notifyStatus.textContent, "No disponible");
});

test("renderStats: porcentaje solo con más de 5 s acumulados", () => {
  const { el, ui } = setup();
  ui.renderStats({ goodMs: 2000, badMs: 3000, alerts: 0, completed: 0 });
  assert.equal(el.goodPct.textContent, "—");
  ui.renderStats({ goodMs: 7500, badMs: 2500, alerts: 3, completed: 2 });
  assert.equal(el.goodPct.textContent, "75 %");
  assert.equal(el.alertCount.textContent, 3);
  assert.equal(el.focusDone.textContent, 2);
});

test("banner de aviso: showAlertBanner muestra el motivo y hideAlertBanner lo oculta", () => {
  const { el, ui } = setup();
  ui.showAlertBanner("Cuello adelantado");
  assert.equal(el.alertReason.textContent, "Cuello adelantado");
  assert.equal(el.alertBanner.hidden, false);
  ui.hideAlertBanner();
  assert.equal(el.alertBanner.hidden, true);
});

/* Propiedad `textContent` observable: cuenta cuántas veces se escribe */
function countedText(node, writes) {
  let value = node.textContent ?? "";
  Object.defineProperty(node, "textContent", {
    get: () => value,
    set: (v) => {
      writes.count += 1;
      value = v;
    },
  });
  return node;
}

test("región live del aviso: el anuncio cambia al mostrar/ocultar el cartel y no se repite", () => {
  const writes = { count: 0 };
  const alertLive = countedText(node(), writes);
  const { el, ui } = setup({ alertLive });

  ui.hideAlertBanner(); // ya está vacía: no escribe
  assert.equal(writes.count, 0);
  assert.equal(alertLive.textContent, "");

  ui.showAlertBanner("Cuello adelantado");
  assert.equal(alertLive.textContent, "Enderézate", "anuncia el título del cartel");
  assert.equal(writes.count, 1);
  assert.equal(el.alertBanner.hidden, false);

  // Avisos repetidos con el cartel ya visible (y hasta con otro motivo): no se vuelve a anunciar
  for (let i = 0; i < 20; i++) ui.showAlertBanner("Cuello adelantado");
  ui.showAlertBanner("Hombros desnivelados");
  assert.equal(writes.count, 1);
  assert.equal(el.alertReason.textContent, "Hombros desnivelados", "el cartel visible sí actualiza el motivo");

  ui.hideAlertBanner();
  assert.equal(alertLive.textContent, "", "al ocultar se vacía (la región sigue en el DOM)");
  assert.equal(writes.count, 2);
  for (let i = 0; i < 100; i++) ui.hideAlertBanner(); // handleNotDetected lo llama en cada fotograma
  assert.equal(writes.count, 2);

  ui.showAlertBanner("Cuello adelantado"); // un aviso nuevo sí se anuncia
  assert.equal(alertLive.textContent, "Enderézate");
  assert.equal(writes.count, 3);
});

/* Blindaje del anuncio por lector de pantalla: #postureMsg y #alertLive son regiones live
   (index.html; la insignia ya no lo es, ver tests/dom-ids.test.mjs), así que cada escritura de
   texto en ellas es un anuncio. La insignia se sigue escribiendo una vez por cambio. Este test simula
   ~35 s de fotogramas a 15 por segundo, con el mismo patrón de llamadas que posture-monitor
   (setBadge + setMessage en cada fotograma, hideAlertBanner mientras no hay aviso), y exige
   una escritura por cambio real, no una por fotograma. */
test("el bucle de fotogramas no reescribe insignia, mensaje ni aviso: una escritura por cambio", () => {
  const badgeWrites = { state: 0, className: 0, textContent: 0 };
  const badgeValues = { state: "", className: "", textContent: "" };
  const dataset = {};
  Object.defineProperty(dataset, "state", {
    get: () => badgeValues.state,
    set: (v) => { badgeWrites.state += 1; badgeValues.state = v; },
  });
  const badge = { dataset };
  for (const prop of ["className", "textContent"]) {
    Object.defineProperty(badge, prop, {
      get: () => badgeValues[prop],
      set: (v) => { badgeWrites[prop] += 1; badgeValues[prop] = v; },
    });
  }
  const msgWrites = { count: 0 };
  const liveWrites = { count: 0 };
  const postureMsg = countedText({}, msgWrites);
  const alertLive = countedText(node(), liveWrites);
  const { ui } = setup({ badge, postureMsg, alertLive });

  const FPS = 15;
  const frames = (seconds, fn) => {
    for (let i = 0; i < seconds * FPS; i++) fn();
  };

  // 1) 10 s bien sentado: mismo estado y mensaje en todos los fotogramas
  frames(10, () => {
    ui.setBadge("good", "Postura correcta");
    ui.setMessage("Calibrado. Te avisaré si te desvías.");
    ui.hideAlertBanner();
  });
  assert.deepEqual(badgeWrites, { state: 1, className: 1, textContent: 1 });
  assert.equal(msgWrites.count, 1);
  assert.equal(liveWrites.count, 0, "sin aviso no se anuncia nada");

  // 2) 5 s de margen con la postura mejorable: cambia el estado y el mensaje una vez
  frames(5, () => {
    ui.setBadge("warn", "Postura mejorable");
    ui.setMessage("Cuello adelantado: lleva la cabeza hacia atrás.");
    ui.hideAlertBanner();
  });
  assert.deepEqual(badgeWrites, { state: 2, className: 2, textContent: 2 });
  assert.equal(msgWrites.count, 2);

  // 3) 10 s con el aviso activo (el monitor repite raiseAlert cada cierto tiempo, aquí en cada fotograma)
  frames(10, () => {
    ui.setBadge("bad", "Corrige la postura");
    ui.showAlertBanner("Cuello adelantado: lleva la cabeza hacia atrás.");
    ui.setMessage("Cuello adelantado: lleva la cabeza hacia atrás."); // mismo texto que en el margen
  });
  assert.deepEqual(badgeWrites, { state: 3, className: 3, textContent: 3 });
  assert.equal(msgWrites.count, 2, "el mensaje del aviso es el del margen: no se reanuncia");
  assert.equal(liveWrites.count, 1, "el aviso se anuncia una sola vez");

  // 4) Recuperación: se oculta el aviso y vuelve a «bien»
  frames(5, () => {
    ui.hideAlertBanner();
    ui.setMessage("Bien, postura recuperada.");
    ui.setBadge("good", "Postura correcta");
  });
  assert.deepEqual(badgeWrites, { state: 4, className: 4, textContent: 4 });
  assert.equal(msgWrites.count, 3);
  assert.equal(liveWrites.count, 2, "ocultar el aviso vacía la región una vez");
  assert.equal(badgeValues.textContent, "Postura correcta");
});

test("renderCameraOn/Off: placeholder, texto del botón y tamaño del overlay", () => {
  const { el, ui } = setup();
  ui.renderCameraOn({ width: 640, height: 480 });
  assert.equal(el.overlay.width, 640);
  assert.equal(el.overlay.height, 480);
  assert.equal(el.placeholder.hidden, true);
  assert.equal(el.btnCamera.textContent, "Apagar cámara");
  ui.renderCameraOff();
  assert.equal(el.placeholder.hidden, false);
  assert.equal(el.btnCamera.textContent, "Encender cámara");
});

test("estado de guardado: se crea bajo demanda tras .actions y refleja saving/error/clear", () => {
  const actions = node({ after() {} });
  let placed;
  actions.after = (n) => {
    placed = n;
  };
  const { doc, ui } = setup({}, { actions });

  ui.clearStatsSaveError(); // sin nodo creado: no lanza ni crea nada
  assert.equal(doc.created.length, 0);

  ui.showStatsSaving("Guardando…");
  const status = doc.created[0];
  assert.equal(status.tag, "p");
  assert.equal(status.className, "stats-save-status");
  assert.equal(status.attrs.role, "status");
  assert.equal(status.textContent, "Guardando…");
  assert.equal(status.hidden, false);
  assert.equal(placed, status);

  let retried = 0;
  ui.showStatsSaveError("No se pudo guardar", () => {
    retried += 1;
  });
  assert.equal(doc.created.filter((n) => n.tag === "p").length, 1, "reutiliza el mismo nodo");
  const [text, space, retry] = status.children;
  assert.equal(text.textContent, "No se pudo guardar");
  assert.equal(space, " ");
  assert.equal(retry.textContent, "Reintentar");
  assert.equal(retry.className, "stats-save-retry");
  assert.equal(status.hidden, false);
  retry.listeners.click();
  assert.equal(retried, 1);

  ui.clearStatsSaveError();
  assert.equal(status.hidden, true);
  assert.deepEqual(status.children, []);
});

test("estado de guardado: el aspecto lo ponen las clases CSS, no estilos en línea", () => {
  const actions = node({ after() {} });
  const { doc, ui } = setup({}, { actions });
  ui.showStatsSaveError("No se pudo guardar", () => {});
  const status = doc.created.find((n) => n.tag === "p");
  const retry = doc.created.find((n) => n.tag === "button");
  assert.deepEqual(status.style, {}, "el aviso no lleva style en línea");
  assert.deepEqual(retry.style, {}, "el botón Reintentar no lleva style en línea");
  assert.equal(retry.type, "button");
});

/* Cuerpo de la regla `selector { ... }` que empieza en su propia línea (sin regex: solo
   busca el texto, así que no depende de escapes) o undefined si no existe. */
function cssRuleBody(css, selector) {
  const needle = `${selector} {`;
  for (let from = css.indexOf(needle); from !== -1; from = css.indexOf(needle, from + 1)) {
    if (from === 0 || css[from - 1] === "\n") return css.slice(from + needle.length, css.indexOf("}", from));
  }
  return undefined;
}

const cssProperties = (body) => body.split(";").map((decl) => decl.split(":")[0].trim()).filter(Boolean);

/* Las reglas de esas clases viven en styles.css y ya no necesitan `!important`
   (existía solo para pisar el estilo en línea que ui.js ponía antes). */
test("styles.css define .stats-save-status y .stats-save-retry sin !important", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const status = cssRuleBody(css, ".stats-save-status");
  const retry = cssRuleBody(css, ".stats-save-retry");
  assert.ok(status, "falta la regla .stats-save-status");
  assert.ok(retry, "falta la regla .stats-save-retry");
  assert.ok(status.includes("color: var(--bad-ink)"), "texto en --bad-ink (AA)");
  assert.deepEqual(cssProperties(status).sort(), ["color", "font-size", "margin"]);
  for (const prop of ["padding", "border", "border-radius", "background", "color", "margin-left", "min-height"]) {
    assert.ok(cssProperties(retry).includes(prop), `.stats-save-retry debe fijar ${prop}`);
  }
  assert.ok(!status.includes("!important") && !retry.includes("!important"), "sin !important");
});

test("estado de guardado: sin onRetry (aviso informativo) no se crea el botón Reintentar", () => {
  const actions = node({ after() {} });
  const { doc, ui } = setup({}, { actions });
  ui.showStatsSaveError("Se alcanzó el límite diario", null);
  assert.equal(doc.created.filter((n) => n.tag === "button").length, 0);
  const status = doc.created.find((n) => n.tag === "p");
  assert.equal(status.children[0].textContent, "Se alcanzó el límite diario");
  assert.equal(status.children.length, 1);
  assert.equal(status.hidden, false);
});
