// Contrato entre el código y el HTML: todo id/selector que dom.js, app.js y ui.js
// piden al DOM debe existir en index.html. Sin navegador ni dependencias: el HTML se
// analiza con expresiones regulares sencillas (etiquetas, atributos y anidamiento).
//
// Por qué importa: `document.getElementById` devuelve null si el id no existe y el
// fallo solo se ve al ejecutar en el navegador (TypeError al arrancar app.js), que los
// tests unitarios con DOM falso no detectan.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe, it } from "node:test";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

/* Ids que dom.js podría tolerar ausentes. Hoy NINGUNO: dom.js solo hace referencias
   y app.js/ui.js los dereferencian al arrancar (addEventListener, textContent...),
   así que un id que falte rompe la página. Si un día un elemento pasa a ser opcional
   (p. ej. protegido con `?.`), añádelo aquí: se reportará pero no fallará el test. */
const OPTIONAL_IDS = new Set([]);

/* Selectores de app.js/ui.js protegidos con `if (nodo)`: su ausencia degrada la UI
   (no se muestra el estado de guardado bajo los botones) pero no rompe el arranque.
   El resto de selectores son obligatorios (sin `.chip` mueren los atajos de minutos). */
const OPTIONAL_SELECTORS = new Set([".card-timer .actions"]);

/* Tipo de elemento que espera el código para cada id (getContext, getTotalLength,
   .checked, .value/min/max, .disabled...). */
const EXPECTED_ELEMENTS = {
  overlay: { tag: "canvas" },
  video: { tag: "video" },
  ringProgress: { tag: "circle" },
  btnStart: { tag: "button" },
  btnSkip: { tag: "button" },
  btnReset: { tag: "button" },
  btnCalibrate: { tag: "button" },
  btnCamera: { tag: "button" },
  focusMins: { tag: "input", type: "number" },
  breakMins: { tag: "input", type: "number" },
  tolerance: { tag: "input", type: "range" },
  delaySeconds: { tag: "input", type: "range" },
  soundToggle: { tag: "input", type: "checkbox" },
  skeletonToggle: { tag: "input", type: "checkbox" },
  hudToggle: { tag: "input", type: "checkbox" },
  hideVideoToggle: { tag: "input", type: "checkbox" },
  camOnlyRunning: { tag: "input", type: "checkbox" },
  notifyToggle: { tag: "input", type: "checkbox" },
};

/* ── Extracción del código ─────────────────────────────────────────────── */

/** Quita comentarios (sin tocar `//` dentro de cadenas como "https://..."). */
function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Ids que un fuente pide al DOM: `$("id")`, `getElementById("id")` y `querySelector("#id")`. */
function extractIds(source) {
  const code = stripJsComments(source);
  const ids = new Set();
  const patterns = [
    /(?<![\w.])\$\(\s*(["'`])([\w-]+)\1\s*\)/g,
    /\bgetElementById\(\s*(["'`])([\w-]+)\1\s*\)/g,
    /\bquerySelector(?:All)?\(\s*(["'`])#([\w-]+)\1\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) ids.add(match[2]);
  }
  return ids;
}

/** Selectores literales de `querySelector(All)("...")` en un fuente. */
function extractSelectors(source) {
  const code = stripJsComments(source);
  const selectors = new Set();
  for (const match of code.matchAll(/\bquerySelector(?:All)?\(\s*(["'`])((?:(?!\1).)+)\1\s*\)/g)) {
    selectors.add(match[2]);
  }
  return selectors;
}

/** Nombres `el.<nombre>` que usa un fuente (el objeto de referencias de dom.js). */
function extractElKeys(source) {
  const keys = new Set();
  for (const match of stripJsComments(source).matchAll(/(?<![\w.$])el\.([A-Za-z_]\w*)/g)) keys.add(match[1]);
  return keys;
}

/* ── Análisis mínimo del HTML ──────────────────────────────────────────── */

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const TAG_PATTERN = /<(\/)?([a-zA-Z][\w-]*)((?:\s+[^\s>"'=\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/)?>/g;
const ATTR_PATTERN = /([^\s>"'=\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

/** Lista de elementos { tag, attrs, classes, ancestorClasses } en orden de documento. */
function parseHtml(html) {
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2>)/gi, "$1$3");
  const elements = [];
  const stack = [];
  for (const match of clean.matchAll(TAG_PATTERN)) {
    const [, closing, rawTag, rawAttrs, selfClosing] = match;
    const tag = rawTag.toLowerCase();
    if (closing) {
      const index = stack.findLastIndex((node) => node.tag === tag);
      if (index !== -1) stack.length = index;
      continue;
    }
    const attrs = {};
    for (const attr of rawAttrs.matchAll(ATTR_PATTERN)) attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? "";
    const classes = new Set((attrs.class ?? "").split(/\s+/).filter(Boolean));
    const ancestorClasses = new Set(stack.flatMap((node) => [...node.classes]));
    const node = { tag, attrs, classes, ancestorClasses };
    elements.push(node);
    if (!VOID_TAGS.has(tag) && !selfClosing) stack.push(node);
  }
  return elements;
}

/** Elementos que casan con un selector de clases/ids separados por espacios (`.a .b`, `#x`). */
function matchSelector(elements, selector) {
  const parts = selector.trim().split(/\s+/);
  for (const part of parts) {
    if (!/^[.#][\w-]+$/.test(part)) throw new Error(`selector no soportado por este test: «${selector}»`);
  }
  const last = parts.at(-1);
  const ancestors = parts.slice(0, -1);
  const matches = (node, part) => (part[0] === "." ? node.classes.has(part.slice(1)) : node.attrs.id === part.slice(1));
  return elements.filter(
    (node) =>
      matches(node, last) &&
      ancestors.every((part) => (part[0] === "." ? node.ancestorClasses.has(part.slice(1)) : false)),
  );
}

/* ── Datos ─────────────────────────────────────────────────────────────── */

const domSource = read("dom.js");
const appSource = read("app.js");
const uiSource = read("ui.js");
const elements = parseHtml(read("index.html"));
const htmlIds = elements.filter((node) => node.attrs.id !== undefined).map((node) => node.attrs.id);
const domIds = extractIds(domSource);

/** Ids que dom.js pide al DOM al importarse, medidos de verdad con un `document` que los registra. */
async function recordDomRequests() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const requested = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: {
      getElementById: (id) => {
        requested.push(id);
        return { id, getContext: () => ({}) };
      },
    },
  });
  try {
    const dom = await import(new URL("../dom.js?dom-ids", import.meta.url).href);
    return { requested, keys: Object.entries(dom.el).map(([key, node]) => [key, node.id]) };
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete globalThis.document;
  }
}

/* ── Pruebas ───────────────────────────────────────────────────────────── */

describe("ids del DOM: dom.js contra index.html", () => {
  it("la extracción estática encuentra los ids y coincide con lo que dom.js pide de verdad", async () => {
    const { requested } = await recordDomRequests();
    assert.ok(domIds.size >= 30, `se esperaban decenas de ids en dom.js y se encontraron ${domIds.size}`);
    assert.deepEqual([...domIds].sort(), [...new Set(requested)].sort(), "el regex no debe dejar ids fuera (ni inventarlos)");
    assert.equal(requested.length, new Set(requested).size, "dom.js no pide el mismo id dos veces");
  });

  it("todos los ids de dom.js existen en index.html (los opcionales solo se avisan)", (t) => {
    const present = new Set(htmlIds);
    const missing = [...domIds].filter((id) => !present.has(id));
    const missingOptional = missing.filter((id) => OPTIONAL_IDS.has(id));
    const missingRequired = missing.filter((id) => !OPTIONAL_IDS.has(id));
    for (const id of missingOptional) t.diagnostic(`id opcional ausente en index.html: #${id}`);
    assert.deepEqual(missingRequired, [], `ids obligatorios que faltan en index.html: ${missingRequired.join(", ")}`);
  });

  it("OPTIONAL_IDS no arrastra ids que dom.js ya no usa", () => {
    const stale = [...OPTIONAL_IDS].filter((id) => !domIds.has(id));
    assert.deepEqual(stale, []);
  });

  it("los ids de index.html son únicos", () => {
    const duplicated = htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index);
    assert.deepEqual([...new Set(duplicated)], []);
  });

  it("cada id tiene el tipo de elemento que el código espera", () => {
    const byId = new Map(elements.filter((node) => node.attrs.id).map((node) => [node.attrs.id, node]));
    for (const [id, expected] of Object.entries(EXPECTED_ELEMENTS)) {
      const node = byId.get(id);
      assert.ok(node, `#${id} no existe en index.html`);
      assert.equal(node.tag, expected.tag, `#${id} debe ser <${expected.tag}>`);
      if (expected.type) assert.equal(node.attrs.type, expected.type, `#${id} debe ser type="${expected.type}"`);
    }
    for (const id of Object.keys(EXPECTED_ELEMENTS)) {
      assert.ok(domIds.has(id), `EXPECTED_ELEMENTS habla de #${id}, que dom.js ya no usa: actualiza la tabla`);
    }
  });
});

describe("el.<nombre>: las referencias de dom.js que usa el código", () => {
  it("todo `el.<nombre>` de app.js y ui.js está definido en dom.js", async () => {
    const { keys } = await recordDomRequests();
    const defined = new Set(keys.map(([key]) => key));
    const used = new Set([...extractElKeys(appSource), ...extractElKeys(uiSource)]);
    assert.ok(used.size >= 20, `el regex debería encontrar decenas de usos (${used.size})`);
    const undefinedKeys = [...used].filter((key) => !defined.has(key));
    assert.deepEqual(undefinedKeys, [], `app.js/ui.js usan claves que dom.js no exporta: ${undefinedKeys.join(", ")}`);
  });

  it("toda clave de dom.js se usa en app.js o ui.js (sin referencias muertas)", async () => {
    const { keys } = await recordDomRequests();
    const used = new Set([...extractElKeys(appSource), ...extractElKeys(uiSource)]);
    const unused = keys.map(([key]) => key).filter((key) => !used.has(key));
    assert.deepEqual(unused, [], `claves de dom.js sin uso: ${unused.join(", ")}`);
  });
});

describe("selectores y controles de index.html que el código da por supuestos", () => {
  const selectors = new Set([...extractSelectors(appSource), ...extractSelectors(uiSource)]);

  it("el regex encuentra los selectores conocidos de app.js/ui.js", () => {
    assert.ok(selectors.has(".chip"));
    assert.ok(selectors.has(".card-timer .actions"));
  });

  it("los selectores obligatorios existen en index.html y los opcionales solo se avisan", (t) => {
    for (const selector of selectors) {
      const found = matchSelector(elements, selector).length;
      if (OPTIONAL_SELECTORS.has(selector)) {
        if (!found) t.diagnostic(`selector opcional sin coincidencias: ${selector}`);
      } else {
        assert.ok(found > 0, `«${selector}» no existe en index.html`);
      }
    }
  });

  it("OPTIONAL_SELECTORS no arrastra selectores que el código ya no usa", () => {
    const stale = [...OPTIONAL_SELECTORS].filter((selector) => !selectors.has(selector));
    assert.deepEqual(stale, []);
  });

  it("focusMins y breakMins declaran min y max numéricos (el clamp de app.js los lee)", () => {
    for (const id of ["focusMins", "breakMins"]) {
      const node = elements.find((element) => element.attrs.id === id);
      assert.ok(node, `#${id}`);
      const min = Number(node.attrs.min);
      const max = Number(node.attrs.max);
      assert.ok(node.attrs.min !== undefined && Number.isFinite(min), `#${id} necesita min numérico`);
      assert.ok(node.attrs.max !== undefined && Number.isFinite(max), `#${id} necesita max numérico`);
      assert.ok(min >= 1 && max > min, `#${id}: rango incoherente ${min}..${max}`);
    }
  });

  it("los chips de minutos traen data-minutes dentro del rango de focusMins y uno coincide con el valor por defecto", () => {
    const focus = elements.find((node) => node.attrs.id === "focusMins");
    const min = Number(focus.attrs.min);
    const max = Number(focus.attrs.max);
    const chips = matchSelector(elements, ".chip");
    assert.ok(chips.length >= 1, "no hay chips");
    for (const chip of chips) {
      const minutes = Number(chip.attrs["data-minutes"]);
      assert.ok(Number.isInteger(minutes) && minutes >= min && minutes <= max, `chip con data-minutes inválido: ${chip.attrs["data-minutes"]}`);
    }
    assert.ok(
      chips.some((chip) => chip.attrs["data-minutes"] === focus.attrs.value),
      "ningún chip coincide con el valor inicial de #focusMins (syncChips no marcaría ninguno)",
    );
  });
});

/* Accesibilidad de index.html que depende de cómo escribe ui.js (ver tests/ui.test.mjs):
   las regiones live solo son silenciosas porque ui.js escribe únicamente cuando algo cambia. */
describe("regiones live y deslizadores de index.html", () => {
  const byId = (id) => {
    const node = elements.find((element) => element.attrs.id === id);
    assert.ok(node, `#${id} no existe en index.html`);
    return node;
  };
  const isPoliteStatus = (node) =>
    node.attrs.role === "status" && node.attrs["aria-live"] === "polite" && node.attrs["aria-atomic"] === "true";

  it("#postureMsg es la región live de la postura (cortés y atómica)", () => {
    assert.ok(isPoliteStatus(byId("postureMsg")), '#postureMsg necesita role="status" aria-live="polite" aria-atomic="true"');
  });

  /* La insignia alterna "No te veo" / "Postura correcta" a ritmo de fotograma si la detección parpadea
     (ui.js solo deduplica, no limita la frecuencia): como región live saturaría al lector de pantalla.
     Los cambios importantes (calibrado, aviso, no te veo tras 3 s, cámara caída...) ya llegan por
     #postureMsg y #alertLive; la insignia sigue siendo texto legible al navegar. */
  it("#postureBadge NO es una región live (evita el spam del lector de pantalla)", () => {
    const badge = byId("postureBadge");
    for (const attr of ["role", "aria-live", "aria-atomic"]) {
      assert.equal(badge.attrs[attr], undefined, `#postureBadge no debe llevar ${attr}`);
    }
  });

  it("el aviso se anuncia por una región persistente (#alertLive) y el cartel oculto no es live", () => {
    const live = byId("alertLive");
    assert.ok(isPoliteStatus(live), "#alertLive necesita role=status, aria-live=polite y aria-atomic=true");
    assert.ok(live.classes.has("sr-only"), "#alertLive va visualmente oculta con .sr-only");
    assert.equal(live.attrs.hidden, undefined, "una región live con hidden/display:none no se anuncia de forma fiable");
    assert.notEqual(live.attrs["aria-hidden"], "true");

    const banner = byId("alertBanner");
    assert.equal(banner.attrs.hidden, "", "el cartel arranca oculto (ui.js lo muestra con hidden = false)");
    for (const attr of ["role", "aria-live", "aria-atomic"]) {
      assert.equal(banner.attrs[attr], undefined, `#alertBanner no debe llevar ${attr}: el aviso se leería dos veces`);
    }
  });

  it("los deslizadores traen aria-valuetext inicial igual al texto que ui.js muestra para su valor por defecto", () => {
    const tolerance = byId("tolerance");
    const delay = byId("delaySeconds");
    assert.equal(tolerance.attrs.value, "1");
    assert.equal(tolerance.attrs["aria-valuetext"], "normal"); // renderTolerance(1)
    assert.equal(delay.attrs["aria-valuetext"], `${delay.attrs.value} s`); // renderDelay(5)
    for (const node of [tolerance, delay]) {
      assert.equal(node.attrs["aria-describedby"], undefined, "el valor ya se anuncia por aria-valuetext: sin descripción duplicada");
    }
  });
});

test("el analizador de HTML entiende anidamiento y elementos void (control del propio test)", () => {
  const sample = parseHtml(`
    <!-- <div id="comentado"></div> -->
    <div class="a"><input id="x" value="1"><p class="b"><span id="y"></span></p></div>
    <p class="b" id="z"></p>
    <script>const t = "<div id='dentro-de-script'>";</script>`);
  const ids = sample.map((node) => node.attrs.id).filter(Boolean);
  assert.deepEqual(ids, ["x", "y", "z"]);
  assert.equal(matchSelector(sample, ".a .b").length, 1, "solo el .b anidado en .a");
  assert.equal(matchSelector(sample, ".b").length, 2);
});
