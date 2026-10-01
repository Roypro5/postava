import test from "node:test";
import assert from "node:assert/strict";
import {
  phaseEndNotification,
  postureNotification,
  canNotify,
  shouldNotifyPostureNow,
  showSystemNotification,
  notifyStatusView,
} from "../notifications.js";

test("phaseEndNotification: textos y tag por fase", () => {
  assert.deepEqual(phaseEndNotification("break"), {
    title: "Postava",
    body: "Fase de enfoque terminada. Toca descansar.",
    tag: "postava-phase",
  });
  assert.deepEqual(phaseEndNotification("focus"), {
    title: "Postava",
    body: "Descanso terminado. Toca volver al enfoque.",
    tag: "postava-phase",
  });
});

test("postureNotification usa el texto y su tag", () => {
  assert.deepEqual(postureNotification("Endereza la espalda"), {
    title: "Postava",
    body: "Endereza la espalda",
    tag: "postava-posture",
  });
});

test("canNotify: tabla de verdad", () => {
  for (const supported of [true, false])
    for (const permission of ["granted", "denied", "default"])
      for (const enabled of [true, false]) {
        const esperado = supported && permission === "granted" && enabled;
        assert.equal(canNotify({ supported, permission, enabled }), esperado);
      }
});

test("shouldNotifyPostureNow solo con la pestaña oculta", () => {
  const ok = { supported: true, permission: "granted", enabled: true };
  assert.equal(shouldNotifyPostureNow({ hidden: true, ...ok }), true);
  assert.equal(shouldNotifyPostureNow({ hidden: false, ...ok }), false);
  assert.equal(shouldNotifyPostureNow({ hidden: true, ...ok, enabled: false }), false);
  assert.equal(shouldNotifyPostureNow({ hidden: true, ...ok, permission: "denied" }), false);
});

function fakeEnv(permission, { throwOnCreate = false } = {}) {
  const created = [];
  const env = {
    focused: 0,
    Notification: class {
      static permission = permission;
      constructor(title, opts) {
        if (throwOnCreate) throw new Error("needs SW");
        this.title = title;
        this.opts = opts;
        this.closed = false;
        created.push(this);
      }
      close() { this.closed = true; }
    },
    focus() { env.focused++; },
  };
  return { env, created };
}

test("showSystemNotification crea la notificación y el clic enfoca y cierra", () => {
  const { env, created } = fakeEnv("granted");
  showSystemNotification({ title: "Postava", body: "x", tag: "t", renotify: true }, true, env);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].opts, { body: "x", tag: "t", renotify: true });
  created[0].onclick();
  assert.equal(env.focused, 1);
  assert.equal(created[0].closed, true);
});

test("showSystemNotification: renotify por defecto false", () => {
  const { env, created } = fakeEnv("granted");
  showSystemNotification({ title: "P", body: "b", tag: "t" }, true, env);
  assert.equal(created[0].opts.renotify, false);
});

test("showSystemNotification no hace nada sin soporte, permiso o interruptor", () => {
  const { env, created } = fakeEnv("denied");
  showSystemNotification({ title: "P", body: "b", tag: "t" }, true, env);
  const g = fakeEnv("granted");
  showSystemNotification({ title: "P", body: "b", tag: "t" }, false, g.env);
  assert.doesNotThrow(() => showSystemNotification({ title: "P", body: "b", tag: "t" }, true, {}));
  assert.equal(created.length + g.created.length, 0);
});

test("showSystemNotification ignora errores del constructor", () => {
  const { env } = fakeEnv("granted", { throwOnCreate: true });
  assert.doesNotThrow(() => showSystemNotification({ title: "P", body: "b", tag: "t" }, true, env));
});

test("notifyStatusView: textos por estado", () => {
  assert.deepEqual(notifyStatusView({ supported: false, permission: "default", enabled: true }), {
    unsupported: true,
    text: "Tu navegador no soporta notificaciones del sistema.",
  });
  const v = (permission, enabled) => notifyStatusView({ supported: true, permission, enabled });
  assert.deepEqual(v("granted", false), { unsupported: false, text: "" });
  assert.equal(v("denied", true).text, "Bloqueadas por el navegador; actívalas desde sus ajustes.");
  assert.equal(v("granted", true).text, "Activadas.");
  assert.equal(v("default", true).text, "");
});
