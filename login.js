import { isConfiguredAdapter, unconfiguredAuthAdapter } from "./auth-adapter.js";

export function mountLogin(doc = document, adapter = unconfiguredAuthAdapter) {
  const form = doc.querySelector("#login-form");
  if (!form) return null;
  const email = doc.querySelector("#login-email");
  const password = doc.querySelector("#login-password");
  const remember = doc.querySelector("#remember-me");
  const submit = doc.querySelector("#login-submit");
  const toggle = doc.querySelector("#password-toggle");
  const status = doc.querySelector("#login-status");
  const loader = doc.querySelector(".button-loader");
  const copy = doc.querySelector(".button-copy");
  let busy = false;

  const setError = (field, message) => {
    const error = doc.getElementById(field.getAttribute("aria-describedby"));
    field.setAttribute("aria-invalid", String(Boolean(message)));
    error.textContent = message || "";
  };
  const clearErrors = () => [email, password].forEach((field) => setError(field, ""));
  const setBusy = (value) => {
    form.setAttribute("aria-busy", String(value));
    busy = value; submit.disabled = value; loader.hidden = !value; copy.textContent = value ? "Comprobando acceso" : "Iniciar sesión";
  };
  const explainUnavailable = () => {
    status.textContent = "El acceso a cuentas aún no está disponible. Postava sigue funcionando sin iniciar sesión.";
  };

  toggle.addEventListener("click", () => {
    const shown = password.type === "text";
    password.type = shown ? "password" : "text";
    toggle.setAttribute("aria-pressed", String(!shown));
    toggle.firstChild.textContent = shown ? "Mostrar" : "Ocultar";
  });
  [email, password].forEach((field) => field.addEventListener("input", () => setError(field, "")));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    clearErrors(); status.textContent = "";
    let firstInvalid = null;
    if (!email.validity.valid) { setError(email, "Escribe un correo electrónico válido."); firstInvalid = email; }
    if (!password.value) { setError(password, "Escribe tu contraseña."); firstInvalid ||= password; }
    if (firstInvalid) { firstInvalid.focus(); return; }
    if (!isConfiguredAdapter(adapter)) { explainUnavailable(); return; }
    setBusy(true);
    try {
      await adapter.signIn({ email: email.value, password: password.value, remember: remember.checked });
      status.textContent = "No se ha configurado una continuación de sesión.";
    } catch (error) {
      status.textContent = error?.message === "AUTH_UNAVAILABLE" ? "El acceso a cuentas no está disponible." : "No se pudo iniciar sesión. Revisa tus datos e inténtalo de nuevo.";
    } finally {
      setBusy(false);
    }
  });
  submit.disabled = false;
  return { destroy() { submit.disabled = true; form.replaceWith(form.cloneNode(true)); } };
}

if (typeof document !== "undefined") mountLogin(document);