import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.mjs",
  workers: 1,
  timeout: 45000,
  reporter: "list",
  use: {
    baseURL: process.env.TEST_BASE_URL || `https://${process.env.REPLIT_DEV_DOMAIN}`,
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium", args: ["--no-sandbox"] },
  },
});