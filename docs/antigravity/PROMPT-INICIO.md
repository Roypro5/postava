# Prompt de arranque para Antigravity

Abre la carpeta del proyecto en Antigravity, inicia una conversación nueva con el agente
(modo *Planning*, con el modelo más capaz disponible) y pega el bloque de abajo.

Para las sesiones siguientes, usa el [prompt corto de continuación](#prompt-de-continuación).

---

```text
Vas a retomar el desarrollo de Postava (Pomodoro con corrección de postura en el
navegador). Trabaja en español.

CONTEXTO, léelo entero antes de hacer nada:
1. AGENTS.md: reglas que no se negocian, entorno de Windows y cuándo una tarea está terminada.
2. docs/antigravity/AUDITORIA.md: estado del proyecto y hallazgos A1–A14.
3. docs/antigravity/PLAN.md: plan por fases con tareas, subagentes, criterios de
   «hecho cuando» y puertas ⛔.
4. README.md: arquitectura, módulos, variables de entorno y tests.

QUÉ TIENES QUE HACER:
- Empieza por la Fase 0. En T0.2, instala los subagentes: crea .agents/agents/<nombre>.md
  portando los 11 de .claude/agents/ con la tabla de modelos y herramientas del plan.
  Antes de escribir los nombres de herramientas, compruébalos contra las herramientas
  que tienes de verdad (un nombre mal escrito cuelga el subagente). No toques .claude/.
- Luego sigue el plan en orden. Para cada tarea delega en el subagente indicado con
  invoke_subagent, verifica con los comandos de la tarea, haz que revisor-proyectos
  revise el diff y haz un commit por tarea con el ID en el mensaje.
- Actualiza la tabla «Seguimiento» de PLAN.md al cerrar cada tarea (estado, hash del
  commit y nota breve). Ese fichero es la memoria del proyecto entre sesiones.

LÍMITES:
- Para en cada puerta ⛔ y en cada tarea marcada ⛔. Muéstrame un resumen (qué cambió,
  salida de npm test y npm run test:ui, riesgos) y espera mi OK.
- No hagas push, no abras ni mergees PRs, no borres ficheros fuera de la tarea y no
  toques la base de datos real ni las claves de Clerk sin que te lo diga en este chat.
- Si un test falla y no es por tu cambio, no lo «arregles» debilitando el servidor:
  para e informa. Para A1 sigue exactamente las opciones permitidas en T1.1.
- Nunca uses git add -A: añade solo los ficheros de la tarea. Hay ficheros personales
  en la raíz que no deben entrar en commits.
- Si algo del plan contradice AGENTS.md, gana AGENTS.md y me lo avisas.

PRIMER ENTREGABLE: completa T0.1, T0.2 y T0.3 y para en la puerta F0. Antes, en un
artifact de plan, dime qué subagentes creaste (con modelo y herramientas) y el
resultado de la línea base de tests.
```

---

## Prompt de continuación

Para cada sesión nueva, después de darle el OK de una puerta:

```text
Retoma Postava. Lee AGENTS.md y la tabla «Seguimiento» de docs/antigravity/PLAN.md, y
continúa con la siguiente tarea pendiente. Sigue las mismas reglas: un commit por tarea,
revisor-proyectos sobre cada diff y parar en cada ⛔.
Te doy OK para: <puerta o tarea aprobada, p. ej. "push de la rama de la fase 1 y abrir PR">.
```

## Consejos de uso

- **Revisa los artifacts.** Antigravity muestra el plan y el diff de cada paso como
  artifacts: coméntalos ahí para corregir el rumbo sin reiniciar la conversación.
- **Si se atasca con un subagente,** pídele que muestre el fichero
  `.agents/agents/<nombre>.md` y la lista real de herramientas que tiene disponibles.
- **Claude Code sigue sirviendo** para el mismo repo: lee `CLAUDE.md` y
  `.claude/agents/`. No trabajes con los dos agentes a la vez sobre la misma rama.
