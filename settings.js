/* Persistencia de ajustes en localStorage: solo datos, sin DOM ni lógica del temporizador.
   app.js recoge/aplica los valores de los controles; aquí solo se lee y escribe el JSON.
   `storage` es opcional (por defecto localStorage) y se resuelve dentro del try: en
   algunos navegadores el mero acceso a localStorage lanza. */

export const STORE_KEY = "postava.v1";

export function writeSettings(data, storage) {
  try {
    (storage ?? localStorage).setItem(STORE_KEY, JSON.stringify(data));
  } catch {
    /* modo privado o almacenamiento lleno: seguimos sin persistir */
  }
}

export function readSettings(storage) {
  try {
    return JSON.parse((storage ?? localStorage).getItem(STORE_KEY) || "null");
  } catch {
    return null;
  }
}
