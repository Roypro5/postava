import { loadAuth, authError } from "/assets/auth-adapter.bundle.js";

export async function mountLogin(doc = document, providedAdapter) {
  const form = doc.querySelector("#login-form");
  if (!form) return;
  const email = doc.querySelector("#login-email");
  const password = doc.querySelector("#login-password");
  const code = doc.querySelector("#login-code");
  const remember = doc.querySelector("#remember-me");
  const submit = doc.querySelector("#login-submit");
  const status = doc.querySelector("#login-status");
  const resend = doc.querySelector("#resend-code");
  const modeFromURL = () => location.pathname.startsWith("/sign-up") || location.hash === "#register" ? "register" : location.hash === "#recovery" ? "recovery" : "login";
  let mode = modeFromURL(), busy = false, adapter;
  let resendAfter = 0;
  const labels = { login: ["Bienvenido de nuevo", "Iniciar sesión"], register: ["Crea tu cuenta", "Crear cuenta"], recovery: ["Recupera tu acceso", "Enviar código"], "verify-email": ["Verifica tu correo", "Verificar correo"], "reset-code": ["Elige una nueva contraseña", "Cambiar contraseña"], "second-factor": ["Verifica tu acceso", "Verificar código"], "first-factor": ["Verifica tu acceso", "Verificar código"], "new-password": ["Renueva tu contraseña", "Guardar contraseña"] };
  const setError = (field, message = "") => {
    field.setAttribute("aria-invalid", String(!!message));
    doc.getElementById(field.getAttribute("aria-describedby")).textContent = message;
  };
  function render() {
    const hasEmail = ["login", "register", "recovery"].includes(mode);
    const hasPassword = ["login", "register", "reset-code", "new-password"].includes(mode);
    const hasCode = ["verify-email", "reset-code", "second-factor", "first-factor"].includes(mode);
    email.closest(".login-field").hidden = !hasEmail;
    password.closest(".login-field").hidden = !hasPassword;
    code.closest(".login-field").hidden = !hasCode;
    email.disabled = !hasEmail || busy; password.disabled = !hasPassword || busy; code.disabled = !hasCode || busy;
    password.autocomplete = mode === "login" ? "current-password" : "new-password";
    remember.closest(".remember").hidden = !hasPassword;
    remember.disabled = busy;
    resend.hidden = !hasCode; resend.disabled = busy;
    doc.querySelector("#login-title").textContent = labels[mode][0];
    doc.querySelector(".button-copy").textContent = busy ? "Procesando…" : labels[mode][1];
    doc.querySelector(".button-loader").hidden = !busy;
    submit.disabled = busy || !adapter;
    form.setAttribute("aria-busy", String(busy));
  }
  doc.querySelector("#password-toggle").addEventListener("click", (event) => {
    const shown = password.type === "text";
    password.type = shown ? "password" : "text";
    event.currentTarget.setAttribute("aria-pressed", String(!shown));
    event.currentTarget.firstChild.textContent = shown ? "Mostrar" : "Ocultar";
  });
  [email, password, code].forEach(field => field.addEventListener("input", () => setError(field)));
  window.addEventListener("hashchange", () => {
    if (busy) return;
    mode = modeFromURL(); password.value = ""; code.value = ""; status.textContent = "";
    [email, password, code].forEach(field => setError(field));
    render(); email.focus();
  });
  resend.addEventListener("click", async () => {
    if (busy) return;
    if (Date.now() < resendAfter) { status.textContent = "Espera un minuto antes de solicitar otro código."; return; }
    busy = true; render();
    try { await adapter.resend(mode); resendAfter = Date.now() + 60_000; status.textContent = "Se ha solicitado un nuevo código. Revisa también el correo no deseado."; }
    catch (error) { status.textContent = authError(error); }
    finally { busy = false; render(); }
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !adapter) return;
    [email, password, code].forEach(field => setError(field));
    let invalid;
    if (!email.disabled && !email.validity.valid) { setError(email, "Escribe un correo electrónico válido."); invalid = email; }
    if (!password.disabled && (!password.value || (mode !== "login" && password.value.length < 8))) { setError(password, mode === "login" ? "Escribe tu contraseña." : "Usa al menos 8 caracteres."); invalid ||= password; }
    if (!code.disabled && !code.value.trim()) { setError(code, "Escribe el código de verificación."); invalid ||= code; }
    if (invalid) { invalid.focus(); return; }
    const values = { email: email.value.trim(), password: password.value, remember: remember.checked };
    busy = true; status.textContent = ""; render();
    try {
      let result;
      if (mode === "login") result = await adapter.signIn(values);
      else if (mode === "register") result = await adapter.signUp(values);
      else if (mode === "recovery") result = await adapter.recover(values.email);
      else if (mode === "verify-email") result = await adapter.verifyEmail(code.value.trim());
      else if (mode === "reset-code") result = await adapter.reset(code.value.trim(), values.password, values.remember);
      else if (mode === "new-password") result = await adapter.newPassword(values.password, values.remember);
      else result = await adapter.verifyFactor(code.value.trim(), mode === "first-factor");
      password.value = ""; code.value = "";
      if (result.step === "complete") { location.assign("/"); return; }
      mode = result.step;
      status.textContent = mode === "new-password" ? "Elige una contraseña segura."
        : result.strategy === "totp" ? "Escribe el código de tu aplicación de autenticación."
        : result.strategy === "backup_code" ? "Escribe uno de tus códigos de respaldo."
        : mode === "reset-code" ? "Si existe una cuenta con ese correo, recibirás un código para recuperar el acceso."
        : "Introduce el código enviado a tu correo o teléfono.";
    } catch (error) {
      // Do not disclose whether a recovery address exists.
      if (mode === "recovery" && error?.errors?.[0]?.code === "form_identifier_not_found") {
        mode = "reset-code";
        status.textContent = "Si existe una cuenta con ese correo, recibirás un código para recuperar el acceso.";
      } else status.textContent = authError(error);
      password.value = "";
    } finally { busy = false; render(); }
  });
  render();
  try {
    adapter = providedAdapter || await loadAuth();
    const user = await adapter.restore();
    if (user) { location.replace("/"); return; }
    status.textContent = "Puedes seguir usando el Pomodoro sin cuenta.";
  } catch {
    adapter = null;
    status.textContent = "No se pudo conectar con el servicio de cuentas. Recarga la página para reintentar. El Pomodoro sigue disponible sin cuenta.";
  }
  render();
}

if (typeof document !== "undefined") mountLogin();