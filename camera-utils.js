// Utilidades puras e inyectables para la cámara (sin DOM global).

/**
 * Espera a que el video tenga metadata (videoWidth > 0).
 * Resuelve de inmediato si ya la tiene; rechaza con Error al expirar.
 * Siempre limpia el timer y el listener.
 */
export function waitForVideoMetadata(
  video,
  { timeoutMs = 5000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {},
) {
  return new Promise((resolve, reject) => {
    if (video.videoWidth > 0) return resolve();

    let timeoutId = null;
    const onMetadata = () => {
      clearTimeoutFn(timeoutId);
      video.removeEventListener("loadedmetadata", onMetadata);
      resolve();
    };
    timeoutId = setTimeoutFn(() => {
      video.removeEventListener("loadedmetadata", onMetadata);
      reject(new Error(`La cámara no entregó metadata en ${timeoutMs} ms`));
    }, timeoutMs);
    video.addEventListener("loadedmetadata", onMetadata);
  });
}

/**
 * Registra un listener "ended" en el track y devuelve la función para desregistrarlo.
 */
export function watchTrackEnded(track, onEnded) {
  track.addEventListener("ended", onEnded);
  return () => track.removeEventListener("ended", onEnded);
}
