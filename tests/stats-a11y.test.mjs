// Accesibilidad del dashboard de estadísticas: stats.js + stats.html + stats.css.
//
// stats.js no se puede importar tal cual en Node: ejecuta DOM y red al cargarse y pide
// "/assets/auth-adapter.bundle.js" (una URL absoluta que solo existe en el servidor).
// Aquí se carga de verdad con un DOM falso mínimo y dos ganchos de resolución que
// sustituyen ese adaptador por un stub y "/stats-math.js" por el archivo real. Sin
// red, sin navegador, sin cuentas reales (regla 7 de CLAUDE.md).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test, { after, describe, it } from "node:test";

const root = (name) => new URL(`../${name}`, import.meta.url);
const read = (name) => readFileSync(root(name), "utf8");

/* ── Carga de stats.js sin red ─────────────────────────────────────────── */

const AUTH_STUB = `data:text/javascript,${encodeURIComponent(`
  export const loadAuth = async () => ({
    restore: async () => ({ id: "user-test", primaryEmailAddress: { emailAddress: "test@example.com" } }),
    clerk: { addListener() {} },
    signOut: async () => {},
  });
`)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "/assets/auth-adapter.bundle.js") return { url: AUTH_STUB, format: "module", shortCircuit: true };
    if (specifier === "/stats-queue.js") return { url: root("stats-queue.js").href, format: "module", shortCircuit: true };
    if (specifier === "/stats-math.js") return { url: root("stats-math.js").href, format: "module", shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

/* ── DOM falso: solo lo que stats.js usa ───────────────────────────────── */

class FakeText {
  constructor(data) {
    this.data = data;
  }
  get textContent() {
    return this.data;
  }
}

class FakeElement {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.listeners = {};
    this.classes = new Set();
    this.hidden = false;
    this.disabled = false;
    this.title = "";
    this.own = "";
    this.style = {
      setProperty(name, value) {
        this[name] = value;
      },
    };
  }
  get className() {
    return [...this.classes].join(" ");
  }
  set className(value) {
    this.classes = new Set(String(value).split(" ").filter(Boolean));
  }
  get classList() {
    return {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
      toggle: (name, force) => {
        const on = force ?? !this.classes.has(name);
        if (on) this.classes.add(name);
        else this.classes.delete(name);
        return on;
      },
    };
  }
  get textContent() {
    return this.children.length ? this.children.map((child) => child.textContent).join("") : this.own;
  }
  set textContent(value) {
    this.children = [];
    this.own = String(value);
  }
  append(...items) {
    for (const item of items) this.children.push(typeof item === "string" ? new FakeText(item) : item);
  }
  replaceChildren(...items) {
    this.children = [];
    this.own = "";
    this.append(...items);
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  getAttribute(name) {
    return this.attrs[name] ?? null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type, extra = {}) {
    for (const fn of this.listeners[type] ?? []) fn({ type, target: this, ...extra });
  }
}

function createDom() {
  const byId = new Map();
  const period = (days, active) => {
    const button = new FakeElement("button");
    button.className = active ? "period active" : "period";
    button.dataset.period = String(days);
    button.setAttribute("aria-pressed", String(active)); // lo que declara stats.html
    return button;
  };
  const periods = [period(7, true), period(30, false)];
  const tips = [new FakeElement("span"), new FakeElement("span")];
  for (const tip of tips) tip.className = "info";
  const documentListeners = {};
  const doc = {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new FakeElement("div"));
      return byId.get(id);
    },
    querySelectorAll(selector) {
      if (selector === ".period") return periods;
      if (selector === ".info[data-tip]") return tips;
      return [];
    },
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => new FakeText(text),
    addEventListener(type, fn) {
      (documentListeners[type] ??= []).push(fn);
    },
  };
  return {
    doc,
    periods,
    tips,
    el: (id) => doc.getElementById(id),
    pressKey: (key) => (documentListeners.keydown ?? []).forEach((fn) => fn({ type: "keydown", key })),
  };
}

const originals = new Map();
function setGlobal(name, value) {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, enumerable: true, writable: true, value });
}
after(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

async function until(predicate, what) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`no se cumplió a tiempo: ${what}`);
}

let loads = 0;
/** Carga una instancia nueva de stats.js contra un DOM falso y espera al primer render. */
async function openStats(days) {
  const dom = createDom();
  const fetches = [];
  setGlobal("document", dom.doc);
  setGlobal("location", { replace() {} });
  setGlobal("fetch", async (url) => {
    fetches.push(String(url));
    return { ok: true, status: 200, json: async () => ({ days, habitDistribution: [] }) };
  });
  await import(`${root("stats.js").href}?a11y=${++loads}`);
  await until(() => dom.el("scoreNote").textContent !== "", "el primer render de stats.js");
  return { ...dom, fetches, rendered: () => fetches.length };
}

/* ── Datos ─────────────────────────────────────────────────────────────── */

const DAYS = [
  {
    date: "2026-09-27", label: "dom 27", focusMinutes: 50, correctMinutes: 40, measuredMinutes: 45, pomodoros: 2, score: 89,
    sessions: [
      { startedAt: "2026-09-27T08:00:00.000Z", minutes: 25, score: 92 },
      { startedAt: "2026-09-27T09:00:00.000Z", minutes: 25, score: null },
    ],
  },
  { date: "2026-09-28", label: "lun 28", focusMinutes: 1, correctMinutes: 0, measuredMinutes: 0, pomodoros: 1, score: null, sessions: [] },
  {
    date: "2026-09-29", label: "mar 29", focusMinutes: 25, correctMinutes: 10, measuredMinutes: 20, pomodoros: 1, score: 70,
    sessions: [{ startedAt: "2026-09-29T10:00:00.000Z", minutes: 25, score: 70 }],
  },
];

const texts = (list) => list.children.map((item) => item.textContent);

/* ── Pruebas ───────────────────────────────────────────────────────────── */

describe("botones de periodo (aria-pressed)", () => {
  it("stats.html declara el estado inicial: 7 días pulsado, Mensual no", () => {
    const html = read("stats.html");
    assert.ok(html.includes('class="period active" data-period="7" aria-pressed="true"'));
    assert.ok(html.includes('class="period" data-period="30" aria-pressed="false"'));
  });

  it("al cambiar de periodo, aria-pressed y la clase .active se mueven juntos y se recarga con ese periodo", async () => {
    const { periods, fetches, el } = await openStats(DAYS);
    const [week, month] = periods;
    assert.match(fetches[0], /days=7$/);

    month.emit("click");
    assert.equal(month.attrs["aria-pressed"], "true");
    assert.equal(week.attrs["aria-pressed"], "false");
    assert.ok(month.classes.has("active") && !week.classes.has("active"));
    await until(() => fetches.length === 2, "la recarga a 30 días");
    assert.match(fetches[1], /days=30$/);

    week.emit("click");
    assert.equal(week.attrs["aria-pressed"], "true");
    assert.equal(month.attrs["aria-pressed"], "false");
    assert.ok(week.classes.has("active") && !month.classes.has("active"));
    await until(() => fetches.length === 3, "la recarga a 7 días");
    assert.match(fetches[2], /days=7$/);
    assert.equal(el("sessionCount").textContent, "4"); // el render sigue funcionando tras cambiar de periodo
  });
});

describe("resumen accesible de las gráficas", () => {
  it("stats.html trae las listas .sr-only ocultas junto a cada gráfica, fuera del role=img", () => {
    const html = read("stats.html");
    for (const [id, chartId] of [["durationHistogramSummary", "durationHistogram"], ["dailyBarsSummary", "dailyBars"]]) {
      const at = html.indexOf(`id="${id}"`);
      assert.ok(at > 0, `falta #${id}`);
      const tag = html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
      assert.ok(tag.startsWith("<ul "), `#${id} es una lista`);
      assert.ok(tag.includes('class="sr-only"') && tag.includes(" hidden") && tag.includes("aria-label="), tag);
      // Va DESPUÉS de la gráfica y no dentro de ella: el contenido de un role="img" es presentacional y no se lee
      const chart = html.indexOf(`id="${chartId}"`);
      const chartEnd = html.indexOf("</div>", chart);
      assert.ok(chart > 0 && chartEnd < at, `#${id} debe ir tras el cierre de #${chartId}`);
    }
  });

  it("vuelca los mismos valores que pintan las barras (Posture Score y minutos por día)", async () => {
    const { el } = await openStats(DAYS);

    const scores = el("dailyBarsSummary");
    assert.equal(scores.hidden, false);
    assert.deepEqual(texts(scores), ["dom 27: Posture Score 89", "lun 28: sin puntuación", "mar 29: Posture Score 70"]);
    const bars = el("dailyBars").children.map((column) => column.children[1]);
    assert.equal(bars.length, scores.children.length, "una entrada por barra");
    for (const [index, bar] of bars.entries()) {
      if (DAYS[index].score !== null) assert.equal(scores.children[index].textContent, bar.title, "mismo texto que el tooltip de la barra");
    }

    const minutes = el("durationHistogramSummary");
    assert.equal(minutes.hidden, false);
    assert.deepEqual(texts(minutes), ["dom 27: 50 minutos", "lun 28: 1 minuto", "mar 29: 25 minutos"]);
    assert.equal(el("durationHistogram").children.length, minutes.children.length, "una entrada por barra");
    assert.equal(el("durationHistogram").children[0].title, minutes.children[0].textContent);
  });

  it("no cambia la gráfica: las barras conservan su estructura y su tooltip", async () => {
    const { el } = await openStats(DAYS);
    const column = el("dailyBars").children[0];
    assert.equal(column.className, "daily-column");
    assert.deepEqual(column.children.map((child) => child.tag), ["strong", "i", "span"]);
    assert.equal(column.children[2].textContent, "dom");
    assert.equal(el("durationHistogram").children[0].className, "histogram-bar");
  });

  it("sin días se oculta la lista en lugar de anunciar una lista vacía", async () => {
    const { el } = await openStats([]);
    for (const id of ["dailyBarsSummary", "durationHistogramSummary"]) {
      assert.equal(el(id).hidden, true, id);
      assert.deepEqual(el(id).children, []);
    }
    assert.equal(el("dailyBars").children[0].textContent, "Sin actividad", "la gráfica sigue mostrando su vacío");
  });
});

describe("sesiones recientes como lista", () => {
  it("#sessionsList es un <ul role=list> y cada sesión, un <li> (los estilos siguen en .session-row)", async () => {
    const html = read("stats.html");
    const at = html.indexOf('id="sessionsList"');
    const tag = html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
    assert.ok(tag.startsWith("<ul ") && tag.includes('role="list"') && tag.includes('class="sessions-list"'), tag);
    assert.ok(html.indexOf("</ul>", at) < html.indexOf("</div>", at), "se cierra como </ul>");

    const { el } = await openStats(DAYS);
    const rows = el("sessionsList").children;
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.tag, "li");
      assert.ok(row.classes.has("session-row"));
    }
    assert.equal(rows[0].children.at(-1).textContent, "70", "la más reciente primero");
  });

  it("el estado vacío también es un <li> (un <p> dentro de un <ul> no es válido)", async () => {
    const { el } = await openStats([{ ...DAYS[1] }]);
    const [only] = el("sessionsList").children;
    assert.equal(el("sessionsList").children.length, 1);
    assert.equal(only.tag, "li");
    assert.equal(only.classes.has("stats-empty"), true);
    assert.equal(only.textContent, "Tus sesiones completadas aparecerán aquí.");
  });

  it("stats.css quita viñetas y sangría de la lista", () => {
    const css = read("stats.css");
    const at = css.indexOf(".sessions-list {");
    assert.ok(at >= 0);
    const rule = css.slice(at, css.indexOf("}", at));
    for (const declaration of ["margin:0", "padding:0", "list-style:none", "display:grid"]) {
      assert.ok(rule.includes(declaration), `.sessions-list debe llevar ${declaration}`);
    }
  });
});

describe("tooltips .info (WCAG 1.4.13)", () => {
  it("Esc descarta el aviso enfocado o con el puntero encima, y vuelve al salir el foco y el puntero", async () => {
    const { tips, pressKey } = await openStats(DAYS);
    const [first, second] = tips;

    pressKey("Escape"); // sin ningún aviso abierto: no hace nada
    assert.ok(!first.classes.has("tip-dismissed") && !second.classes.has("tip-dismissed"));

    first.emit("focus");
    pressKey("a"); // otras teclas no lo descartan
    assert.ok(!first.classes.has("tip-dismissed"));
    pressKey("Escape");
    assert.ok(first.classes.has("tip-dismissed"), "Esc descarta el aviso con foco");
    assert.ok(!second.classes.has("tip-dismissed"), "solo el que estaba abierto");
    first.emit("blur");
    assert.ok(!first.classes.has("tip-dismissed"), "al salir el foco vuelve a poder mostrarse");

    second.emit("mouseenter");
    pressKey("Escape");
    assert.ok(second.classes.has("tip-dismissed"), "Esc descarta el aviso con el puntero encima");
    second.emit("mouseleave");
    assert.ok(!second.classes.has("tip-dismissed"));
  });

  it("con foco y puntero a la vez, sigue descartado hasta que se van los dos", async () => {
    const { tips, pressKey } = await openStats(DAYS);
    const [tip] = tips;
    tip.emit("focus");
    tip.emit("mouseenter");
    pressKey("Escape");
    tip.emit("mouseleave"); // el foco sigue: el aviso no debe reaparecer
    assert.ok(tip.classes.has("tip-dismissed"));
    tip.emit("blur");
    assert.ok(!tip.classes.has("tip-dismissed"));
  });

  it("stats.css deja el puntero sobre el aviso visible y no sobre el oculto, y respeta el descarte", () => {
    const css = read("stats.css");
    // Oculto: no captura el puntero (no bloquea clics debajo)
    const base = css.slice(css.indexOf(".info[data-tip]::after {"));
    assert.ok(base.slice(0, base.indexOf("}")).includes("pointer-events:none"));
    // Visible: hover/foco sobre .info y NO descartado; el aviso recibe el puntero
    const shown = ".info[data-tip]:not(.tip-dismissed):hover::after,.info[data-tip]:not(.tip-dismissed):focus::after {";
    const at = css.indexOf(shown);
    assert.ok(at >= 0, "regla de visibilidad con :not(.tip-dismissed)");
    const rule = css.slice(at, css.indexOf("}", at));
    assert.ok(rule.includes("opacity:1") && rule.includes("pointer-events:auto"));
    // El hueco entre el icono y el aviso lo cubre ::before (inset -13 px > 9 px)
    assert.ok(css.includes(".info[data-tip]::before { content:\"\"; position:absolute; inset:-13px;"));
    assert.ok(css.includes("bottom:calc(100% + 9px)"));
  });
});

test("stats.html: sección Privacidad con <dialog> nativo, Cancelar con foco inicial y sin handlers ni estilos en línea", () => {
  const html = read("stats.html");
  const dialog = html.slice(html.indexOf("<dialog"), html.indexOf("</dialog>"));
  assert.match(dialog, /id="deleteStatsDialog"[^>]*aria-labelledby=/);
  assert.match(dialog, /id="deleteStatsCancel"[^>]*autofocus/);
  assert.ok(dialog.includes("No se puede deshacer; el Pomodoro sigue funcionando sin cambios"));
  assert.ok(html.includes("Borrar todas mis estadísticas"));
  assert.doesNotMatch(html, /\son[a-z]+=|\sstyle=/);
});
