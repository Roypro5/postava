// Máquina de fases del Pomodoro (enfoque <-> descanso). Sin DOM, cámara,
// sonido, stats ni red: solo callbacks. El cálculo se basa en `endAt`
// (remaining = max(0, endAt - now())), así que no acumula deriva aunque el
// intervalo se ralentice o el reloj salte (pestaña en segundo plano).
//
// El objeto devuelto ES el estado (phase, running, remaining, total, endAt,
// session, completed) más sus operaciones.
//
// Callbacks (todos opcionales):
//   getSettings()            -> { focusMins, breakMins } (valores crudos del formulario)
//   onPhase({ phase })       -> tras cada setPhase (render de fase/aro/tiempo)
//   onTick()                 -> cada tick que no completa la fase
//   onPhaseEnd({ from, skipped })      -> al terminar una fase, ANTES de cambiar de estado
//   onComplete({ from, to, skipped })  -> al terminar una fase, DESPUÉS del cambio
//   setSuspendWatch(on)      -> (operación) vigilancia de suspensión; solo con página visible
//   onSuspend({ at })        -> el equipo se suspendió con el temporizador en marcha;
//                               `at` es el último tick fiable. El temporizador ya queda
//                               en pausa con el restante congelado en ese instante.

// Hueco máximo entre dos ticks consecutivos antes de darlo por suspensión del
// equipo. SOLO se vigila con la página visible y sin tramos ocultos desde el
// último tick (ver setSuspendWatch): un hueco largo también ocurre sin dormir
// el equipo (Energy/Memory Saver de Chrome congelando la pestaña, pestañas en
// segundo plano en móvil, presupuestos de Firefox/Safari) y entonces el
// Pomodoro no debe pausarse. performance.now vs Date.now y los eventos
// freeze/resume no son fiables entre navegadores; la visibilidad sí. Con la
// página oculta se vuelve al comportamiento por `endAt` (la fase termina a su
// hora). Con la página visible el intervalo es de 250 ms, así que 2 min de
// hueco solo se explican por suspensión real (tapa cerrada, hibernación).
export const SUSPEND_GAP_MS = 120_000;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function createTimer({
  getSettings = () => ({}),
  now = Date.now,
  onPhase = () => {},
  onTick = () => {},
  onPhaseEnd = () => {},
  onComplete = () => {},
  onSuspend = () => {},
  suspendGapMs = SUSPEND_GAP_MS,
} = {}) {
  let lastTickAt = null; // último tick con el temporizador en marcha (null = sin vigilancia)
  let watching = true;   // vigilar suspensión (la página la apaga mientras está oculta)
  const arm = () => (watching ? now() : null);
  const timer = {
    phase: "focus",       // "focus" | "break"
    running: false,
    remaining: 25 * 60_000,
    total: 25 * 60_000,
    endAt: 0,
    session: 1,
    completed: 0,

    phaseDurationMs(phase) {
      const { focusMins, breakMins } = getSettings();
      const mins =
        phase === "focus"
          ? clamp(+focusMins || 25, 1, 180)
          : clamp(+breakMins || 5, 1, 60);
      return mins * 60_000;
    },

    setPhase(phase, autoStart = false) {
      timer.phase = phase;
      timer.total = timer.phaseDurationMs(phase);
      timer.remaining = timer.total;
      timer.endAt = now() + timer.remaining;
      timer.running = autoStart;
      lastTickAt = autoStart ? arm() : null;
      onPhase({ phase });
    },

    // Arranca o reanuda: fija endAt a partir del tiempo restante.
    start() {
      if (timer.remaining <= 0) timer.remaining = timer.phaseDurationMs(timer.phase);
      timer.endAt = now() + timer.remaining;
      timer.running = true;
      lastTickAt = arm();
    },

    // Activa/desactiva la detección de suspensión (el llamador decide según la
    // visibilidad de la página; este módulo no toca el DOM). Apagada: sin
    // referencia de tick. Encendida: se re-arma desde ahora, así que el tramo
    // anterior (p. ej. oculto) nunca cuenta como hueco.
    setSuspendWatch(on) {
      watching = !!on;
      lastTickAt = watching && timer.running ? now() : null;
    },

    pause() {
      if (timer.running) timer.remaining = Math.max(0, timer.endAt - now());
      timer.running = false;
      lastTickAt = null;
    },

    // Si el hueco desde el último tick supera el umbral, congela el restante en
    // ese tick, pasa a pausa y avisa con onSuspend. Devuelve true si lo detectó.
    checkSuspend() {
      if (!timer.running || lastTickAt === null) return false;
      if (now() - lastTickAt <= suspendGapMs) return false;
      const at = lastTickAt;
      timer.remaining = Math.max(0, timer.endAt - at);
      timer.running = false;
      lastTickAt = null;
      onSuspend({ at });
      return true;
    },

    // Vuelve a la primera sesión de enfoque, parado.
    reset() {
      timer.running = false;
      lastTickAt = null;
      timer.session = 1;
      timer.completed = 0;
      timer.setPhase("focus");
    },

    completePhase({ skipped = false } = {}) {
      const from = timer.phase;
      onPhaseEnd({ from, skipped });
      if (from === "focus") {
        if (!skipped) timer.completed += 1;
        timer.setPhase("break", true);
      } else {
        timer.session += 1;
        timer.setPhase("focus", false);
      }
      onComplete({ from, to: timer.phase, skipped });
    },

    skip() {
      timer.remaining = 0;
      timer.completePhase({ skipped: true });
    },

    tick() {
      if (timer.checkSuspend()) return;
      if (timer.running) {
        lastTickAt = arm();
        timer.remaining = Math.max(0, timer.endAt - now());
        if (timer.remaining === 0) {
          timer.completePhase();
          return;
        }
      }
      onTick();
    },
  };
  return timer;
}
