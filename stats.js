import { loadAuth } from "/assets/auth-adapter.bundle.js";

const $ = (id) => document.getElementById(id);
const state = { days: [], data: null, period: 7 };

function redirectToSignIn(reason = "") {
  const suffix = reason ? `&reason=${encodeURIComponent(reason)}` : "";
  location.replace(`/sign-in?redirect=/stats${suffix}`);
}

async function load() {
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
    adapter.clerk.addListener(({ session }) => {
      if (!session) redirectToSignIn("session-ended");
    });
    const response = await fetch("/stats-data.json");
    if (response.status === 401) {
      redirectToSignIn("session-ended");
      return;
    }
    if (!response.ok) throw new Error("No se pudieron cargar los datos");
    state.data = await response.json();
    state.days = state.data.days;
    render();
  } catch (error) {
    document.querySelector("main").innerHTML = `<section class="card stats-error"><p class="eyebrow">Estadísticas</p><h1>No se han podido cargar</h1><p>Comprueba tu conexión y recarga para intentarlo de nuevo.</p><a class="nav-login" href="/">Volver al temporizador</a></section>`;
  }
}

function activeDays() {
  return state.period === 7 ? state.days.slice(-7) : state.days;
}

function total(key) {
  return activeDays().reduce((sum, day) => sum + day[key], 0);
}

function formatMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

function render() {
  const days = activeDays();
  const focus = total("focusMinutes");
  const correct = total("correctMinutes");
  const score = Math.round(days.reduce((sum, day) => sum + day.score, 0) / days.length);
  const pomodoros = total("pomodoros");

  $("score").textContent = score;
  $("scoreFill").style.width = `${score}%`;
  $("scoreNote").textContent = score >= 85 ? "Un ritmo estable y atento." : "Pequeños ajustes, gran diferencia.";
  $("focusTime").textContent = formatMinutes(focus);
  $("correctTime").textContent = formatMinutes(correct);
  $("pomodoros").textContent = pomodoros;
  $("sessionAvg").textContent = (pomodoros / days.length).toLocaleString("es-ES", { maximumFractionDigits: 1 });
  $("sessionCount").textContent = pomodoros;
  $("distributionTotal").textContent = formatMinutes(focus);

  renderHistogram(days);
  renderDailyBars(days);
  renderSessions(days);
  renderDistribution(days, focus, correct);
  renderHabits(state.data.habitDistribution || []);
  renderFatigue(state.data.fatigue || []);
}

function renderHistogram(days) {
  const max = Math.max(...days.map((day) => day.focusMinutes), 1);
  $("durationHistogram").innerHTML = days.map((day) => `<i class="histogram-bar" style="height:${day.focusMinutes / max * 100}%" title="${day.label}: ${day.focusMinutes} minutos"></i>`).join("");
}

function renderDailyBars(days) {
  $("dailyBars").innerHTML = days.map((day) => {
    const tone = day.score >= 85 ? "var(--accent)" : day.score >= 75 ? "var(--warn)" : "var(--bad)";
    return `<div class="daily-column"><strong>${day.score}</strong><i style="--score:${day.score};--bar-color:${tone}" title="${day.label}: Posture Score ${day.score}"></i><span>${day.label.split(" ")[0]}</span></div>`;
  }).join("");
}

function renderSessions(days) {
  const sessions = days.flatMap((day) => day.sessions.map((session) => ({ ...session, label: day.label }))).reverse().slice(0, 8);
  $("sessionsList").innerHTML = sessions.map((session) => {
    const stateClass = session.score >= 85 ? "good" : "normal";
    return `<div class="session-row"><i class="session-state ${stateClass}" aria-hidden="true"></i><span><strong class="session-time">${session.start}</strong><span class="session-date">${session.label}</span></span><span class="session-duration">${session.minutes} min</span><strong class="session-score">${session.score}</strong></div>`;
  }).join("");
}

function renderDistribution(days, focus, correct) {
  const incidents = focus - correct;
  const good = Math.round(correct * .76);
  const normal = Math.round(correct * .24);
  const bad = incidents;
  const sum = good + normal + bad;
  const groups = [
    { key: "good", label: "Good", value: good },
    { key: "normal", label: "Normal", value: normal },
    { key: "bad", label: "Bad", value: bad },
  ];
  $("distributionBar").innerHTML = groups.map((group) => `<i class="${group.key}" style="width:${group.value / sum * 100}%" title="${group.label}: ${group.value} minutos"></i>`).join("");
  $("distributionLegend").innerHTML = groups.map((group) => `<div class="legend-item"><span><i class="${group.key}"></i>${group.label}</span><strong>${group.value} min</strong></div>`).join("");
}

function renderHabits(habits) {
  const totalMinutes = habits.reduce((sum, habit) => sum + habit.minutes, 0) || 1;
  $("habitList").innerHTML = habits.map((habit) => `<div class="habit-row"><span class="habit-label"><i style="background:${habit.color}"></i>${habit.label}</span><span class="habit-value">${habit.minutes} min</span><span class="habit-meter"><i style="width:${habit.minutes / totalMinutes * 100}%;background:${habit.color}"></i></span></div>`).join("");
}

function renderFatigue(items) {
  $("fatigueMap").innerHTML = items.map((item) => `<div class="fatigue-cell" style="--fatigue:${item.value / 2.2}" title="Índice de fatiga ${item.value} sobre 100"><span>${item.label}</span><strong>${item.value}</strong><small>${item.value > 45 ? "Conviene pausar" : item.value > 30 ? "Carga media" : "Ritmo estable"}</small></div>`).join("");
}

document.querySelectorAll(".period").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".period").forEach((item) => item.classList.toggle("active", item === button));
  state.period = Number(button.dataset.period);
  if (state.data) render();
}));

load();