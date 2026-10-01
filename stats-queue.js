import { completedFocusPayload, classifyStatsSendError } from "./stats-session.js";

const SAVING_MESSAGE = "Guardando estadísticas…";

export function accountScopedQueueKey(accountId) {
  return `postava.stats.pending.v2:${accountId}`;
}

// Cola de envío de estadísticas por cuenta. Sin DOM ni globals: todas las
// dependencias se inyectan y la UI se emite por `onStatus`.
//   fetch      -> fetch(url, init)
//   storage    -> { getItem, setItem } (localStorage)
//   importAuth -> () => Promise<{ loadAuth }> (import dinámico del adaptador)
//   onStatus   -> ({ type: "saving" | "error" | "clear", message? })
//   randomUUID -> () => string
//   warn       -> console.warn
export function createStatsQueue({ fetch, storage, importAuth, onStatus = () => {}, randomUUID, warn = () => {} }) {
  let statsAdapterPromise = null;
  let statsAccountId = null;
  let statsPending = [];
  let statsPostInFlight = false;

  const showStatsSaveError = (message) => onStatus({ type: "error", message });
  const clearStatsSaveError = () => onStatus({ type: "clear" });

  function persistPendingStats(accountId = statsAccountId, pending = statsPending) {
    if (!accountId) return;
    try {
      storage.setItem(accountScopedQueueKey(accountId), JSON.stringify(pending));
    } catch {
      showStatsSaveError("No se pudo guardar temporalmente el envío fallido. Mantén esta página abierta y reintenta.");
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
        const saved = JSON.parse(storage.getItem(accountScopedQueueKey(user.id)) || "[]");
        statsPending = Array.isArray(saved) ? saved.filter((item) => item && item.expectedUserId === user.id && typeof item.id === "string") : [];
      } catch {
        statsPending = [];
      }
    }
    return user.id;
  }

  async function sendStatsSession(session) {
    const response = await fetch("/api/stats/sessions", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(session),
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
      while (queue.length) {
        if (await resolveStatsAccount() !== drainingAccountId) {
          throw new Error("La cuenta cambió. Inicia sesión con la cuenta original para reintentar.");
        }
        const session = queue[0];
        try {
          await sendStatsSession(session);
        } catch (error) {
          if (classifyStatsSendError(error.status) === "discard") {
            warn(`Descartando sesión de estadísticas no reintentable (${error.status}): ${session.id}`);
            queue.shift();
            persistPendingStats(drainingAccountId, queue);
            continue;
          }
          throw error;
        }
        queue.shift();
        persistPendingStats(drainingAccountId, queue);
      }
      if (statsAccountId === drainingAccountId) clearStatsSaveError();
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
    const accountId = session.expectedUserId;
    try {
      // The completed block belongs to the account bound when focus started,
      // even if another tab changed Clerk's current account in the meantime.
      if (statsAccountId === accountId) {
        statsPending.push(session);
        persistPendingStats();
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
