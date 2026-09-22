import { test, expect } from "@playwright/test";

// UI contract tests use a controlled adapter, NOT a real Clerk account.
// They do not prove email delivery or provider authentication.
test("recovery handles invalid code, password retry and resend cooldown", async ({ page }) => {
  await page.route("**/assets/auth-adapter.bundle.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `
      export const authError = () => "El código no es válido. Revísalo e inténtalo de nuevo.";
      export const loadAuth = async () => ({
        restore: async () => null,
        recover: async () => ({step:"reset-code"}),
        reset: async () => { throw new Error("invalid code"); },
        resend: async () => {},
      });
    `,
  }));
  await page.goto("/login.html#recovery");
  await expect(page.locator("#login-submit")).toBeEnabled();
  await page.locator("#login-submit").click();
  await expect(page.locator("#email-error")).toContainText("válido");
  await page.locator("#login-email").fill("recovery@example.com");
  await page.locator("#login-submit").click();
  await expect(page.locator("#login-code")).toBeVisible();
  await expect(page.locator("#login-password")).toHaveAttribute("autocomplete", "new-password");
  await expect(page.locator("#login-password-confirm")).toBeVisible();
  await page.locator("#login-code").fill("123456");
  await page.locator("#login-password").fill("Test-passphrase-only");
  await page.locator("#login-password-confirm").fill("Test-passphrase-only");
  await page.locator("#login-submit").click();
  await expect(page.locator("#login-status")).toContainText("código no es válido");
  await expect(page.locator("#login-password")).toHaveValue("");
  await expect(page.locator("#login-password-confirm")).toHaveValue("");
  await expect(page.locator("#login-submit")).toBeEnabled();
  await page.locator("#resend-code").click();
  await expect(page.locator("#login-status")).toContainText("nuevo código");
  await page.locator("#resend-code").click();
  await expect(page.locator("#login-status")).toContainText("Espera un minuto");
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(storage).not.toContain("Test-passphrase-only");
  expect(storage).not.toContain("123456");
});