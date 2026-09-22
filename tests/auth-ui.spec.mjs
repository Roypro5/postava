import { test, expect } from "@playwright/test";

test("guest timer and real provider initialization stay available", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".nav-login")).toHaveText("Iniciar sesión");
  await expect(page.locator(".nav-stats-link")).toBeHidden();
  await page.goto("/login.html");
  await expect(page.locator("#login-submit")).toBeEnabled({ timeout: 30000 });
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
  await page.goto(process.env.TEST_BASE_URL || `https://${process.env.REPLIT_DEV_DOMAIN}/login.html`);
  await expect(page.locator("#login-submit")).toBeDisabled();
  await context.close();
});