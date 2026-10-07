import { completedFocusPayload, classifyStatsSendError } from "./stats-session.js";

const SAVING_MESSAGE = "Guardando estadísticas…";
export const DAILY_LIMIT_MESSAGE = "Se alcanzó el límite diario de sesiones guardadas; esta sesión no se guardó.";

export function accountScopedQueueKey(accountId) {
  return `postava.stats.pending.v2:${accountId}`;
}

// Marca de borrado: stats.js escribe aquí Date.now() ANTES del DELETE al
// servidor. Toda sesión en cola con queuedAt <= marca es anterior al borrado y
// se descarta (en cualquier pestaña); lo completado después se guarda normal.
export function accountClearedKey(accountId) {
  return `postava.stats.cleared:${accountId}`;
}

// Cola de envío de estadísticas por cuenta. Sin DOM ni globals: todas las
// dependencias se inyectan y la UI se emite por `onStatus`.
//   fetch      -> fetch(url, init)
//   storage    -> { getItem, setItem } (localStorage)
//   importAuth -> () => Promise<{ loadAuth }> (import dinámico del adaptador)
//   onStatus   -> ({ type: "saving" | "error" | "clear", message?, rejected? })
//                 rejected: true marca un "error" informativo (sesión descartada
//                 por el límite diario), no un fallo reintentable.
//   randomUUID -> () => string
//   warn       -> console.warn
//   now        -> () => number (ms; por defecto Date.now)
export function createStatsQueue({ fetch, storage, importAuth, onStatus = () => {}, randomUUID, warn = () => {}, now = () => Date.now() }) {
  let statsAdapterPromise = null;
  let statsAccountId = null;
  let statsPending = [];
  let statsPostInFlight = false;
  // Ids ya enviados o descartados por ESTA pestaña: se excluyen al fusionar.
  const removed = new Set();

  const showStatsSaveError = (message) => onStatus({ type: "error", message });
  const clearStatsSaveError = () => onStatus({ type: "clear" });

  // La cola vive en memoria Y en storage, y varias pestañas pueden compartir la
  // del mismo usuario. Reglas:
  //  - Nunca se sobrescribe a ciegas: cada escritura lee storage, FUSIONA por id
  //    con la memoria (unión) y escribe el resultado. Reenviar una sesión que otra
  //    pestaña también envía es idempotente en el servidor (200 duplicate).
  //  - Se quitan de la unión las enviadas/descartadas por esta pestaña (removed)
  //    y las anteriores a la marca de borrado (accountClearedKey).
  //  - Una sesión sin queuedAt (cola persistida por una versión anterior) cuenta
  //    como queuedAt = 0: si existe marca de borrado es anterior a ella y se
  //    descarta (el usuario pidió borrarlo todo); sin marca se conserva.
  // Límite conocido: un POST que ya iba en vuelo cuando se borró puede reinsertar
  // esa fila en el servidor.
  function readClearedMark(accountId) {
    try {
      const mark = Number(storage.getItem(accountClearedKey(accountId)));
      return Number.isFinite(mark) && mark > 0 ? mark : 0;
    } catch {
      return 0;
    }
  }

  function readStoredQueue(accountId) {
    try {
      const saved = JSON.parse(storage.getItem(accountScopedQueueKey(accountId)) || "[]");
      return Array.isArray(saved) ? saved.filter((item) => item && typeof item.id === "string" && item.expectedUserId === accountId) : [];
    } catch {
      return [];
    }
  }

  // Fusiona storage con `list` (la cola en memoria, se modifica in situ) y, si
  // `write`, persiste el resultado. Devuelve false si no se pudo escribir.
  function mergeQueue(accountId, list, { write = true } = {}) {
    if (!accountId) return true;
    const mark = readClearedMark(accountId);
    const keep = (item) => !removed.has(item.id) && !(mark > 0 && (item.queuedAt ?? 0) <= mark);
    const merged = new Map();
    for (const item of [...readStoredQueue(accountId), ...list]) {
      if (keep(item) && !merged.has(item.id)) merged.set(item.id, item);
    }
    const result = [...merged.values()];
    list.splice(0, list.length, ...result);
    if (!write) return true;
    try {
      storage.setItem(accountScopedQueueKey(accountId), JSON.stringify(result));
      return true;
    } catch {
      showStatsSaveError("No se pudo guardar temporalmente el envío fallido. Mantén esta página abierta y reintenta.");
      return false;
    }
  }

  // El bundle de autenticación se importa de forma dinámica: si falla o está
  // bloqueado, el temporizador y la postura siguen funcionando en modo anónimo.
  function loadStatsAdapter() {
    if (!statsAdapterPromise) {
      statsAdapterPromise = importAuth().then(
        (mod) => mod.loadAuth(), // un fallo de loadAuth se propaga como antes
        (error) => {
          warn("Bundle de cuenta no disponible; se continúa en modo anónimo.", error);
          return null;
        },
      );
    }
    return statsAdapterPromise;
  }

  async function resolveStatsAccount() {
    const adapter = await loadStatsAdapter();
    if (!adapter) {
      statsAccountId = null;
      statsPending = [];
      return null;
    }
    const user = await adapter.restore();
    if (!user?.id) {
      statsAccountId = null;
      statsPending = [];
      return null;
    }
    if (statsAccountId !== user.id) {
      statsAccountId = user.id;
      try {
        statsPending = readStoredQueue(user.id);
        mergeQueue(user.id, statsPending, { write: false }); // aplica la marca de borrado
      } catch {
        statsPending = [];
      }
    }
    return user.id;
  }

  // queuedAt es solo de la cola local: el servidor rechaza campos desconocidos.
  function wirePayload(session) {
    const { queuedAt: _queuedAt, ...payload } = session;
    return payload;
  }

  async function sendStatsSession(session) {
    const response = await fetch("/api/stats/sessions", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(wirePayload(session)),
    });
    if (!response.ok) {
      const message =
        response.status === 401
          ? "La sesión de tu cuenta ha caducado."
          : response.status === 400
            ? "La sesión guardada no es válida."
            : response.status === 409
              ? "Esta sesión pertenece a otra cuenta."
              : "No se pudo guardar la sesión.";
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
  }

  // Saca `session` de la cola (enviada o descartada) y persiste fusionando.
  function settle(queue, session, accountId) {
    removed.add(session.id);
    mergeQueue(accountId, queue);
  }

  async function retryStatsSaves() {
    if (statsPostInFlight) return;
    statsPostInFlight = true;
    onStatus({ type: "saving", message: SAVING_MESSAGE });
    let drainingAccountId = null;
    try {
      drainingAccountId = await resolveStatsAccount();
      if (!drainingAccountId) {
        showStatsSaveError("Inicia sesión para guardar tus estadísticas privadas.");
        return;
      }
      const queue = statsPending;
      mergeQueue(drainingAccountId, queue, { write: false }); // sesiones de otras pestañas
      let rejectedByLimit = false;
      while (queue.length) {
        if (await resolveStatsAccount() !== drainingAccountId) {
          throw new Error("La cuenta cambió. Inicia sesión con la cuenta original para reintentar.");
        }
        mergeQueue(drainingAccountId, queue, { write: false }); // marca de borrado / otras pestañas
        if (!queue.length) break;
        const session = queue[0];
        try {
          await sendStatsSession(session);
        } catch (error) {
          const kind = classifyStatsSendError(error.status);
          if (kind === "reject") {
            warn(`Sesión de estadísticas rechazada por el límite diario (${error.status}): ${session.id}`);
            rejectedByLimit = true;
            settle(queue, session, drainingAccountId);
            continue;
          }
          if (kind === "discard") {
            warn(`Descartando sesión de estadísticas no reintentable (${error.status}): ${session.id}`);
            settle(queue, session, drainingAccountId);
            continue;
          }
          throw error;
        }
        settle(queue, session, drainingAccountId);
      }
      if (statsAccountId === drainingAccountId) {
        // El aviso del límite diario sobrevive al fin del drenaje (no se limpia).
        if (rejectedByLimit) onStatus({ type: "error", message: DAILY_LIMIT_MESSAGE, rejected: true });
        else clearStatsSaveError();
      }
    } catch (error) {
      showStatsSaveError(`${error.message || "No se pudieron guardar tus estadísticas."} Tus sesiones pendientes se conservarán para reintentar.`);
    } finally {
      statsPostInFlight = false;
      if (statsAccountId && statsAccountId !== drainingAccountId && statsPending.length) retryStatsSaves();
    }
  }

  async function recordCompletedFocus(focusStats) {
    const session = completedFocusPayload(focusStats, randomUUID());
    if (!session) return;
    // Si el reloj retrocedió tras un borrado, queuedAt no puede quedar <= marca (se descartaría).
    session.queuedAt = Math.max(now(), readClearedMark(session.expectedUserId) + 1);
    const accountId = session.expectedUserId;
    try {
      // The completed block belongs to the account bound when focus started,
      // even if another tab changed Clerk's current account in the meantime.
      if (statsAccountId === accountId) {
        statsPending.push(session);
        mergeQueue(accountId, statsPending);
      } else {
        const key = accountScopedQueueKey(accountId);
        const saved = JSON.parse(storage.getItem(key) || "[]");
        if (!Array.isArray(saved)) throw new Error("Cola de sesiones no válida");
        saved.push(session);
        storage.setItem(key, JSON.stringify(saved));
      }
      if (await resolveStatsAccount() === accountId) await retryStatsSaves();
      else showStatsSaveError("Esta sesión pertenece a otra cuenta. Inicia sesión con esa cuenta para enviarla.");
    } catch (error) {
      showStatsSaveError(`${error.message || "No se pudieron guardar tus estadísticas."} Mantén esta página abierta y reintenta.`);
    }
  }

  async function resumePendingStats() {
    try {
      const accountId = await resolveStatsAccount();
      if (accountId && statsPending.length) await retryStatsSaves();
    } catch {
      // La restauración de la cuenta nunca debe bloquear el temporizador.
    }
  }

  return {
    resolveAccount: resolveStatsAccount,
    retry: retryStatsSaves,
    recordCompletedFocus,
    resumePending: resumePendingStats,
    getPending: () => statsPending.slice(),
  };
}
