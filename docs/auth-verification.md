# Verificación y arquitectura de autenticación en Postava

Este documento consolida las decisiones clave de arquitectura, seguridad y pruebas de autenticación derivadas de la integración con Clerk y las lecciones aprendidas durante su verificación.

---

## 1. Aislamiento estricto de la autenticación respecto al Pomodoro de invitado

### Decisión
El temporizador Pomodoro y la detección de postura en tiempo real mediante visión artificial se ejecutan enteramente en Vanilla JavaScript en el navegador y **no dependen de ninguna sesión autenticada ni de React**.

### Motivo
- **Uso anónimo garantizado (Regla 2 de `AGENTS.md`):** La funcionalidad central de Postava (temporizador, calibración y corrección de postura con MediaPipe) debe funcionar sin cuenta de usuario, sin conectividad hacia Clerk y aunque la CDN externa o el servicio de autenticación sufran una interrupción.
- Separar la interfaz de la cuenta del núcleo del Pomodoro evita acoplar el bucle de render (`requestAnimationFrame`), el Web Worker de tiempo (`tick-worker.js`) y el procesamiento local de vídeo con librerías pesadas de interfaz o SDKs con estado de sesión.

### Directrices de aplicación
1. El bundle de autenticación (`/assets/auth-adapter.bundle.js`) se importa de forma dinámica o desde scripts independientes (`account.js`, `login.js`, `stats.js`), asegurando que un fallo en su carga nunca impida el funcionamiento de `app.js`.
2. Las rutas públicas y el temporodoro permanecen disponibles para invitados; únicamente el guardado y visualización de estadísticas históricas (`/stats`, `POST /api/stats/sessions`, `GET /api/stats`) exigen autenticación.

---

## 2. Doble validación: Sesión de Clerk y Cookie de Presencia

### Decisión
Toda ruta privada del servidor (`/api/auth/session`, `/api/account`, `/api/stats`, `/api/stats/sessions` y `/stats`) exige **tanto** un token de sesión válido de Clerk **como** una cookie de presencia firmada (`server/session-cookie.mjs`).

### Mecanismo
- **Cookie de presencia:** Se genera al iniciar sesión (`POST /api/auth/session`). Es `HttpOnly`, `Secure`, `SameSite=Lax` y va firmada mediante HMAC-SHA256 con la variable de entorno `SESSION_SECRET`.
  - Si el usuario no marca «Recordarme»: se emite como cookie de sesión del navegador.
  - Si el usuario marca «Recordarme»: se emite con una validez de hasta 30 días, sujeta a la expiración de la sesión en Clerk.
  - Browsers that restore sessions may also restore session cookies; users of shared computers must explicitly sign out (los usuarios de equipos compartidos deben cerrar sesión explícitamente).
- **Sin tokens de portador explícitos:** Las peticiones del cliente son estrictamente de mismo origen (`same-origin`) y basadas en cookies. En `server.mjs`, se elimina cualquier cabecera `Authorization` entrante antes del middleware de Clerk para evitar que machine tokens o llamadas a analíticas de terceros interfieran con la verificación de cookies del servidor.
- **Identidad derivada exclusivamente en el servidor (Regla 3 de `AGENTS.md`):** El `user_id` para consultar o persistir estadísticas se obtiene únicamente del contexto verificado de Clerk en el backend, nunca de parámetros de consulta, cuerpos de petición o cabeceras suministradas por el cliente.

---

## 3. Vinculación de bloques de enfoque a la cuenta de inicio (`bindFocusAccount`)

### Decisión
Un bloque de enfoque se vincula a la cuenta que estaba presente en el momento exacto en que se inició el temporizador (`bindFocusAccount`). Dicha vinculación se mantiene constante a lo largo de toda la sesión de enfoque y durante cualquier reintento posterior de envío.

### Motivo
- **Evitar mezcla de cuentas (cross-account attribution):** Si la verificación de la cuenta activa se realizara únicamente al finalizar el bloque de enfoque o justo antes del envío a la API, un cambio de cuenta en otra pestaña del navegador provocaría que las métricas de postura y tiempo de una persona se guardaran erróneamente en el perfil de otra.
- **Invarianza de bloques de invitado:** Si un bloque se inicia como invitado, permanece como bloque de invitado y nunca se enviará al servidor, incluso si el usuario inicia sesión a mitad del intervalo.

### Directrices de aplicación
1. `stats-session.js` captura la identidad de la cuenta al inicio del bloque.
2. `stats-queue.js` persiste las colas de envíos pendientes en `localStorage` con claves particionadas por cuenta (`postava.stats.pending.v2:<account>`).
3. El endpoint `POST /api/stats/sessions` compara la cuenta esperada del bloque con el `user_id` autenticado en la sesión actual; si difieren, la petición se rechaza para impedir colisiones o reintentos cruzados.

---

## 4. Import dinámico y lazy del SDK de Clerk en tests de Node

### Decisión
En los tests unitarios ejecutados bajo el ejecutable de Node (`node --test tests/*.test.mjs`), el SDK de navegador de Clerk se mantiene detrás de importaciones dinámicas (`lazy import()`) o dobles de prueba inyectados.

### Motivo
- **Procesos colgados por import impaciente:** Cargar impacientemente (`eager import`) `@clerk/clerk-js` o módulos de navegador afines dentro del entorno de Node provoca que timers o conexiones internas del SDK mantengan el bucle de eventos (`event loop`) activo indefinidamente tras pasar todas las aserciones, provocando que la suite de pruebas expire por timeout.
- Aislar el SDK permite que las pruebas de adaptadores y lógica de servidor se ejecuten en milisegundos sin efectos secundarios en el runtime.

---

## 5. Estrategia y límites de las pruebas de autenticación

### Separación de entornos de prueba
1. **Pruebas unitarias de Node (`npm test`):**
   - Comprueban la lógica de derivación de sesiones, cookies HMAC, rechazo de identidades cruzadas y agregación de métricas sin tocar la red ni instanciar proveedores reales.
2. **Pruebas de interfaz locales Playwright (`npm run test:ui`):**
   - Se ejecutan con claves simuladas y `POSTAVA_MOCK_CLERK=1` (o interceptación de rutas hacia dominios de prueba).
   - Validan el comportamiento de formularios, validaciones de interfaz, redirecciones de invitados (`/stats` redirige al inicio de sesión) y flujos anónimos sin realizar llamadas a la infraestructura real de Clerk.
3. **Verificación en vivo con Clerk:**
   - La entrega real de correos de verificación o restablecimiento de contraseña y la persistencia de sesión a través de múltiples aperturas del navegador solo pueden verificarse en un entorno manual autorizado con cuentas de desarrollo específicas. Ningún test automatizado debe crear cuentas externas reales ni disparar correos (Regla 7 de `AGENTS.md`).
   - Las discrepancias observadas al capturar pantallas en contextos locales aislados (bucles aparentes de sesión) deben contrastarse siempre en un navegador con contexto completo en el dominio de desarrollo antes de modificar configuraciones de claves o certificados.

---

## 6. Agregados, límites diarios y retención en base de datos

- **Métricas agregadas:** El vídeo y los landmarks nunca salen del navegador (Regla 1 de `AGENTS.md`). Al servidor únicamente llegan agregados redondeados: duración en minutos, tiempo con postura correcta/medida, conteo de avisos e incidencias agrupadas.
- **Agrupación temporal en UTC:** Todas las estadísticas se guardan y agregan en días del calendario UTC según la marca temporal `started_at` de la sesión.
- **Límite diario blando:** Cada cuenta permite un máximo de 200 sesiones y 1440 minutos de enfoque por día UTC. Excedido el límite, el endpoint responde con `422 DAILY_LIMIT_REACHED`. Los reintentos de sesiones ya guardadas son idempotentes y devuelven `200`.
- **Eliminación y retención:**
  - `DELETE /api/stats` permite al usuario autenticado purgar de forma inmediata todas sus sesiones registradas.
  - El mantenimiento a nivel de base de datos se realiza mediante scripts manuales (`db/purge-old.sql` para sesiones superiores a 400 días y `db/delete-user.sql` para bajas de usuarios en Clerk).