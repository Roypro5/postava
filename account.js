// Authentication is optional: loading errors must never prevent the timer.
import { loadAuth } from "/assets/auth-adapter.bundle.js";

const link = document.querySelector(".nav-login");
async function mountAccount() {
  if (!link) return;
  try {
    const adapter = await loadAuth();
    const user = await adapter.restore();
    if (!user) return;
    const button = document.createElement("button");
    button.type = "button"; button.className = "nav-login";
    button.textContent = "Cerrar sesión";
    button.title = user.primaryEmailAddress?.emailAddress || "Tu cuenta";
    const label = document.createElement("span");
    label.className = "account-name"; label.dataset.testid = "user-email-display";
    label.textContent = user.primaryEmailAddress?.emailAddress || "Sesión iniciada";
    link.before(label); link.replaceWith(button);
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await adapter.signOut(); location.assign("/"); }
      catch { button.textContent = "Reintentar cierre"; button.disabled = false; }
    });
    adapter.clerk.addListener(({ session }) => {
      if (!session) { label.remove(); button.replaceWith(link); }
    });
  } catch {
    link.title = "Servicio de cuentas no disponible. El Pomodoro sigue funcionando.";
  }
}
mountAccount();