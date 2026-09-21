import { test, expect } from "@playwright/test";

test("guest timer and real provider initialization stay available", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".nav-login")).toHaveText("Iniciar sesión");
  await page.goto("/login.html");
  await expect(page.locator("#login-submit")).toBeEnabled({ timeout: 30000 });
  await expect(page.locator("#login-status")).toContainText("Pomodoro sin cuenta");
  await page.getByRole("link", { name: "Regístrate", exact: true }).click();
  await expect(page.locator("#login-title")).toHaveText("Crea tu cuenta");
  await expect(page.locator("#login-password")).toHaveAttribute("autocomplete", "new-password");
  await page.getByRole("link", { name: "¿Olvidaste tu contraseña?" }).click();
  await expect(page.locator("#login-password")).toBeHidden();
  await expect(page.locator("#login-submit")).toHaveText("Enviar código");
  await expect(page.locator("#login-email")).toBeVisible();
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