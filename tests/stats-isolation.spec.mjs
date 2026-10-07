import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";

// Browser contract test: auth and the stats API are controlled here. This does
// NOT establish isolation with two real Clerk sessions or the live database.
test("a failed focus upload remains with its original account after switching", async ({ page }) => {
  const rows = new Map([["user-test-a", []], ["user-test-b", []]]);
  const posts = [];
  const requests = [];
  const reads = [];
  let failNextPost = false;
  const statsHtml = await readFile(new URL("../stats.html", import.meta.url), "utf8");

  await page.addInitScript(() => {
    if (!localStorage.getItem("test-account")) localStorage.setItem("test-account", "user-test-a");
  });
  await page.route("**/assets/auth-adapter.bundle.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `
      export const loadAuth = async () => ({
        restore: async () => {
          const id = localStorage.getItem("test-account");
          return id ? { id, primaryEmailAddress: { emailAddress: id + "@example.com" } } : null;
        },
        clerk: { addListener: () => {} },
        signOut: async () => {},
      });
    `,
  }));
  await page.route("**/cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14", (route) => route.fulfill({
    contentType: "application/javascript",
    body: "export const FilesetResolver = { forVisionTasks: async () => ({}) }; export const PoseLandmarker = { createFromOptions: async () => ({}) };",
  }));
  await page.route("**/stats", (route) => route.fulfill({ contentType: "text/html", body: statsHtml }));
  await page.route("**/api/stats**", async (route) => {
    const request = route.request();
    const user = await page.evaluate(() => localStorage.getItem("test-account"));
    requests.push({ method: request.method(), url: request.url(), body: request.postData() });
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      posts.push({ user, body });
      if (failNextPost) {
        failNextPost = false;
        return route.abort("failed");
      }
      if (body.expectedUserId !== user) {
        return route.fulfill({ status: 409, json: { error: "ACCOUNT_CHANGED" } });
      }
      if (!rows.get(user).some((row) => row.id === body.id)) rows.get(user).push(body);
      return route.fulfill({ json: { saved: true } });
    }
    const sessions = rows.get(user).map((row) => ({
      startedAt: new Date(row.startedAt).toISOString(),
      minutes: row.durationMinutes,
      score: null,
      goodMs: 0,
      badMs: 0,
    }));
    reads.push({ user, sessions: sessions.length });
    return route.fulfill({ json: {
      days: sessions.length ? [{
        date: new Date().toISOString().slice(0, 10),
        label: "Hoy",
        pomodoros: sessions.length,
        focusMinutes: sessions.reduce((sum, row) => sum + row.minutes, 0),
        correctMinutes: 0,
        measuredMinutes: 0,
        score: null,
        sessions,
      }] : [],
      habitDistribution: [],
    } });
  });

  await page.clock.install();
  await page.goto("/");
  await page.locator("#focusMins").fill("1");
  await page.locator("#focusMins").dispatchEvent("change");
  await page.locator("#btnStart").click();
  await expect(page.locator("#timerHint")).toHaveText("en marcha");
  await page.clock.fastForward(61_000);
  await expect.poll(() => posts.length).toBe(1);
  expect(rows.get("user-test-a")).toHaveLength(1);
  await page.goto("/stats");
  await expect(page.locator("#pomodoros")).toHaveText("1");
  await expect(page.locator("#sessionsList .session-row")).toHaveCount(1);
  expect(reads.at(-1)).toEqual({ user: "user-test-a", sessions: 1 });

  await page.goto("/");
  await page.locator("#focusMins").fill("1");
  await page.locator("#focusMins").dispatchEvent("change");
  failNextPost = true;
  await page.locator("#btnStart").click();
  await expect(page.locator("#timerHint")).toHaveText("en marcha");
  await page.clock.fastForward(61_000);
  await expect(page.locator(".stats-save-retry")).toBeVisible();
  const pendingKey = "postava.stats.pending.v2:user-test-a";
  expect(JSON.parse(await page.evaluate((key) => localStorage.getItem(key), pendingKey))).toHaveLength(1);
  const sentBeforeSwitch = posts.length;

  await page.evaluate(() => localStorage.setItem("test-account", "user-test-b"));
  await page.reload();
  await expect(page.locator(".nav-stats-link")).toBeVisible();
  expect(posts).toHaveLength(sentBeforeSwitch);
  expect(rows.get("user-test-b")).toHaveLength(0);
  await page.goto("/stats");
  await expect(page.locator("#pomodoros")).toHaveText("0");
  await expect(page.locator("#sessionsList .session-row")).toHaveCount(0);
  expect(reads.at(-1)).toEqual({ user: "user-test-b", sessions: 0 });
  expect(posts).toHaveLength(sentBeforeSwitch);

  await page.evaluate(() => localStorage.setItem("test-account", "user-test-a"));
  await page.goto("/");
  await expect.poll(() => rows.get("user-test-a").length).toBe(2);
  expect(JSON.parse(await page.evaluate((key) => localStorage.getItem(key), pendingKey))).toHaveLength(0);
  await page.goto("/stats");
  await expect(page.locator("#pomodoros")).toHaveText("2");
  await expect(page.locator("#sessionsList .session-row")).toHaveCount(2);
  expect(reads.at(-1)).toEqual({ user: "user-test-a", sessions: 2 });
  expect(posts.every(({ user, body }) => user === body.expectedUserId)).toBe(true);
  expect(requests.every(({ body, url }) => {
    const serialized = `${url} ${body || ""}`.toLowerCase();
    return !/landmark|video|frame|data:image/.test(serialized);
  })).toBe(true);
  expect(posts.map(({ body }) => body.id)).toEqual([posts[0].body.id, posts[1].body.id, posts[1].body.id]);
});