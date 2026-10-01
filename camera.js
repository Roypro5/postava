/* Cámara: adquisición del stream, ciclo de vida y liberación de pistas.
   Módulo de efectos (I/O) sin acceso a `document`/`el`: recibe el <video> por
   parámetro y solo depende de camera-utils.js. El vídeo nunca sale del navegador.

   start() no genera texto de UI: devuelve un resultado tipificado y app.js
   decide el mensaje/badge.
     { ok: true }
     { ok: false, reason: "unsupported" }                    el navegador no expone getUserMedia
     { ok: false, reason: "denied", error }                  getUserMedia rechazó (permiso denegado,
                                                             sin dispositivo, cámara ocupada…: hoy la
                                                             UI los trata igual; `error.name` los distingue)
     { ok: false, reason: "metadata-timeout", error }        el vídeo no entregó metadata a tiempo
                                                             (el stream ya se ha liberado)
     { ok: false, reason: "cancelled" }                      stop() se llamó mientras el arranque estaba
                                                             pendiente (permiso, getUserMedia o metadata):
                                                             el stream nuevo se ha parado y no es un error

   Concurrencia: start() es idempotente mientras hay un arranque en curso (las
   llamadas concurrentes reciben la misma promesa y solo se abre UN stream) y
   stop() lo cancela mediante un contador de generación, de modo que un
   getUserMedia que llega tarde nunca deja una pista viva ni la luz encendida. */

import { waitForVideoMetadata, watchTrackEnded } from "./camera-utils.js";

const VIDEO_CONSTRAINTS = {
  video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
  audio: false,
};

export function createCamera({
  video,
  onEnded = () => {},
  getMediaDevices = () => globalThis.navigator?.mediaDevices,
  waitForMetadata = waitForVideoMetadata,
  metadataTimeoutMs = 5000,
} = {}) {
  let stream = null;
  let unwatchTrackEnded = null;
  let on = false;
  /* Cada stop() incrementa `generation`; un arranque recuerda la generación con la
     que empezó y la compara tras cada await. `starting` es el arranque en curso. */
  let generation = 0;
  let starting = null;

  const cancelled = () => ({ ok: false, reason: "cancelled" });
  const stopTracks = (s) => s.getTracks().forEach((t) => t.stop());

  function start() {
    if (on) return Promise.resolve({ ok: true });
    if (starting) return starting;
    const attempt = open(generation).finally(() => {
      if (starting === attempt) starting = null;
    });
    starting = attempt;
    return attempt;
  }

  async function open(myGeneration) {
    const mediaDevices = getMediaDevices();
    if (!mediaDevices?.getUserMedia) return { ok: false, reason: "unsupported" };

    let acquired;
    try {
      acquired = await mediaDevices.getUserMedia(VIDEO_CONSTRAINTS);
    } catch (error) {
      // Si stop() llegó mientras se esperaba el permiso, el rechazo no es un error para la UI.
      return myGeneration === generation ? { ok: false, reason: "denied", error } : cancelled();
    }
    if (myGeneration !== generation) {
      // stop() llegó mientras se esperaba el permiso: el stream nunca se llegó a asignar.
      stopTracks(acquired);
      return cancelled();
    }

    /* Tras cada await, si la generación cambió es que stop() cancelló este arranque:
       stop() ya paró las pistas de `acquired` (estaba asignado a `stream`). Otro
       start() pudo abrir entretanto un stream nuevo, así que aquí NO se toca
       `stream`, `video.srcObject` ni `unwatchTrackEnded`: son de ese otro arranque. */
    stream = acquired;
    const track = acquired.getVideoTracks()[0];
    if (track) {
      unwatchTrackEnded = watchTrackEnded(track, () => {
        if (!on) return;
        stop();
        onEnded();
      });
    }

    video.srcObject = acquired;
    await video.play().catch(() => {});
    if (myGeneration !== generation) return cancelled();

    try {
      await waitForMetadata(video, { timeoutMs: metadataTimeoutMs });
    } catch (error) {
      if (myGeneration !== generation) return cancelled();
      stop();
      return { ok: false, reason: "metadata-timeout", error };
    }
    if (myGeneration !== generation) return cancelled();

    on = true;
    return { ok: true };
  }

  /* Idempotente: cancela un arranque pendiente, desregistra el listener, detiene
     TODAS las pistas y libera srcObject. */
  function stop() {
    generation += 1;
    starting = null;
    if (unwatchTrackEnded) unwatchTrackEnded();
    unwatchTrackEnded = null;
    if (stream) stopTracks(stream);
    stream = null;
    video.srcObject = null;
    on = false;
  }

  /* Solo detiene las pistas (usado al salir de la página: pagehide/beforeunload);
     no toca srcObject ni el estado. */
  function releaseTracks() {
    if (stream) stopTracks(stream);
  }

  /* Solo para window.postavaDebug.forceCamera: fuerza el flag sin stream real. */
  function forceOn(value) {
    on = value;
  }

  return { start, stop, isOn: () => on, releaseTracks, forceOn };
}
