/* Render puro de la interfaz principal: solo escribe en los elementos de `el`
   (dom.js) y, para lo que no cuelga de `el`, en el `doc` inyectado.
   Sin dependencias: no conoce timer, cámara, postura, stats ni red. La lógica
   que decide QUÉ mostrar se queda en app.js; aquí solo se pinta. */

const DEFAULT_RING_LEN = 753.98; // 2πr con r = 120; initRing() lo recalcula del SVG
const ALERT_TITLE = "Enderézate"; // el mismo título que muestra el cartel (index.html)

export function createUi(el, { doc = globalThis.document } = {}) {
  let ringLen = DEFAULT_RING_LEN;
  let statsStatus;

  /* setBadge/setMessage se llaman en cada fotograma inferido (~15 veces por
     segundo) casi siempre con el mismo valor: se recuerda lo último escrito y solo
     se toca el DOM cuando cambia (sin cadenas nuevas ni invalidaciones de estilo).
     Este módulo es el único que escribe en estos nodos, así que la copia no puede
     quedar desfasada. */
  let lastBadgeState;
  let lastBadgeText;
  let lastMessage;

  function setBadge(state, text) {
    if (state !== lastBadgeState) {
      lastBadgeState = state;
      el.badge.dataset.state = state;
      el.badge.className = `badge badge-${state}`;
    }
    if (text !== lastBadgeText) {
      lastBadgeText = text;
      el.badge.textContent = text;
    }
  }

  function setMessage(text) {
    if (text === lastMessage) return;
    lastMessage = text;
    el.postureMsg.textContent = text;
  }

  /* Longitud real del trazo del aro, para que el progreso cierre exacto */
  function initRing() {
    if (typeof el.ring.getTotalLength === "function") {
      ringLen = el.ring.getTotalLength() || ringLen;
      el.ring.style.strokeDasharray = String(ringLen);
    }
  }

  function renderPhase(phase) {
    el.phase.textContent = phase === "focus" ? "Enfoque" : "Descanso";
    el.ring.style.stroke = phase === "focus" ? "var(--accent)" : "var(--warn)";
  }

  /* `timer`: { remaining, total, phase, running } */
  function renderTimer(timer) {
    const secs = Math.ceil(timer.remaining / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, "0");
    const ss = String(secs % 60).padStart(2, "0");
    el.time.textContent = `${mm}:${ss}`;

    const progress = timer.total ? 1 - timer.remaining / timer.total : 0;
    el.ring.style.strokeDashoffset = String(ringLen * progress);

    const phaseName = timer.phase === "focus" ? "Enfoque" : "Descanso";
    doc.title = timer.running
      ? `${mm}:${ss} · ${phaseName} · Postava`
      : "Postava · Pomodoro con postura";
  }

  function syncChips() {
    doc.querySelectorAll(".chip").forEach((c) => {
      c.setAttribute("aria-pressed", String(c.dataset.minutes === el.focusMins.value));
    });
  }

  /* Los deslizadores anuncian su valor numérico ("1", "5"); `aria-valuetext` les
     da el mismo texto que ya se ve al lado, que es el que tiene sentido oído. */
  function renderTolerance(value) {
    const text = value < 0.9 ? "estricta" : value > 1.3 ? "relajada" : "normal";
    el.tolValue.textContent = text;
    el.tolerance.setAttribute("aria-valuetext", text);
  }

  function renderDelay(seconds) {
    const text = `${seconds} s`;
    el.delayValue.textContent = text;
    el.delaySeconds.setAttribute("aria-valuetext", text);
  }

  /* `view`: resultado de notifyStatusView() ({ unsupported, text }) */
  function renderNotifyStatus(view) {
    if (view.unsupported) {
      el.notifyToggle.checked = false;
      el.notifyToggle.disabled = true;
    }
    el.notifyStatus.textContent = view.text;
  }

  /* Estadísticas de sesión: { goodMs, badMs, alerts, completed } */
  function renderStats({ goodMs, badMs, alerts, completed }) {
    const total = goodMs + badMs;
    el.goodPct.textContent =
      total > 5000 ? `${Math.round((goodMs / total) * 100)} %` : "—";
    el.alertCount.textContent = alerts;
    el.focusDone.textContent = completed;
  }

  /* El cartel se oculta con `hidden` (display: none), y un live region que aparece o
     desaparece así se anuncia de forma poco fiable. Por eso el anuncio va por
     `#alertLive`: una región persistente y visualmente oculta cuyo texto cambia al
     mostrar/ocultar el cartel (el cartel en sí ya no es live: se leería dos veces).
     Solo lleva el título. El motivo llega por `#postureMsg`, que también es live y
     recibe ese mismo texto: repetirlo aquí lo haría sonar dos veces.
     Igual que setBadge/setMessage, se escribe solo si cambia: hideAlertBanner() se
     llama en cada fotograma mientras no te ven, y un aviso repetido con el cartel ya
     visible no vuelve a anunciarse. */
  let lastAlertLive = "";

  function setAlertLive(text) {
    if (text === lastAlertLive) return;
    lastAlertLive = text;
    el.alertLive.textContent = text;
  }

  function showAlertBanner(reason) {
    el.alertReason.textContent = reason;
    el.alertBanner.hidden = false;
    setAlertLive(ALERT_TITLE);
  }

  function hideAlertBanner() {
    el.alertBanner.hidden = true;
    setAlertLive("");
  }

  /* `size`: { width, height } del vídeo, para dimensionar el canvas del overlay */
  function renderCameraOn({ width, height }) {
    el.overlay.width = width;
    el.overlay.height = height;
    el.placeholder.hidden = true;
    el.btnCamera.textContent = "Apagar cámara";
  }

  function renderCameraOff() {
    el.placeholder.hidden = false;
    el.btnCamera.textContent = "Encender cámara";
  }

  /* ── Estado de guardado de estadísticas (nodo creado bajo demanda) ── */
  function ensureStatsStatus() {
    if (statsStatus) return statsStatus;
    statsStatus = doc.createElement("p");
    statsStatus.className = "stats-save-status";
    statsStatus.setAttribute("role", "status");
    statsStatus.hidden = true;
    const actions = doc.querySelector(".card-timer .actions");
    if (actions) actions.after(statsStatus);
    return statsStatus;
  }

  function showStatsSaving(message) {
    const status = ensureStatsStatus();
    status.textContent = message;
    status.hidden = false;
  }

  function showStatsSaveError(message, onRetry) {
    const status = ensureStatsStatus();
    status.replaceChildren();
    const text = doc.createElement("span");
    text.textContent = message;
    status.append(text);
    const retry = doc.createElement("button");
    retry.type = "button";
    retry.className = "stats-save-retry";
    retry.textContent = "Reintentar";
    retry.addEventListener("click", onRetry);
    status.append(" ", retry);
    status.hidden = false;
  }

  function clearStatsSaveError() {
    if (statsStatus) {
      statsStatus.hidden = true;
      statsStatus.replaceChildren();
    }
  }

  return {
    setBadge,
    setMessage,
    initRing,
    renderPhase,
    renderTimer,
    syncChips,
    renderTolerance,
    renderDelay,
    renderNotifyStatus,
    renderStats,
    showAlertBanner,
    hideAlertBanner,
    renderCameraOn,
    renderCameraOff,
    showStatsSaving,
    showStatsSaveError,
    clearStatsSaveError,
  };
}
