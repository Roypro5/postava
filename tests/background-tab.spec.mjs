import { test, expect } from "@playwright/test";

// Fase 1 de la pestaña en segundo plano: el temporizador late desde un Worker
// (tick-worker.js) y, si no se puede crear, desde setInterval. Sin cuentas reales: el
// adaptador de Clerk se sustituye por uno ficticio y la cámara se rechaza.

async function prepare(page) {
  await page.route("**/assets/auth-adapter.bundle.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `export const loadAuth = async () => ({ restore: async () => null });`,
    }),
  );
  await page.addInitScript(() => {
    window.__cspViolations = [];
    window.__workers = { created: 0, errors: 0 };
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspViolations.push({ directive: e.violatedDirective, blocked: e.blockedURI });
    });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        window.__workers.created++;
        this.addEventListener("error", () => window.__workers.errors++);
      }
    };
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denegado", "NotAllowedError"));
  });
}

const setHidden = (page, hidden) =>
  page.evaluate((isHidden) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (isHidden ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);

async function startAndExpectTitleToAdvance(page) {
  await page.goto("/");
  await expect(page.locator("#timerDisplay")).toHaveText("25:00");
  await page.locator("#btnStart").click();
  await expect(page.locator("#btnStart")).toHaveText("Pausar");
  await setHidden(page, true);
  const first = await page.title();
  await expect.poll(() => page.title(), { timeout: 8000, message: "el título no avanza con la pestaña simulada como oculta" }).not.toBe(first);
  await setHidden(page, false);
  await expect(page.locator("#btnStart")).toHaveText("Pausar"); // sin falso suspend
}

test("el latido usa un Worker sin violaciones de CSP ni errores y el título avanza en segundo plano", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await prepare(page);
  await startAndExpectTitleToAdvance(page);

  const { created, errors } = await page.evaluate(() => window.__workers);
  expect(created, "se creó el Worker de latido").toBe(1);
  expect(errors, "errores del Worker").toBe(0);
  expect(await page.evaluate(() => window.__cspViolations), "violaciones de CSP").toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("con tick-worker.js bloqueado el temporizador sigue avanzando (reserva con setInterval)", async ({ page }) => {
  await prepare(page);
  await page.route("**/tick-worker.js", (route) => route.abort());
  await startAndExpectTitleToAdvance(page);
  await expect.poll(() => page.evaluate(() => window.__workers.errors), { timeout: 5000 }).toBeGreaterThanOrEqual(1);
});
