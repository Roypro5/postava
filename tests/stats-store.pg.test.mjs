import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import crypto from "node:crypto";
import { createStatsStore, createStatsPool } from "../server/stats-store.mjs";

/**
 * Test de integración opcional contra PostgreSQL real (tarea T5.4).
 *
 * Cierra la brecha de validación: el CTE de saveSession y las consultas
 * de agregación/retención contra un PostgreSQL 16 real (p. ej. la rama dev de Neon).
 *
 * Se ejecuta ÚNICAMENTE si PG_INTEGRATION=1 está definido en el entorno.
 * En la CI habitual y en `npm test` normal se omite para no depender de red ni BD.
 *
 * Reglas de AGENTS.md:
 * - Regla 7: No crea cuentas reales de Clerk ni envía correos.
 * - Limpieza: Usa un user_id sintético propio y borra todas sus filas en after().
 */

const runIntegration = process.env.PG_INTEGRATION === "1";

if (!runIntegration) {
  test("stats-store contra PostgreSQL real (tests/stats-store.pg.test.mjs)", (t) => {
    t.skip("Test de integración opcional omitido (activar con PG_INTEGRATION=1 y variables PG* configuradas)");
  });
} else {
  describe("stats-store con PostgreSQL real", () => {
    // Identificador estrictamente alfanumérico tras user_ compatible con /^user_[a-zA-Z0-9]{8,128}$/
    const TEST_USER = `user_testinteg${Date.now()}${crypto.randomBytes(4).toString("hex")}`;
    let pool;
    let store;

    /** Devuelve una fecha UTC 'YYYY-MM-DD' de hace N días para caer dentro de la ventana de getStats (30 días). */
    function getRecentUtcDate(daysAgo) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - daysAgo);
      return d.toISOString().slice(0, 10);
    }

    function createSession(overrides = {}) {
      return {
        id: crypto.randomUUID(),
        expectedUserId: TEST_USER,
        type: "focus",
        completed: true,
        durationMinutes: 25,
        startedAt: new Date().toISOString(),
        goodMs: 900_000,
        badMs: 300_000,
        issues: { neck: 2, shoulders: 1, tilt: 0, distance: 1 },
        issuesUnit: "count",
        alerts: 2,
        ...overrides,
      };
    }

    before(async () => {
      pool = createStatsPool();
      store = createStatsStore(pool);
      try {
        // Comprobar conectividad básica y asegurar tabla limpia para TEST_USER
        await pool.query("SELECT 1");
        await store.deleteAll(TEST_USER);
      } catch (err) {
        if (pool) await pool.end().catch(() => {});
        throw err;
      }
    });

    after(async () => {
      if (store) {
        try {
          await store.deleteAll(TEST_USER);
        } catch (err) {
          console.warn("[test] Advertencia: no se pudieron limpiar los datos de prueba:", err?.message || err);
        }
      }
      if (pool) {
        await pool.end();
      }
    });

    test("1. guardar una sesión válida retorna 'inserted' y aparece en getStats", async () => {
      const targetDate = getRecentUtcDate(3);
      const session = createSession({
        startedAt: `${targetDate}T14:00:00.000Z`,
        durationMinutes: 25,
      });

      const result = await store.saveSession(TEST_USER, session);
      assert.equal(result, "inserted");

      const stats = await store.getStats(TEST_USER, 30);
      assert.ok(stats.days.length >= 1);
      const day = stats.days.find((d) => d.date === targetDate);
      assert.ok(day, `el día ${targetDate} debe existir en stats`);
      assert.equal(day.pomodoros, 1);
      assert.equal(day.focusMinutes, 25);
    });

    test("2. reintentar la misma sesión (mismo session_id) es idempotente y retorna 'duplicate'", async () => {
      const targetDate = getRecentUtcDate(3);
      const session = createSession({
        startedAt: `${targetDate}T15:00:00.000Z`,
        durationMinutes: 20,
      });

      const first = await store.saveSession(TEST_USER, session);
      assert.equal(first, "inserted");

      const second = await store.saveSession(TEST_USER, session);
      assert.equal(second, "duplicate");

      // No debe haberse duplicado la fila en la BD
      const stats = await store.getStats(TEST_USER, 30);
      const day = stats.days.find((d) => d.date === targetDate);
      assert.ok(day);
      assert.equal(day.sessions.filter((s) => s.startedAt === session.startedAt).length, 1);
    });

    test("3. límite diario: sesiones en bordes de día UTC (23:59:59 y 00:00:00 UTC) pertenecen a días distintos", async () => {
      const dayA = getRecentUtcDate(2);
      const dayB = getRecentUtcDate(1);

      const sessionEndDay = createSession({
        startedAt: `${dayA}T23:59:59.000Z`,
        durationMinutes: 15,
      });
      const sessionStartNextDay = createSession({
        startedAt: `${dayB}T00:00:00.000Z`,
        durationMinutes: 15,
      });

      const resEnd = await store.saveSession(TEST_USER, sessionEndDay);
      assert.equal(resEnd, "inserted");

      const resStart = await store.saveSession(TEST_USER, sessionStartNextDay);
      assert.equal(resStart, "inserted");

      const stats = await store.getStats(TEST_USER, 30);
      const foundDayA = stats.days.find((d) => d.date === dayA);
      const foundDayB = stats.days.find((d) => d.date === dayB);

      assert.ok(foundDayA, `debe registrar día ${dayA}`);
      assert.ok(foundDayB, `debe registrar día ${dayB}`);
      assert.ok(foundDayA.sessions.some((s) => s.startedAt === `${dayA}T23:59:59.000Z`));
      assert.ok(foundDayB.sessions.some((s) => s.startedAt === `${dayB}T00:00:00.000Z`));
    });

    test("4. límite diario: rebasar 1440 minutos en el mismo día UTC retorna 'limit_minutes'", async () => {
      // 8 sesiones de 180 minutos = 1440 minutos exactamente
      const targetDate = getRecentUtcDate(4);
      for (let i = 0; i < 8; i++) {
        const hour = String(i * 2).padStart(2, "0");
        const session = createSession({
          startedAt: `${targetDate}T${hour}:00:00.000Z`,
          durationMinutes: 180,
          goodMs: 7_000_000,
          badMs: 3_800_000,
        });
        const res = await store.saveSession(TEST_USER, session);
        assert.equal(res, "inserted", `sesión ${i + 1} de 180 min debe insertarse`);
      }

      // La 9ª sesión (1 minuto adicional) excede los 1440 minutos del día.
      // goodMs + badMs cumplen la restricción CHECK de 1 minuto (40_000 <= 60_000).
      const excessSession = createSession({
        startedAt: `${targetDate}T20:00:00.000Z`,
        durationMinutes: 1,
        goodMs: 30_000,
        badMs: 10_000,
      });
      const excessRes = await store.saveSession(TEST_USER, excessSession);
      assert.equal(excessRes, "limit_minutes");
    });

    test("5. deleteAll borra todas las sesiones del usuario y deja getStats vacío", async () => {
      const deletedCount = await store.deleteAll(TEST_USER);
      // Se insertaron exactamente 12 sesiones: 1 en test 1, 1 en test 2, 2 en test 3 y 8 en test 4
      assert.equal(deletedCount, 12, `se debieron borrar exactamente 12 sesiones (fueron ${deletedCount})`);

      const stats = await store.getStats(TEST_USER, 30);
      assert.equal(stats.days.length, 0);
      assert.equal(stats.habitDistribution.length, 0);

      // Un segundo deleteAll es idempotente y retorna 0
      const secondDelete = await store.deleteAll(TEST_USER);
      assert.equal(secondDelete, 0);
    });
  });
}
