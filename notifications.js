/* Notificaciones del sistema: lógica pura, sin DOM ni Notification. */

export function phaseEndNotification(nextPhase) {
  const body =
    nextPhase === "break"
      ? "Fase de enfoque terminada. Toca descansar."
      : "Descanso terminado. Toca volver al enfoque.";
  return { title: "Postava", body, tag: "postava-phase" };
}

export function postureNotification(issueText) {
  return { title: "Postava", body: issueText, tag: "postava-posture" };
}

export function canNotify({ supported, permission, enabled } = {}) {
  return Boolean(supported) && permission === "granted" && Boolean(enabled);
}

export function shouldNotifyPostureNow({ hidden, ...rest } = {}) {
  return Boolean(hidden) && canNotify(rest);
}

/* Efecto: muestra la notificación del sistema. `enabled` es el estado del
   interruptor; `env` (por defecto globalThis) permite inyectar un entorno falso. */
export function showSystemNotification({ title, body, tag, renotify = false }, enabled, env = globalThis) {
  if (!("Notification" in env)) return;
  if (env.Notification.permission !== "granted" || !enabled) return;
  try {
    const n = new env.Notification(title, { body, tag, renotify });
    n.onclick = () => {
      env.focus();
      n.close();
    };
  } catch {
    /* algunos navegadores exigen service worker para notificar: ignoramos */
  }
}

/* Estado del interruptor de notificaciones: texto y si hay que deshabilitarlo.
   app.js lo vuelca al DOM (syncNotifyStatus). */
export function notifyStatusView({ supported, permission, enabled } = {}) {
  if (!supported) {
    return { unsupported: true, text: "Tu navegador no soporta notificaciones del sistema." };
  }
  let text = "";
  if (enabled) {
    if (permission === "denied") text = "Bloqueadas por el navegador; actívalas desde sus ajustes.";
    else text = permission === "granted" ? "Activadas." : "";
  }
  return { unsupported: false, text };
}
