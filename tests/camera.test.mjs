import test from "node:test";
import assert from "node:assert/strict";
import { createCamera } from "../camera.js";

/* Pista falsa: EventTarget con stop() contado */
function fakeTrack() {
  const t = new EventTarget();
  t.stopped = 0;
  t.stop = () => {
    t.stopped += 1;
  };
  return t;
}

function fakeStream(tracks = [fakeTrack()]) {
  return {
    tracks,
    getVideoTracks: () => tracks,
    getTracks: () => tracks,
  };
}

function fakeVideo({ videoWidth = 640 } = {}) {
  const v = new EventTarget();
  v.videoWidth = videoWidth;
  v.srcObject = null;
  v.played = 0;
  v.play = async () => {
    v.played += 1;
  };
  return v;
}

function setup({ stream = fakeStream(), getUserMedia, video = fakeVideo(), ...options } = {}) {
  const calls = { getUserMedia: [], ended: 0 };
  const mediaDevices = {
    getUserMedia:
      getUserMedia ??
      (async (constraints) => {
        calls.getUserMedia.push(constraints);
        return stream;
      }),
  };
  const camera = createCamera({
    video,
    onEnded: () => {
      calls.ended += 1;
    },
    getMediaDevices: () => mediaDevices,
    ...options,
  });
  return { camera, video, stream, calls, mediaDevices };
}

test("start OK: asigna srcObject, reproduce y queda encendida con las mismas restricciones", async () => {
  const { camera, video, stream, calls } = setup();
  assert.equal(camera.isOn(), false);
  const result = await camera.start();
  assert.deepEqual(result, { ok: true });
  assert.equal(camera.isOn(), true);
  assert.equal(video.srcObject, stream);
  assert.equal(video.played, 1);
  assert.deepEqual(calls.getUserMedia, [
    { video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }, audio: false },
  ]);
});

test("start estando ya encendida no vuelve a pedir la cámara", async () => {
  const { camera, calls } = setup();
  await camera.start();
  assert.deepEqual(await camera.start(), { ok: true });
  assert.equal(calls.getUserMedia.length, 1);
});

test("sin mediaDevices/getUserMedia → reason unsupported", async () => {
  const video = fakeVideo();
  const a = createCamera({ video, getMediaDevices: () => undefined });
  assert.deepEqual(await a.start(), { ok: false, reason: "unsupported" });
  const b = createCamera({ video, getMediaDevices: () => ({}) });
  assert.deepEqual(await b.start(), { ok: false, reason: "unsupported" });
  assert.equal(a.isOn(), false);
  assert.equal(video.srcObject, null);
});

for (const name of ["NotAllowedError", "NotFoundError", "NotReadableError"]) {
  test(`getUserMedia rechaza con ${name} → reason denied con el error original (como hoy)`, async () => {
    const error = Object.assign(new Error(name), { name });
    const { camera, video } = setup({
      getUserMedia: async () => {
        throw error;
      },
    });
    const result = await camera.start();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "denied");
    assert.equal(result.error, error);
    assert.equal(result.error.name, name);
    assert.equal(camera.isOn(), false);
    assert.equal(video.srcObject, null);
  });
}

test("metadata que no llega → reason metadata-timeout y el stream queda liberado", async () => {
  const stream = fakeStream([fakeTrack(), fakeTrack()]);
  const timeout = new Error("timeout");
  let receivedOptions;
  const { camera, video } = setup({
    stream,
    metadataTimeoutMs: 1234,
    waitForMetadata: async (_video, options) => {
      receivedOptions = options;
      throw timeout;
    },
  });
  const result = await camera.start();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "metadata-timeout");
  assert.equal(result.error, timeout);
  assert.deepEqual(receivedOptions, { timeoutMs: 1234 });
  assert.equal(camera.isOn(), false);
  assert.equal(video.srcObject, null);
  assert.deepEqual(stream.tracks.map((t) => t.stopped), [1, 1]);
});

test("por defecto espera la metadata (loadedmetadata) antes de quedar encendida", async () => {
  const video = fakeVideo({ videoWidth: 0 });
  const { camera } = setup({ video });
  const pending = camera.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(camera.isOn(), false);
  video.videoWidth = 640;
  video.dispatchEvent(new Event("loadedmetadata"));
  assert.deepEqual(await pending, { ok: true });
  assert.equal(camera.isOn(), true);
});

test("stop detiene TODAS las pistas, libera srcObject y apaga", async () => {
  const stream = fakeStream([fakeTrack(), fakeTrack(), fakeTrack()]);
  const { camera, video } = setup({ stream });
  await camera.start();
  camera.stop();
  assert.deepEqual(stream.tracks.map((t) => t.stopped), [1, 1, 1]);
  assert.equal(video.srcObject, null);
  assert.equal(camera.isOn(), false);
});

test("stop es idempotente: no vuelve a parar pistas ni lanza", async () => {
  const stream = fakeStream([fakeTrack(), fakeTrack()]);
  const { camera, video } = setup({ stream });
  camera.stop(); // antes de arrancar
  await camera.start();
  camera.stop();
  camera.stop();
  assert.deepEqual(stream.tracks.map((t) => t.stopped), [1, 1]);
  assert.equal(video.srcObject, null);
  assert.equal(camera.isOn(), false);
});

test("una pista que termina (ended) con la cámara encendida apaga y dispara onEnded", async () => {
  const track = fakeTrack();
  const stream = fakeStream([track]);
  const { camera, video, calls } = setup({ stream });
  await camera.start();
  track.dispatchEvent(new Event("ended"));
  assert.equal(calls.ended, 1);
  assert.equal(camera.isOn(), false);
  assert.equal(video.srcObject, null);
  assert.equal(track.stopped, 1);
  // el listener se retiró: un segundo ended no dispara de nuevo
  track.dispatchEvent(new Event("ended"));
  assert.equal(calls.ended, 1);
});

test("ended antes de quedar encendida (aún esperando metadata) se ignora", async () => {
  const track = fakeTrack();
  const video = fakeVideo({ videoWidth: 0 });
  const { camera, calls } = setup({ stream: fakeStream([track]), video });
  const pending = camera.start();
  await new Promise((r) => setImmediate(r));
  track.dispatchEvent(new Event("ended"));
  assert.equal(calls.ended, 0);
  video.videoWidth = 640;
  video.dispatchEvent(new Event("loadedmetadata"));
  assert.deepEqual(await pending, { ok: true });
});

test("tras stop() el listener ended ya no dispara onEnded", async () => {
  const track = fakeTrack();
  const { camera, calls } = setup({ stream: fakeStream([track]) });
  await camera.start();
  camera.stop();
  track.dispatchEvent(new Event("ended"));
  assert.equal(calls.ended, 0);
});

test("se puede reiniciar tras stop()", async () => {
  const { camera, calls } = setup();
  await camera.start();
  camera.stop();
  assert.deepEqual(await camera.start(), { ok: true });
  assert.equal(camera.isOn(), true);
  assert.equal(calls.getUserMedia.length, 2);
});

test("releaseTracks solo detiene las pistas (beforeunload): no toca srcObject ni el estado", async () => {
  const stream = fakeStream([fakeTrack(), fakeTrack()]);
  const { camera, video } = setup({ stream });
  camera.releaseTracks(); // sin stream: no lanza
  await camera.start();
  camera.releaseTracks();
  assert.deepEqual(stream.tracks.map((t) => t.stopped), [1, 1]);
  assert.equal(video.srcObject, stream);
  assert.equal(camera.isOn(), true);
});

test("forceOn (gancho de depuración) fuerza el flag sin stream", () => {
  const { camera } = setup();
  camera.forceOn(true);
  assert.equal(camera.isOn(), true);
  camera.stop();
  assert.equal(camera.isOn(), false);
});

/* ── Concurrencia: start() concurrente y stop() durante un arranque pendiente ── */

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  const d = {};
  d.promise = new Promise((resolve, reject) => {
    d.resolve = resolve;
    d.reject = reject;
  });
  return d;
}

/* getUserMedia controlado a mano: la llamada n-ésima espera al n-ésimo `gate` */
function gatedUserMedia(gates) {
  const state = { calls: 0 };
  const getUserMedia = () => gates[state.calls++].promise;
  return { getUserMedia, state };
}

test("start concurrente (esperando permiso) abre UN solo stream y comparte la misma promesa", async () => {
  const stream = fakeStream([fakeTrack(), fakeTrack()]);
  const gate = deferred();
  const { getUserMedia, state } = gatedUserMedia([gate]);
  const { camera, video } = setup({ getUserMedia });

  const first = camera.start();
  const second = camera.start();
  const third = camera.start();
  assert.equal(second, first, "las llamadas concurrentes reciben la misma promesa");
  assert.equal(third, first);
  assert.equal(state.calls, 1, "un solo getUserMedia en vuelo");

  gate.resolve(stream);
  assert.deepEqual(await first, { ok: true });
  assert.equal(state.calls, 1);
  assert.equal(camera.isOn(), true);
  assert.equal(video.srcObject, stream);
  assert.equal(video.played, 1);
  assert.deepEqual(stream.tracks.map((t) => t.stopped), [0, 0], "ninguna pista se ha parado");
});

test("start concurrente mientras se espera la metadata tampoco abre un segundo stream", async () => {
  const stream = fakeStream();
  const metadata = deferred();
  let opened = 0;
  const { camera } = setup({
    getUserMedia: async () => {
      opened += 1;
      return stream;
    },
    waitForMetadata: () => metadata.promise,
  });

  const first = camera.start();
  await nextTurn(); // getUserMedia ya resolvió; el arranque espera la metadata
  const second = camera.start();
  assert.equal(second, first);
  assert.equal(camera.isOn(), false);

  metadata.resolve();
  assert.deepEqual(await first, { ok: true });
  assert.equal(opened, 1);
  assert.equal(stream.tracks[0].stopped, 0);
  assert.equal(camera.isOn(), true);

  // Terminado el arranque, start() vuelve a ser inmediato y sin nuevos streams.
  assert.deepEqual(await camera.start(), { ok: true });
  assert.equal(opened, 1);
});

test("tras un arranque fallido (denegado) un start() posterior vuelve a intentarlo", async () => {
  const stream = fakeStream();
  const gates = [deferred(), deferred()];
  const { getUserMedia, state } = gatedUserMedia(gates);
  const { camera } = setup({ getUserMedia });

  const first = camera.start();
  const shared = camera.start();
  gates[0].reject(Object.assign(new Error("denegado"), { name: "NotAllowedError" }));
  const [a, b] = await Promise.all([first, shared]);
  assert.equal(a.reason, "denied");
  assert.equal(b.reason, "denied");
  assert.equal(state.calls, 1);

  const retry = camera.start();
  gates[1].resolve(stream);
  assert.deepEqual(await retry, { ok: true });
  assert.equal(state.calls, 2);
});

test("stop() durante getUserMedia pendiente cancela: pistas paradas, isOn false y sin error", async () => {
  const stream = fakeStream([fakeTrack(), fakeTrack()]);
  const gate = deferred();
  const { getUserMedia } = gatedUserMedia([gate]);
  const { camera, video, calls } = setup({ getUserMedia });

  const pending = camera.start();
  camera.stop(); // p. ej. el usuario pausa mientras el navegador muestra el aviso de permiso
  assert.equal(camera.isOn(), false);

  gate.resolve(stream); // el permiso llega tarde
  assert.deepEqual(await pending, { ok: false, reason: "cancelled" });
  assert.equal(camera.isOn(), false, "no queda encendida");
  assert.deepEqual(stream.tracks.map((t) => t.stopped), [1, 1], "todas las pistas del stream tardío, paradas");
  assert.equal(video.srcObject, null, "el stream cancelado nunca se asigna al <video>");
  assert.equal(video.played, 0);
  assert.equal(calls.ended, 0);
});

test("getUserMedia que rechaza tras stop() se informa como cancelled, no como denied", async () => {
  const gate = deferred();
  const { getUserMedia } = gatedUserMedia([gate]);
  const { camera } = setup({ getUserMedia });

  const pending = camera.start();
  camera.stop();
  gate.reject(Object.assign(new Error("denegado"), { name: "NotAllowedError" }));
  assert.deepEqual(await pending, { ok: false, reason: "cancelled" });
  assert.equal(camera.isOn(), false);
});

test("stop() durante la espera de metadata cancela: la luz se apaga al instante y no se pisa el estado", async () => {
  const stream = fakeStream([fakeTrack(), fakeTrack()]);
  const metadata = deferred();
  const { camera, video, calls } = setup({ stream, waitForMetadata: () => metadata.promise });

  const pending = camera.start();
  await nextTurn();
  assert.equal(video.srcObject, stream);

  camera.stop();
  assert.deepEqual(stream.tracks.map((t) => t.stopped), [1, 1], "stop() ya paró las pistas");
  assert.equal(video.srcObject, null);
  assert.equal(camera.isOn(), false);

  metadata.resolve(); // la metadata llega después de stop()
  assert.deepEqual(await pending, { ok: false, reason: "cancelled" });
  assert.equal(camera.isOn(), false, "isOn() no pasa a true");
  assert.deepEqual(stream.tracks.map((t) => t.stopped), [1, 1], "no se vuelven a parar (ni a abrir) pistas");
  assert.equal(video.srcObject, null);
  assert.equal(calls.ended, 0);
});

test("un timeout de metadata posterior a stop() es cancelled: no se vuelve a llamar a stop() sobre estado ajeno", async () => {
  const stream = fakeStream();
  const metadata = deferred();
  const { camera, video } = setup({ stream, waitForMetadata: () => metadata.promise });

  const pending = camera.start();
  await nextTurn();
  camera.stop();
  metadata.reject(new Error("timeout"));
  assert.deepEqual(await pending, { ok: false, reason: "cancelled" });
  assert.equal(camera.isOn(), false);
  assert.equal(video.srcObject, null);
});

test("stop() y start() seguidos: el arranque viejo se cancela y NO apaga el stream del nuevo (llegue en el orden que llegue)", async () => {
  for (const order of ["viejo primero", "nuevo primero"]) {
    const oldStream = fakeStream([fakeTrack(), fakeTrack()]);
    const newStream = fakeStream([fakeTrack()]);
    const gates = [deferred(), deferred()];
    const { getUserMedia, state } = gatedUserMedia(gates);
    const { camera, video, calls } = setup({ getUserMedia });

    const oldStart = camera.start();
    camera.stop();
    const newStart = camera.start();
    assert.notEqual(newStart, oldStart, "tras stop() el nuevo start() es un arranque nuevo");
    assert.equal(state.calls, 2);

    if (order === "viejo primero") {
      gates[0].resolve(oldStream);
      assert.deepEqual(await oldStart, { ok: false, reason: "cancelled" });
      gates[1].resolve(newStream);
      assert.deepEqual(await newStart, { ok: true });
    } else {
      gates[1].resolve(newStream);
      assert.deepEqual(await newStart, { ok: true });
      gates[0].resolve(oldStream);
      assert.deepEqual(await oldStart, { ok: false, reason: "cancelled" });
    }

    assert.equal(camera.isOn(), true, order);
    assert.equal(video.srcObject, newStream, order);
    assert.deepEqual(oldStream.tracks.map((t) => t.stopped), [1, 1], `${order}: el stream viejo, parado`);
    assert.deepEqual(newStream.tracks.map((t) => t.stopped), [0], `${order}: el stream nuevo, vivo`);
    assert.equal(calls.ended, 0, order);

    camera.stop();
    assert.deepEqual(newStream.tracks.map((t) => t.stopped), [1], `${order}: stop() final lo libera`);
  }
});

test("un timeout de metadata del arranque viejo no destruye el stream del arranque nuevo", async () => {
  const oldStream = fakeStream();
  const newStream = fakeStream();
  const streams = [oldStream, newStream];
  const metadata = [deferred(), deferred()];
  let call = 0;
  const { camera, video } = setup({
    getUserMedia: async () => streams[call],
    waitForMetadata: () => metadata[call++].promise,
  });

  const oldStart = camera.start();
  await nextTurn(); // el viejo espera su metadata
  camera.stop();
  const newStart = camera.start();
  await nextTurn(); // el nuevo espera la suya
  metadata[1].resolve();
  assert.deepEqual(await newStart, { ok: true });

  metadata[0].reject(new Error("timeout")); // el viejo caduca cuando el nuevo ya está encendido
  assert.deepEqual(await oldStart, { ok: false, reason: "cancelled" });
  assert.equal(camera.isOn(), true);
  assert.equal(video.srcObject, newStream);
  assert.deepEqual(newStream.tracks.map((t) => t.stopped), [0]);
});

test("ended durante un arranque pendiente se ignora y no acumula avisos; con la cámara encendida sí avisa", async () => {
  const track = fakeTrack();
  const metadata = deferred();
  const { camera, video, calls } = setup({ stream: fakeStream([track]), waitForMetadata: () => metadata.promise });

  const pending = camera.start();
  await nextTurn();
  track.dispatchEvent(new Event("ended")); // aún no está encendida
  assert.equal(calls.ended, 0);
  assert.equal(video.srcObject !== null, true, "no se libera nada a medias");

  metadata.resolve();
  assert.deepEqual(await pending, { ok: true });
  assert.equal(calls.ended, 0);

  track.dispatchEvent(new Event("ended")); // ya encendida: pérdida real de la cámara
  assert.equal(calls.ended, 1);
  assert.equal(camera.isOn(), false);
  assert.equal(track.stopped, 1);
});

test("ended durante un arranque pendiente seguido de stop(): cancelled, onEnded nunca se llama y el listener se retira", async () => {
  const track = fakeTrack();
  const metadata = deferred();
  const { camera, video, calls } = setup({ stream: fakeStream([track]), waitForMetadata: () => metadata.promise });

  const pending = camera.start();
  await nextTurn();
  track.dispatchEvent(new Event("ended"));
  camera.stop();
  metadata.resolve();

  assert.deepEqual(await pending, { ok: false, reason: "cancelled" });
  track.dispatchEvent(new Event("ended")); // el listener ya no está
  assert.equal(calls.ended, 0);
  assert.equal(camera.isOn(), false);
  assert.equal(video.srcObject, null);
  assert.equal(track.stopped, 1);
});
