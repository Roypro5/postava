import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("stats mock tiene datos suficientes para ambos periodos", async () => {
  const data = JSON.parse(await readFile(new URL("../stats-data.json", import.meta.url)));
  assert.ok(data.days.length >= 7);
  assert.ok(data.days.every((day) => day.sessions.length >= 3));
  assert.ok(data.days.every((day) =>
    ["score", "pomodoros", "focusMinutes", "correctMinutes"].every((key) => typeof day[key] === "number")
  ));
  assert.equal(data.habitDistribution.length, 4);
  assert.ok(data.fatigue.length >= 1);
});