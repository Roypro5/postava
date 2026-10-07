import assert from "node:assert/strict";
import test from "node:test";
import { createHeartbeat } from "../heartbeat.js";

class FakeWorker {
  constructor() {
    this.messages = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
  }
  postMessage(message) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
}

function harness({ workerThrows = false } = {}) {
  const h = { workers: [], intervals: new Map(), cleared: [], beats: 0, nextId: 1 };
  h.hb = createHeartbeat({
    createWorker: () => {
      if (workerThrows) throw new Error("Worker bloqueado");
      const worker = new FakeWorker();
      h.workers.push(worker);
      return worker;
    },
    setInterval: (fn, ms) => {
      const id = h.nextId++;
      h.intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => {
      h.cleared.push(id);
      h.intervals.delete(id);
    },
    onBeat: () => h.beats++,
  });
  return h;
}

test("setRate crea el Worker una vez y le envía {ms}", () => {
  const h = harness();
  h.hb.setRate(250);
  h.hb.setRate(1000);
  assert.equal(h.workers.length, 1);
  assert.deepEqual(h.workers[0].messages, [{ ms: 250 }, { ms: 1000 }]);
  assert.equal(h.intervals.size, 0, "con Worker no se usa setInterval");
});

test("cada mensaje del Worker dispara onBeat", () => {
  const h = harness();
  h.hb.setRate(250);
  h.workers[0].onmessage({ data: 0 });
  h.workers[0].onmessage({ data: 0 });
  assert.equal(h.beats, 2);
});

test("si createWorker lanza, cae a setInterval con la cadencia pedida y la cambia", () => {
  const h = harness({ workerThrows: true });
  h.hb.setRate(250);
  assert.deepEqual([...h.intervals.values()].map((i) => i.ms), [250]);
  [...h.intervals.values()][0].fn();
  assert.equal(h.beats, 1);
  h.hb.setRate(1000);
  assert.deepEqual([...h.intervals.values()].map((i) => i.ms), [1000], "el intervalo anterior se limpia");
  assert.equal(h.cleared.length, 1);
});

test("si el Worker da error, se termina y se cae a setInterval conservando la cadencia", () => {
  const h = harness();
  h.hb.setRate(1000);
  h.workers[0].onerror({});
  assert.equal(h.workers[0].terminated, true);
  assert.deepEqual([...h.intervals.values()].map((i) => i.ms), [1000]);
  h.hb.setRate(250);
  assert.equal(h.workers.length, 1, "no se reintenta crear el Worker");
  assert.deepEqual([...h.intervals.values()].map((i) => i.ms), [250]);
});

test("stop avisa al Worker, lo termina y limpia el intervalo de reserva", () => {
  const h = harness();
  h.hb.setRate(250);
  h.hb.stop();
  assert.equal(h.workers[0].messages.at(-1), "stop");
  assert.equal(h.workers[0].terminated, true);

  const f = harness({ workerThrows: true });
  f.hb.setRate(250);
  f.hb.stop();
  assert.equal(f.intervals.size, 0);
  f.hb.stop(); // idempotente
});

test("un Worker terminado ya no dispara latidos", () => {
  const h = harness();
  h.hb.setRate(250);
  const [worker] = h.workers;
  h.hb.stop();
  worker.onmessage?.({ data: 0 });
  assert.equal(h.beats, 0);
});

test("setRate tras stop() crea un Worker nuevo (el anterior ya está terminado)", () => {
  const h = harness();
  h.hb.setRate(250);
  h.hb.stop();
  h.hb.setRate(1000);
  assert.equal(h.workers.length, 2);
  assert.equal(h.workers[0].terminated, true);
  assert.equal(h.workers[1].terminated, false);
  assert.deepEqual(h.workers[1].messages, [{ ms: 1000 }]);
});

test("tick-worker.js acota la cadencia a [250, 60000] ms", async () => {
  const { readFileSync } = await import("node:fs");
  const { runInNewContext } = await import("node:vm");
  const intervals = [];
  const ctx = { setInterval: (_fn, ms) => { intervals.push(ms); return intervals.length; }, clearInterval() {}, postMessage() {} };
  runInNewContext(readFileSync(new URL("../tick-worker.js", import.meta.url), "utf8"), ctx);
  for (const ms of [1, 250, 1000, 60000, 3_600_000]) ctx.onmessage({ data: { ms } });
  assert.deepEqual(intervals, [250, 250, 1000, 60000, 60000]);
  ctx.onmessage({ data: "stop" });
  assert.equal(intervals.length, 5, "stop no arranca otro intervalo");
});
