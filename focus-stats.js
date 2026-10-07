// Estado y operaciones de las métricas del bloque de enfoque en curso.
// Sin DOM, sin red: el reloj se inyecta (Date.now por defecto).
//
// El objeto devuelto ES el estado (accountId, startedAt, activeSince,
// elapsedMs, goodMs, badMs, alerts, issues, activeIssueKeys) más sus
// operaciones, de modo que stats-session.js (bindFocusAccount,
// completedFocusPayload) y stats-queue.js lo consumen sin cambios.

const ISSUE_CATEGORIES = {
  neckDrop: "neck", chinDown: "neck", slump: "neck",
  sideLean: "shoulders", shoulderTilt: "tilt", proximity: "distance",
};

const emptyIssues = () => ({ neck: 0, shoulders: 0, tilt: 0, distance: 0 });

export function createFocusStats(now = Date.now) {
  const stats = {
    accountId: null,
    startedAt: null,
    activeSince: null,
    elapsedMs: 0,
    goodMs: 0,
    badMs: 0,
    alerts: 0,
    issues: emptyIssues(),
    activeIssueKeys: new Set(),

    begin() {
      if (!stats.startedAt) stats.startedAt = new Date(now()).toISOString();
      if (!stats.activeSince) stats.activeSince = now();
    },

    // `capMs` (opcional): tope del tiempo total del bloque (duración planificada).
    // Si el equipo se suspende con el bloque en marcha, now() salta al despertar;
    // el tope evita contar ese tiempo dormido como enfoque.
    // `atMs` (opcional): instante de cierre (por defecto, ahora); sirve para cerrar
    // en el último tick fiable tras una suspensión, sin contar el tiempo dormido.
    stop(capMs = Infinity, atMs = now()) {
      if (stats.activeSince) {
        stats.elapsedMs += Math.max(0, atMs - stats.activeSince);
        stats.activeSince = null;
      }
      if (stats.elapsedMs > capMs) stats.elapsedMs = Math.max(0, capMs);
    },

    reset() {
      stats.accountId = null;
      stats.startedAt = null;
      stats.activeSince = null;
      stats.elapsedMs = 0;
      stats.goodMs = 0;
      stats.badMs = 0;
      stats.alerts = 0;
      stats.issues = emptyIssues();
      stats.activeIssueKeys.clear();
    },

    // Frame con mala postura: acumula tiempo y cuenta cada incidencia nueva
    // (las que ya estaban activas en el frame anterior no se recuentan).
    addBad(dt, issueKeys) {
      stats.badMs += dt;
      const current = new Set(issueKeys);
      for (const key of issueKeys) {
        const category = ISSUE_CATEGORIES[key];
        if (category && !stats.activeIssueKeys.has(key)) stats.issues[category] += 1;
      }
      stats.activeIssueKeys = current;
    },

    addGood(dt) {
      stats.goodMs += dt;
      stats.activeIssueKeys.clear();
    },

    clearActiveIssues() {
      stats.activeIssueKeys.clear();
    },

    addAlert() {
      stats.alerts += 1;
    },

    // Copia de datos puros (sin métodos ni Set): lo único que puede viajar
    // al servidor son métricas agregadas, nunca coordenadas.
    snapshot() {
      return {
        accountId: stats.accountId,
        startedAt: stats.startedAt,
        elapsedMs: stats.elapsedMs,
        goodMs: stats.goodMs,
        badMs: stats.badMs,
        alerts: stats.alerts,
        issues: { ...stats.issues },
      };
    },
  };
  return stats;
}
