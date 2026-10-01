import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSessionPayload } from "../server/stats-store.mjs";
import { completedFocusPayload } from "../stats-session.js";

const NOW = Date.parse("2026-01-15T12:00:00Z");
const valid = () => ({
  id: "3f2b8c1e-9d4a-4b6e-8a1f-2c3d4e5f6a7b",
  expectedUserId: "user_abcdefgh1234",
  type: "focus",
  completed: true,
  durationMinutes: 25,
  startedAt: "2026-01-15T11:00:00.000Z",
  goodMs: 600000,
  badMs: 300000,
  issues: { neck: 1, shoulders: 0, tilt: 0, distance: 2 },
  issuesUnit: "count",
  alerts: 3,
});

test("SESSION_KEYS: el payload base es aceptado (control positivo)", () => {
  assert.ok(validateSessionPayload(valid(), NOW));
});

test("SESSION_KEYS: rechaza claves espaciales o de video (privacidad de camara)", () => {
  const forbidden = [
    "landmarks", "landmark", "x", "y", "z", "visibility", "video", "frame", "image",
    "pose", "poseLandmarks", "worldLandmarks", "coordinates", "keypoints", "metrics",
    "neck", "width", "tilt", "side", "chin", "shoulderY", "baseline", "user_id", "userId",
  ];
  for (const key of forbidden) {
    assert.equal(validateSessionPayload({ ...valid(), [key]: [{ x: 0.1, y: 0.2, z: 0.3 }] }, NOW), null, key);
  }
});

test("issues solo admite las claves agregadas conocidas, sin coordenadas", () => {
  for (const key of ["x", "landmarks", "video"]) {
    const body = valid();
    body.issues = { ...body.issues, [key]: 1 };
    assert.equal(validateSessionPayload(body, NOW), null, key);
  }
});

test("la salida validada solo contiene claves agregadas permitidas", () => {
  const out = validateSessionPayload(valid(), NOW);
  assert.deepEqual(Object.keys(out).sort(), [
    "alerts", "badMs", "durationMinutes", "expectedUserId", "goodMs", "id", "issues", "issuesUnit", "startedAt",
  ]);
});

test("completedFocusPayload (cliente) produce solo claves aceptadas por el servidor", () => {
  const p = completedFocusPayload(
    {
      accountId: "user_abcdefgh1234",
      startedAt: "2026-01-15T11:00:00.000Z",
      elapsedMs: 1_500_000,
      goodMs: 600000.4,
      badMs: 300000.6,
      alerts: 3,
      issues: { neck: 1, shoulders: 0, tilt: 0, distance: 2 },
    },
    "3f2b8c1e-9d4a-4b6e-8a1f-2c3d4e5f6a7b",
  );
  assert.ok(validateSessionPayload(p, NOW));
});
