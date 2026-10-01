/* Resuelve el tema antes del primer pintado para que la página no parpadee.
   Va como <script src="/theme-init.js"> síncrono en el <head> (sin defer, async
   ni type="module") y no en línea: la CSP de producción no permite scripts en
   línea. La preferencia guardada puede ser "light", "dark" o "auto". El
   selector de tema (theme.js) se encarga después de los botones y de escuchar
   el cambio del sistema. */
(() => {
  let pref = "auto";
  try { pref = localStorage.getItem("postava.theme") || "auto"; } catch {}
  const dark = pref === "dark" ||
    (pref === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themePref = pref;
})();
