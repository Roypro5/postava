import { loadAuth } from "/assets/auth-adapter.bundle.js";
import { number, computeFatigue, computeScore } from "/stats-math.js";

const $ = (id) => document.getElementById(id);
const state = { days: [], data: null, period: 7 };
let statsLoadInFlight = false;
let statsReloadRequested = false;
let authListenerAdded = false;
const issueLabels = {
  neck: "Cuello",
  shoulders: "Hombros",
  tilt: "Inclinación",
  distance: "Distancia",
};

function redirectToSignIn(reason = "") {
  const suffix = reason ? `&reason=${encodeURIComponent(reason)}` : "";
  location.replace(`/sign-in?redirect=/stats${suffix}`);
}

function showLoadState(message, kind = "loading") {
  const status = $("stats-load-state");
  status.replaceChildren();
  const text = document.createElement("span");
  text.textContent = message;
  status.append(text);
  if (kind === "error") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "stats-retry";
    retry.textContent = "Reintentar";
    retry.addEventListener("click", loadStats);
    status.append(" ", retry);
  }
  status.className = `stats-load-state ${kind}`;
  status.hidden = false;
}

async function loadStats() {
  if (statsLoadInFlight) {
    statsReloadRequested = true;
    return;
  }
  statsLoadInFlight = true;
  showLoadState("Cargando tus estadísticas…");
  try {
    const adapter = await loadAuth();
    const user = await adapter.restore();
    if (!user) {
      redirectToSignIn("session-required");
      return;
    }
    const account = $("stats-account");
    const signOut = $("stats-signout");
    $("stats-user").textContent = user.primaryEmailAddress?.emailAddress || "Sesión iniciada";
    account.hidden = false;
    if (!signOut.dataset.listener) {
      signOut.dataset.listener = "true";
      signOut.addEventListener("click", async () => {
        signOut.disabled = true;
        signOut.textContent = "Cerrando…";
        try {
          await adapter.signOut();
          location.replace("/");
        } catch {
          signOut.disabled = false;
          signOut.textContent = "Reintentar cierre";
        }
      });
    }
    if (!authListenerAdded) {
      authListenerAdded = true;
      adapter.clerk.addListener(({ session }) => {
        if (!session) redirectToSignIn("session-ended");
      });
    }
    const response = await fetch(`/api/stats?days=${state.period}`, { credentials: "same-origin" });
    if (response.status === 401) {
      redirectToSignIn("session-ended");
      return;
    }
    if (!response.ok) throw new Error("No se pudieron cargar tus estadísticas.");
    const data = await response.json();
    state.data = {
      days: Array.isArray(data.days) ? data.days : [],
      habitDistribution: Array.isArray(data.habitDistribution) ? data.habitDistribution : [],
    };
    state.days = state.data.days;
    $("stats-load-state").hidden = true;
    if (!state.days.some((day) => Array.isArray(day.sessions) && day.sessions.length)) {
      showLoadState("Aún no hay sesiones de enfoque completadas. Cuando completes un bloque, tus estadísticas aparecerán aquí.", "empty");
    }
    render();
  } catch {
    showLoadState("No se han podido cargar tus estadísticas. Comprueba la conexión e inténtalo de nuevo.", "error");
  } finally {
    statsLoadInFlight = false;
    if (statsReloadRequested) {
      statsReloadRequested = false;
      loadStats();
    }
  }
}

function activeDays() {
  return state.days;
}

function total(key) {
  return activeDays().reduce((sum, day) => sum + number(day[key]), 0);
}

function localSessionTime(session) {
  if (typeof session.startedAt !== "string") return "—";
  const date = new Date(session.startedAt);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

function formatMinutes(minutes) {
  const safe = Math.round(number(minutes));
  const hours = Math.floor(safe / 60);
  return hours ? `${hours} h ${safe % 60} min` : `${safe} min`;
}

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

/* `tag`: "li" cuando el contenedor es una lista (un <p> dentro de un <ul> no es HTML válido) */
function appendEmpty(container, message, tag = "p") {
  container.replaceChildren(make(tag, "stats-empty", message));
}

function dayName(day) {
  return String(day.label || day.date || "");
}

/* Resumen accesible de una gráfica: una lista visualmente oculta (.sr-only) junto a ella con
   los mismos valores que pinta, porque la gráfica es role="img" y su contenido no se lee.
   Sin días no hay nada que listar: se oculta la lista en lugar de anunciar una vacía. */
function renderSummaryList(id, lines) {
  const list = $(id);
  list.replaceChildren(...lines.map((line) => make("li", "", line)));
  list.hidden = !lines.length;
}

function render() {
  const days = activeDays();
  const focus = days.reduce((sum, day) => sum + number(day.focusMinutes), 0);
  const correct = Math.min(focus, days.reduce((sum, day) => sum + number(day.correctMinutes), 0));
  const measured = Math.min(focus, days.reduce((sum, day) => sum + number(day.measuredMinutes), 0));
  const pomodoros = days.reduce((sum, day) => sum + number(day.pomodoros), 0);
  const score = computeScore(days);

  $("score").textContent = score === null ? "—" : score;
  $("scoreFill").style.width = `${score ?? 0}%`;
  $("scoreNote").textContent = score === null
    ? "Completa una sesión para ver tu puntuación."
    : score >= 85 ? "Un ritmo estable y atento." : "Pequeños ajustes, gran diferencia.";
  $("focusTime").textContent = formatMinutes(focus);
  $("correctTime").textContent = formatMinutes(correct);
  $("pomodoros").textContent = pomodoros;
  $("sessionAvg").textContent = (pomodoros / Math.max(state.period, 1)).toLocaleString("es-ES", { maximumFractionDigits: 1 });
  $("sessionCount").textContent = pomodoros;
  $("distributionTotal").textContent = formatMinutes(measured);

  renderHistogram(days);
  renderDailyBars(days);
  renderSessions(days);
  renderDistribution(measured, correct);
  renderHabits(state.data?.habitDistribution || []);
  renderFatigue(computeFatigue(days));
}

function renderHistogram(days) {
  const container = $("durationHistogram");
  container.replaceChildren();
  const max = Math.max(...days.map((day) => number(day.focusMinutes)), 1);
  days.forEach((day) => {
    const bar = make("i", "histogram-bar");
    bar.style.height = `${number(day.focusMinutes) / max * 100}%`;
    bar.title = `${day.label || day.date || ""}: ${number(day.focusMinutes)} minutos`;
    container.append(bar);
  });
  if (!days.length) appendEmpty(container, "Sin actividad");
  renderSummaryList("durationHistogramSummary", days.map((day) => {
    const minutes = number(day.focusMinutes);
    return `${dayName(day)}: ${minutes} ${minutes === 1 ? "minuto" : "minutos"}`;
  }));
}

function renderDailyBars(days) {
  const container = $("dailyBars");
  container.replaceChildren();
  days.forEach((day) => {
    const hasScore = day.score !== null && Number.isFinite(Number(day.score));
    const score = hasScore ? Math.min(100, number(day.score)) : 0;
    const column = make("div", "daily-column");
    column.append(make("strong", "", hasScore ? score : "—"));
    const bar = make("i");
    const tone = score >= 85 ? "var(--accent)" : score >= 75 ? "var(--warn)" : "var(--bad)";
    bar.style.setProperty("--score", score);
    bar.style.setProperty("--bar-color", tone);
    bar.title = `${day.label || day.date || ""}: Posture Score ${score}`;
    column.append(bar, make("span", "", String(day.label || day.date || "").split(" ")[0]));
    container.append(column);
  });
  if (!days.length) appendEmpty(container, "Sin actividad");
  renderSummaryList("dailyBarsSummary", days.map((day) => {
    const hasScore = day.score !== null && Number.isFinite(Number(day.score));
    return `${dayName(day)}: ${hasScore ? `Posture Score ${Math.min(100, number(day.score))}` : "sin puntuación"}`;
  }));
}

function renderSessions(days) {
  const container = $("sessionsList");
  container.replaceChildren();
  const sessions = days.flatMap((day) =>
    (Array.isArray(day.sessions) ? day.sessions : []).map((session) => ({ ...session, label: day.label || day.date || "" }))
  ).reverse().slice(0, 8);
  sessions.forEach((session) => {
    const row = make("li", "session-row");
    const hasScore = session.score !== null && Number.isFinite(Number(session.score));
    const score = hasScore ? Math.min(100, number(session.score)) : null;
    const state = make("i", `session-state${score === null || score < 85 ? " normal" : ""}`);
    state.setAttribute("aria-hidden", "true");
    const description = make("span");
    description.append(make("strong", "session-time", localSessionTime(session)));
    description.append(make("span", "session-date", session.label));
    row.append(state, description, make("span", "session-duration", `${number(session.minutes)} min`), make("strong", "session-score", score === null ? "—" : `${score}`));
    container.append(row);
  });
  if (!sessions.length) appendEmpty(container, "Tus sesiones completadas aparecerán aquí.", "li");
}

function renderDistribution(focus, correct) {
  const incidentMinutes = Math.max(0, focus - correct);
  const groups = [
    { key: "good", label: "Postura correcta", value: correct },
    { key: "bad", label: "Con incidencias", value: incidentMinutes },
  ];
  const bar = $("distributionBar");
  const legend = $("distributionLegend");
  bar.replaceChildren();
  legend.replaceChildren();
  groups.forEach((group) => {
    const segment = make("i", group.key);
    segment.style.width = `${focus ? group.value / focus * 100 : 0}%`;
    segment.title = `${group.label}: ${Math.round(group.value)} minutos`;
    bar.append(segment);
    const item = make("div", "legend-item");
    const label = make("span");
    const marker = make("i", group.key);
    label.append(marker, document.createTextNode(group.label));
    item.append(label, make("strong", "", `${Math.round(group.value)} min`));
    legend.append(item);
  });
}

function validColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value) ? value : "var(--accent)";
}

function renderHabits(habits) {
  const container = $("habitList");
  container.replaceChildren();
  if (!habits.length) {
    appendEmpty(container, "Sin incidencias registradas.");
    return;
  }
  const max = Math.max(...habits.map((habit) => number(habit.minutes)), 1);
  habits.forEach((habit) => {
    const color = validColor(habit.color);
    const row = make("div", "habit-row");
    const label = make("span", "habit-label");
    const dot = make("i");
    dot.style.backgroundColor = color;
    label.append(dot, document.createTextNode(String(habit.label || issueLabels[habit.key] || "Incidencia")));
    row.append(label, make("span", "habit-value", `${Math.round(number(habit.minutes))} min`));
    const meter = make("span", "habit-meter");
    const fill = make("i");
    fill.style.width = `${number(habit.minutes) / max * 100}%`;
    fill.style.backgroundColor = color;
    meter.append(fill);
    row.append(meter);
    container.append(row);
  });
}

function renderFatigue(items) {
  const container = $("fatigueMap");
  container.replaceChildren();
  if (!items.length) {
    appendEmpty(container, "Aún no hay datos suficientes para estimar la carga.");
    return;
  }
  items.forEach((item) => {
    const value = Math.min(100, number(item.value));
    const cell = make("div", "fatigue-cell");
    cell.style.setProperty("--fatigue", String(value / 2.2));
    cell.title = `Índice de fatiga ${value} sobre 100`;
    cell.append(make("span", "", item.label || ""), make("strong", "", value));
    cell.append(make("small", "", value > 45 ? "Conviene pausar" : value > 30 ? "Carga media" : "Ritmo estable"));
    container.append(cell);
  });
}

document.querySelectorAll(".period").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".period").forEach((item) => {
    item.classList.toggle("active", item === button);
    item.setAttribute("aria-pressed", String(item === button)); // el lector anuncia cuál está activo
  });
  state.period = Number(button.dataset.period) === 30 ? 30 : 7;
  loadStats();
}));

/* Tooltips .info (WCAG 1.4.13, contenido al pasar el ratón o enfocar). Visibles y con el puntero
   permitido encima: lo resuelve stats.css (el aviso recibe el puntero, sin huecos). Descartables:
   Esc oculta el aviso sin mover el foco ni el puntero (clase .tip-dismissed) y vuelve a estar
   disponible cuando el puntero sale y el foco se va. */
function setupTooltips() {
  const tips = new Map([...document.querySelectorAll(".info[data-tip]")].map((tip) => [tip, { hover: false, focus: false }]));
  const release = (tip) => {
    const active = tips.get(tip);
    if (!active.hover && !active.focus) tip.classList.remove("tip-dismissed");
  };
  tips.forEach((active, tip) => {
    tip.addEventListener("mouseenter", () => { active.hover = true; });
    tip.addEventListener("mouseleave", () => { active.hover = false; release(tip); });
    tip.addEventListener("focus", () => { active.focus = true; });
    tip.addEventListener("blur", () => { active.focus = false; release(tip); });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    tips.forEach((active, tip) => {
      if (active.hover || active.focus) tip.classList.add("tip-dismissed");
    });
  });
}
setupTooltips();

loadStats();