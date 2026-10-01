import test from "node:test";
import assert from "node:assert/strict";
import { waitForVideoMetadata, watchTrackEnded } from "../camera-utils.js";

function fakeVideo(videoWidth = 0) {
  const v = new EventTarget();
  v.videoWidth = videoWidth;
  return v;
}

function fakeTimers() {
  const state = { cleared: [], fn: null, id: 42 };
  return {
    state,
    setTimeoutFn: (fn) => {
      state.fn = fn;
      return state.id;
    },
    clearTimeoutFn: (id) => state.cleared.push(id),
  };
}

// Cuenta listeners activos envolviendo add/remove.
function trackListeners(target) {
  const set = new Set();
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = (t, l) => (set.add(l), add(t, l));
  target.removeEventListener = (t, l) => (set.delete(l), remove(t, l));
  return set;
}

test("waitForVideoMetadata resuelve de inmediato si ya hay metadata", async () => {
  const timers = fakeTimers();
  await waitForVideoMetadata(fakeVideo(640), timers);
  assert.equal(timers.state.fn, null);
});

test("waitForVideoMetadata resuelve con loadedmetadata y limpia timer y listener", async () => {
  const video = fakeVideo(0);
  const listeners = trackListeners(video);
  const timers = fakeTimers();
  const p = waitForVideoMetadata(video, timers);
  assert.equal(listeners.size, 1);
  video.dispatchEvent(new Event("loadedmetadata"));
  await p;
  assert.deepEqual(timers.state.cleared, [42]);
  assert.equal(listeners.size, 0);
});

test("waitForVideoMetadata rechaza al expirar y quita el listener", async () => {
  const video = fakeVideo(0);
  const listeners = trackListeners(video);
  const timers = fakeTimers();
  const p = waitForVideoMetadata(video, { ...timers, timeoutMs: 5000 });
  timers.state.fn();
  await assert.rejects(p, (err) => err instanceof Error && /5000/.test(err.message));
  assert.equal(listeners.size, 0);
});

test("watchTrackEnded llama a onEnded y deja de llamarlo tras desregistrar", () => {
  const track = new EventTarget();
  let calls = 0;
  const stop = watchTrackEnded(track, () => calls++);
  track.dispatchEvent(new Event("ended"));
  assert.equal(calls, 1);
  stop();
  track.dispatchEvent(new Event("ended"));
  assert.equal(calls, 1);
});
