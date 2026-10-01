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

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function createTimer({
  getSettings = () => ({}),
  now = Date.now,
  onPhase = () => {},
  onTick = () => {},
  onPhaseEnd = () => {},
  onComplete = () => {},
} = {}) {
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
      onPhase({ phase });
    },

    // Arranca o reanuda: fija endAt a partir del tiempo restante.
    start() {
      if (timer.remaining <= 0) timer.remaining = timer.phaseDurationMs(timer.phase);
      timer.endAt = now() + timer.remaining;
      timer.running = true;
    },

    pause() {
      timer.running = false;
    },

    // Vuelve a la primera sesión de enfoque, parado.
    reset() {
      timer.running = false;
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
      if (timer.running) {
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
