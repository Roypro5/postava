// Worker clásico (sin imports): los temporizadores de un Worker no sufren el
// throttling de las pestañas ocultas. Solo emite latidos; el tiempo lo calcula timer.js.
let id = null;
onmessage = ({ data }) => {
  if (id !== null) clearInterval(id);
  id = null;
  // Cadencia acotada a [250, 60000] ms: ni un bucle ocupado ni un latido que no llega.
  if (data && data.ms > 0) id = setInterval(() => postMessage(0), Math.min(60000, Math.max(250, data.ms)));
};
