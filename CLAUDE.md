# Postava — Contrato de Desarrollo y Guía de Agentes

Este archivo es la guía para **Claude Code**. Describe el catálogo de subagentes especializados disponibles en `.claude/agents/` y el flujo de trabajo recomendado para el desarrollo.

> **Fuente única de verdad:** Las reglas del proyecto, los límites entre módulos, el entorno y los comandos están centralizados exclusivamente en [`AGENTS.md`](AGENTS.md). Para la visión general, la arquitectura técnica y el mapa de módulos, consulta el [`README.md`](README.md). Cualquier cambio en las reglas debe realizarse exclusivamente en `AGENTS.md`.

---

## 1. Visión y Arquitectura del Proyecto

Para la descripción general del proyecto, el stack tecnológico, los ficheros y el mapa de dependencias entre módulos, consulta directamente el [`README.md`](README.md):

- [Requisitos y Puesta en marcha](README.md#requisitos)
- [Cómo funciona la detección de postura](README.md#cómo-funciona-la-detección)
- [Cuentas, estadísticas y privacidad](README.md#cuentas-y-estadísticas-opcional)
- [Ficheros del proyecto](README.md#ficheros)
- [Dependencias entre módulos del cliente](README.md#dependencias-entre-módulos)
- [Notas de diseño](README.md#notas-de-diseño)

---

## 2. Reglas Inquebrantables y Límites de Módulos

[`AGENTS.md`](AGENTS.md) es la **única fuente de verdad** para las reglas del proyecto. No se duplican aquí para evitar discrepancias:

- [Reglas que no se negocian](AGENTS.md#reglas-que-no-se-negocian) (privacidad de la cámara, uso anónimo garantizado, identidad en servidor, doble validación, allowlist estricta, cero DDL al arrancar, tests sin cuentas reales, CSP y gestión de secretos).
- [Límites entre módulos del cliente](AGENTS.md#límites-entre-módulos-del-cliente) (aislamiento de DOM, responsabilidades de `ui.js` y `stats-queue.js`, inyección lateral e imports dinámicos para tolerancia a fallos).
- [Cuándo una tarea está terminada](AGENTS.md#cuándo-una-tarea-está-terminada) (criterios de aceptación verificables).
- [Lo que exige permiso explícito del usuario](AGENTS.md#lo-que-exige-permiso-explícito-del-usuario) (acciones restringidas).

---

## 3. Comandos Habituales y Entorno

El entorno de ejecución y los comandos de desarrollo se definen en [`AGENTS.md`](AGENTS.md):

- [Entorno de desarrollo](AGENTS.md#entorno-windows-de-esta-máquina) (Node ≥ 22.15 en Windows, PowerShell y ejecutables `.cmd`).
- [Comandos](AGENTS.md#comandos) (`npm start`, `npm run lint`, `npm test`, `npm run test:ui`, `npm run start:prod`).
- [Detalles de pruebas y variables de entorno](README.md#tests) en el README.

---

## 4. Matriz de Subagentes Disponibles (`.claude/agents/`)

Usa o convoca a estos agentes según la naturaleza de la tarea:

### 🧠 Planificación y Arquitectura
- **`@planificador`**: Descompone objetivos complejos en planes atómicos priorizados (P0 a P3), asignando a cada tarea el modelo adecuado (Opus para pensar, Sonnet/Haiku para ejecutar).
- **`@product-manager`**: Define hojas de ruta (roadmaps), historias de usuario y criterios de aceptación verificables a partir de ideas de vibecoding.
- **`@architect-reviewer`**: Evalúa decisiones macro, límites entre módulos, acoplamiento cliente-servidor y reduce la deuda técnica estructural.

### 🛠️ Refactorización y Mejora
- **`@refactoring-specialist`**: Mantiene cohesivos y desacoplados los módulos del cliente (la extracción principal de `app.js` ya está hecha: hoy son cerca de 600 líneas de cableado) y divide cualquier archivo que vuelva a crecer, sin alterar el comportamiento observable.
- **`@performance-engineer`**: Optimiza el bucle de renderizado en Canvas, `requestAnimationFrame`, uso de memoria de MediaPipe/cámara y previene Memory Leaks.
- **`@security-auditor`**: Audita la seguridad de endpoints, cookies de sesión, tokens de Clerk, allowlist y consultas SQL (solo lectura).

### 💻 Desarrollo e Implementación
- **`@dev-postava`**: Desarrollador general del proyecto. Conoce a fondo la integración entre timer, MediaPipe y Clerk.
- **`@frontend-developer`**: Especialista en Vanilla JS (ESM), diseño responsive, ergonomía visual y CSS3.
- **`@postgres-pro`**: Modelado relacional, consultas SQL optimizadas e índices para la persistencia de estadísticas.

### 🧪 Calidad y Pruebas
- **`@test-automator`**: Crea y amplía tests unitarios (`node:test`) y pruebas E2E con Playwright (`tests/*.spec.mjs`).
- **`@revisor-proyectos`**: Revisión crítica de código post-implementación para detectar bugs, casos borde y legibilidad.

---

> **Antigravity:** usa [`AGENTS.md`](AGENTS.md) y sus propios subagentes en `.agents/agents/`. El plan en curso está en [`docs/antigravity/PLAN.md`](docs/antigravity/PLAN.md); si trabajas con Claude Code sobre una tarea de ese plan, marca su casilla en la tabla de seguimiento. Recuerda que [`AGENTS.md`](AGENTS.md) es la única fuente de verdad para las reglas del proyecto.

## 5. Flujo de Trabajo Recomendado (De Vibecoding a Código Robusto)

1. **Antes de construir una función grande:**
   - Invoca a `@product-manager` para aterrizar el requerimiento.
   - Invoca a `@planificador` o `@architect-reviewer` para diseñar la estructura sin romper lo existente.
2. **Durante la implementación:**
   - Si se trata de módulos o UI, usa `@dev-postava` o `@frontend-developer`.
   - Si se divide un archivo grande, usa `@refactoring-specialist`.
3. **Antes de dar por cerrado un cambio:**
   - Añade cobertura con `@test-automator`.
   - Corre `npm test`.
   - Pide revisión a `@revisor-proyectos` o `@security-auditor`.
