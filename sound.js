/* Sonido (WebAudio, sin archivos externos). No conoce DOM, timer ni ajustes:
   el estado de "sonido activado" se inyecta con setSoundEnabled. */

let audioCtx = null;
let soundEnabled = true;

export function setSoundEnabled(value) {
  soundEnabled = Boolean(value);
}

/* Crea el AudioContext de forma perezosa (debe llamarse tras un gesto del usuario).
   Devuelve null si no hay WebAudio o el constructor lanza (autoplay, límite de contextos,
   sin dispositivo): el sonido es opcional y un error aquí no puede abortar el temporizador
   (startTimer llama a esta función en su primera línea, y el fin de fase al sonar). Como
   audioCtx sigue en null, la siguiente llamada lo intenta de nuevo. */
export function ensureAudio() {
  if (!audioCtx) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    try {
      audioCtx = new AC();
    } catch {
      return null;
    }
  }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

export function tone(freq, startOffset, duration, peak = 0.12) {
  const ac = ensureAudio();
  if (!ac) return;
  const t0 = ac.currentTime + startOffset;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

export const soundPosture = () => {
  if (!soundEnabled) return;
  tone(523.25, 0, 0.7);      // do
  tone(659.25, 0.14, 0.8);   // mi
};

export const soundPhaseEnd = () => {
  if (!soundEnabled) return;
  tone(587.33, 0, 0.5, 0.14);
  tone(739.99, 0.16, 0.5, 0.14);
  tone(880.0, 0.32, 0.9, 0.14);
};
