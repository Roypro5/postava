// Latido del temporizador sin DOM. Usa un Worker (sus temporizadores no se
// ralentizan con la pestaña oculta) y, si no se puede crear o falla, cae a
// setInterval. Todo es inyectable para poder probarlo sin navegador.
//   createWorker() -> Worker-like { postMessage, terminate, onmessage, onerror }
//   setRate(ms)    -> cambia la cadencia (la primera llamada arranca el latido)
//   stop()         -> detiene todo; un setRate posterior lo vuelve a arrancar
export function createHeartbeat({ createWorker, setInterval, clearInterval, onBeat }) {
  let worker = null;
  let fallbackId = null;
  let usingFallback = false;
  let rate = 0;

  const startFallback = () => {
    usingFallback = true;
    if (fallbackId !== null) clearInterval(fallbackId);
    fallbackId = rate > 0 ? setInterval(onBeat, rate) : null;
  };

  const dropWorker = () => {
    const current = worker;
    worker = null;
    if (!current) return;
    current.onmessage = null;
    current.onerror = null;
    try {
      current.terminate();
    } catch {
      /* ya muerto */
    }
  };

  const startWorker = () => {
    try {
      const created = createWorker();
      created.onmessage = () => {
        if (created === worker) onBeat();
      };
      created.onerror = () => {
        if (created !== worker) return;
        dropWorker();
        startFallback();
      };
      worker = created;
      created.postMessage({ ms: rate });
    } catch {
      dropWorker();
      startFallback();
    }
  };

  return {
    setRate(ms) {
      rate = ms;
      if (worker) worker.postMessage({ ms });
      else if (usingFallback) startFallback();
      else startWorker();
    },
    stop() {
      if (worker) {
        try {
          worker.postMessage("stop");
        } catch {
          /* ignorar */
        }
        dropWorker();
      }
      if (fallbackId !== null) clearInterval(fallbackId);
      fallbackId = null;
      usingFallback = false;
    },
  };
}
