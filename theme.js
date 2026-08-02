/* ─────────────────────────────────────────────────────────────────────────
   Postava · selector de tema
   Solo presentación: no toca nada de la lógica de postura ni del temporizador.
   Guarda la preferencia en su propia clave para no interferir con los ajustes.

   El tema efectivo lo resuelve el script en línea del <head> antes del primer
   pintado; aquí solo se cablean los botones y se escucha el cambio del sistema.
   ───────────────────────────────────────────────────────────────────────── */

const KEY = "postava.theme";
const PREFS = ["light", "auto", "dark"];

const root = document.documentElement;
const media = window.matchMedia("(prefers-color-scheme: dark)");
const buttons = [...document.querySelectorAll("[data-theme-set]")];

const resolve = (pref) =>
  pref === "dark" || (pref === "auto" && media.matches) ? "dark" : "light";

function apply(pref, persist = true) {
  if (!PREFS.includes(pref)) pref = "auto";

  root.dataset.themePref = pref;
  root.dataset.theme = resolve(pref);

  for (const b of buttons) {
    b.setAttribute("aria-pressed", String(b.dataset.themeSet === pref));
  }

  if (persist) {
    try {
      localStorage.setItem(KEY, pref);
    } catch {
      /* modo privado: el tema vale para esta sesión y ya está */
    }
  }
}

let stored = "auto";
try {
  stored = localStorage.getItem(KEY) || "auto";
} catch {
  /* sin almacenamiento: se queda en automático */
}

apply(stored, false);

for (const b of buttons) {
  b.addEventListener("click", () => apply(b.dataset.themeSet));
}

// Si el sistema cambia de tema y estamos en automático, seguirlo en vivo
media.addEventListener("change", () => {
  if (root.dataset.themePref === "auto") apply("auto", false);
});
