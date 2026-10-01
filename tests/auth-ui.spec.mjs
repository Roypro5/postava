import { test, expect } from "@playwright/test";

// playwright.config.mjs fija POSTAVA_MOCK_CLERK=1 solo con las claves ficticias locales
// (sin TEST_BASE_URL, Replit ni CLERK_PUBLISHABLE_KEY propia). En ese caso no hay proveedor
// real al que llegar: se sustituyen /api/auth/config y el bundle del adaptador, sin red a
// Clerk ni cuentas reales. Con un entorno real se comprueba la inicialización de verdad.
const mockClerk = process.env.POSTAVA_MOCK_CLERK === "1";

async function mockClerkProvider(page) {
  await page.route("**/api/auth/config", route => route.fulfill({
    json: { publishableKey: "pk_test_mocked_not_a_real_key", proxyUrl: "" },
  }));
  await page.route("**/assets/auth-adapter.bundle.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `
      export const authError = () => "No se pudo completar la solicitud. Comprueba tu conexión e inténtalo de nuevo.";
      export const loadAuth = async () => {
        const response = await fetch("/api/auth/config", { credentials: "same-origin" });
        if (!response.ok) throw new Error("AUTH_UNAVAILABLE");
        const { publishableKey } = await response.json();
        if (!publishableKey) throw new Error("AUTH_UNAVAILABLE");
        return { restore: async () => null, clerk: { addListener: () => {} }, signOut: async () => {} };
      };
    `,
  }));
}

test(`guest timer and ${mockClerk ? "mocked" : "real"} provider initialization stay available`, async ({ page }) => {
  if (mockClerk) await mockClerkProvider(page);
  await page.goto("/");
  await expect(page.locator(".nav-login")).toHaveText("Iniciar sesión");
  await expect(page.locator(".nav-stats-link")).toBeHidden();
  await page.goto("/login.html");
  await expect(page.locator("#login-submit")).toBeEnabled({ timeout: mockClerk ? 5000 : 30000 });
  await expect(page.locator("#login-status")).toContainText("Pomodoro sin cuenta");
  await page.getByRole("link", { name: "Regístrate", exact: true }).click();
  await expect(page.locator("#login-title")).toHaveText("Crea tu cuenta");
  await expect(page.locator("#login-password")).toHaveAttribute("autocomplete", "new-password");
  await expect(page.locator("#login-password-confirm")).toBeVisible();
  await page.locator("#login-password").fill("Long-test-passphrase");
  await page.locator("#login-password-confirm").fill("Different-passphrase");
  await page.locator("#login-email").fill("new@example.com");
  await page.locator("#login-submit").click();
  await expect(page.locator("#password-confirm-error")).toHaveText("Las contraseñas no coinciden.");
  await page.getByRole("link", { name: "¿Olvidaste tu contraseña?" }).click();
  await expect(page.locator("#login-password")).toBeHidden();
  await expect(page.locator("#login-password-confirm")).toBeHidden();
  await expect(page.locator("#login-submit")).toHaveText("Enviar código");
  await expect(page.locator("#login-email")).toBeVisible();
});

test("guest statistics access redirects to sign in", async ({ page }) => {
  await page.goto("/stats");
  await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fstats|\/sign-in\?redirect=\/stats/);
  await expect(page.locator("#login-form")).toBeVisible();
});

test("provider outage fails explicitly without blocking guest access", async ({ page }) => {
  await page.route("**/api/auth/config", route => route.fulfill({ status: 503, body: "{}" }));
  await page.goto("/login.html");
  await expect(page.locator("#login-status")).toContainText("No se pudo conectar", { timeout: 30000 });
  await expect(page.locator("#login-submit")).toBeDisabled();
  await page.getByRole("link", { name: "Volver al Pomodoro sin iniciar sesión" }).click();
  await expect(page.locator(".nav-login")).toBeVisible();
});

test("no JavaScript cannot leak credentials through a form GET", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/login.html");
  await expect(page.locator("#login-submit")).toBeDisabled();
  await context.close();
});
