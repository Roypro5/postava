import assert from "node:assert/strict";
import test from "node:test";

function installFakeAudio() {
  const created = { contexts: 0, oscillators: 0, resumed: 0 };
  class FakeAudioContext {
    constructor() {
      created.contexts += 1;
      this.state = "suspended";
      this.currentTime = 0;
      this.destination = {};
    }
    resume() {
      created.resumed += 1;
      this.state = "running";
      return Promise.resolve();
    }
    createOscillator() {
      created.oscillators += 1;
      return {
        type: "",
        frequency: { setValueAtTime() {} },
        connect: (n) => n,
        start() {},
        stop() {},
      };
    }
    createGain() {
      const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
      return { gain: param, connect: (n) => n };
    }
  }
  globalThis.AudioContext = FakeAudioContext;
  return created;
}

const created = installFakeAudio();
const sound = await import("../sound.js");

test("con el sonido desactivado no se crean osciladores ni contexto", () => {
  sound.setSoundEnabled(false);
  sound.soundPosture();
  sound.soundPhaseEnd();
  assert.equal(created.oscillators, 0);
  assert.equal(created.contexts, 0);
});

test("ensureAudio es idempotente y reanuda el contexto suspendido", () => {
  const a = sound.ensureAudio();
  const b = sound.ensureAudio();
  assert.equal(a, b);
  assert.equal(created.contexts, 1);
  assert.equal(created.resumed, 1);
});

test("con el sonido activado, los avisos generan 2 y 3 tonos", () => {
  sound.setSoundEnabled(true);
  sound.soundPosture();
  assert.equal(created.oscillators, 2);
  sound.soundPhaseEnd();
  assert.equal(created.oscillators, 5);
  assert.equal(created.contexts, 1);
});

// El constructor puede lanzar (política de autoplay, límite de contextos, dispositivo de audio ausente):
// el sonido es opcional, así que ensureAudio() devuelve null en vez de propagar el error, que
// abortaría startTimer() (llama a ensureAudio en su primera línea) y el cambio de fase.
// Instancia propia del módulo (sufijo en la URL): el contexto se guarda a nivel de módulo.
test("si new AudioContext() lanza: ensureAudio devuelve null, los avisos no lanzan y se reintenta después", async () => {
  const original = globalThis.AudioContext;
  const isolated = await import("../sound.js?audio-constructor-throws");
  let attempts = 0;
  globalThis.AudioContext = class {
    constructor() {
      attempts += 1;
      throw new Error("NotAllowedError (simulado)");
    }
  };
  try {
    isolated.setSoundEnabled(true);
    assert.equal(isolated.ensureAudio(), null);
    assert.doesNotThrow(() => isolated.soundPosture());
    assert.doesNotThrow(() => isolated.soundPhaseEnd());
    assert.doesNotThrow(() => isolated.tone(440, 0, 0.1));
    assert.ok(attempts >= 1);

    // Un fallo puntual no deja el sonido roto para siempre: al funcionar el constructor, se crea el contexto.
    let oscillators = 0;
    globalThis.AudioContext = class {
      constructor() {
        this.state = "running";
        this.currentTime = 0;
        this.destination = {};
      }
      createOscillator() {
        oscillators += 1;
        return { frequency: { setValueAtTime() {} }, connect: (n) => n, start() {}, stop() {} };
      }
      createGain() {
        return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (n) => n };
      }
    };
    assert.ok(isolated.ensureAudio());
    isolated.soundPosture();
    assert.equal(oscillators, 2);
  } finally {
    globalThis.AudioContext = original;
  }
});
