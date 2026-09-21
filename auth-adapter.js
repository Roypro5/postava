// Passwords only travel to Clerk over HTTPS. Persistence belongs to cookies,
// never localStorage/sessionStorage. The extra server cookie enforces Recordarme.
export function createAuthAdapter(clerk, request = fetch) {
  let remember = false;
  let secondFactor;
  let recoveryStarted = false;
  let recoveryFactor;
  async function sessionRequest(method, body) {
    const response = await request("/api/auth/session", {
      method, credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error("SESSION_UNAVAILABLE");
    return response;
  }
  async function finish(result) {
    if (result.status === "complete" && result.createdSessionId) {
      await clerk.setActive({ session: result.createdSessionId });
      try {
        await sessionRequest("POST", { remember });
      } catch (error) {
        await clerk.signOut();
        throw error;
      }
      return { step: "complete" };
    }
    if (result.status === "needs_second_factor") {
      secondFactor = result.supportedSecondFactors.find(f => ["email_code", "phone_code", "totp", "backup_code"].includes(f.strategy));
      if (!secondFactor) throw new Error("UNSUPPORTED_FACTOR");
      if (["email_code", "phone_code"].includes(secondFactor.strategy)) {
        await result.prepareSecondFactor(secondFactor);
      }
      return { step: "second-factor", strategy: secondFactor.strategy };
    }
    if (result.status === "needs_first_factor") {
      const factor = result.supportedFirstFactors.find(f => f.strategy === "email_code");
      if (factor) {
        await result.prepareFirstFactor(factor);
        return { step: "first-factor" };
      }
    }
    if (result.status === "needs_new_password") return { step: "new-password" };
    throw new Error("INCOMPLETE_ACCOUNT");
  }
  return {
    configured: true,
    clerk,
    async restore() {
      if (!clerk.session) return null;
      const response = await request("/api/auth/session", { credentials: "same-origin" });
      if (response.status === 401) { await clerk.signOut(); return null; }
      if (!response.ok) throw new Error("SESSION_UNAVAILABLE");
      return clerk.user;
    },
    async signIn(values) {
      remember = values.remember;
      return finish(await clerk.client.signIn.create({ identifier: values.email, password: values.password }));
    },
    async signUp(values) {
      remember = values.remember;
      const result = await clerk.client.signUp.create({ emailAddress: values.email, password: values.password });
      if (result.status === "complete") return finish(result);
      await result.prepareEmailAddressVerification({ strategy: "email_code" });
      return { step: "verify-email" };
    },
    async verifyEmail(code) {
      return finish(await clerk.client.signUp.attemptEmailAddressVerification({ code }));
    },
    async recover(email) {
      recoveryStarted = false;
      recoveryFactor = undefined;
      const result = await clerk.client.signIn.create({ strategy: "reset_password_email_code", identifier: email });
      recoveryFactor = result.supportedFirstFactors?.find(f => f.strategy === "reset_password_email_code");
      recoveryStarted = true;
      return { step: "reset-code" };
    },
    async reset(code, password, persistent) {
      if (!recoveryStarted) throw new Error("RECOVERY_NOT_STARTED");
      remember = persistent;
      if (clerk.client.signIn.status !== "needs_new_password") {
        await clerk.client.signIn.attemptFirstFactor({ strategy: "reset_password_email_code", code });
      }
      return finish(await clerk.client.signIn.resetPassword({ password, signOutOfOtherSessions: true }));
    },
    async newPassword(password, persistent) {
      remember = persistent;
      return finish(await clerk.client.signIn.resetPassword({ password, signOutOfOtherSessions: true }));
    },
    async verifyFactor(code, first = false) {
      return finish(await (first
        ? clerk.client.signIn.attemptFirstFactor({ strategy: "email_code", code })
        : clerk.client.signIn.attemptSecondFactor({ strategy: secondFactor.strategy, code })));
    },
    async resend(step) {
      if (step === "verify-email") await clerk.client.signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      else if (step === "reset-code") {
        if (!recoveryStarted || !recoveryFactor?.emailAddressId) throw new Error("RECOVERY_NOT_STARTED");
        await clerk.client.signIn.prepareFirstFactor({
          strategy: "reset_password_email_code", emailAddressId: recoveryFactor.emailAddressId,
        });
      }
      else if (step === "first-factor") {
        const factor = clerk.client.signIn.supportedFirstFactors.find(f => f.strategy === "email_code");
        await clerk.client.signIn.prepareFirstFactor(factor);
      } else if (secondFactor && ["email_code", "phone_code"].includes(secondFactor.strategy)) {
        await clerk.client.signIn.prepareSecondFactor(secondFactor);
      } else throw new Error("NO_RESEND");
    },
    async signOut() {
      await clerk.signOut();
      await sessionRequest("DELETE");
    },
  };
}

let loading;
export function loadAuth() {
  if (!loading) loading = (async () => {
    const [{ Clerk }, { esES }] = await Promise.all([
      import("@clerk/clerk-js"), import("@clerk/localizations"),
    ]);
    const response = await fetch("/api/auth/config", { credentials: "same-origin" });
    if (!response.ok) throw new Error("AUTH_UNAVAILABLE");
    const { publishableKey, proxyUrl } = await response.json();
    if (!publishableKey) throw new Error("AUTH_UNAVAILABLE");
    const clerk = new Clerk(publishableKey, { proxyUrl });
    await clerk.load({ localization: esES, signInUrl: "/sign-in", signUpUrl: "/sign-up" });
    // Required for Clerk's official development authentication test helper.
    window.Clerk = clerk;
    return createAuthAdapter(clerk);
  })().catch(error => { loading = null; throw error; });
  return loading;
}

export function authError(error) {
  const code = error?.errors?.[0]?.code;
  if (["form_identifier_not_found", "form_password_incorrect", "form_password_or_identifier_incorrect"].includes(code))
    return "No se pudo verificar el acceso. Revisa tu correo y contraseña.";
  if (code === "form_code_incorrect") return "El código no es válido. Revísalo e inténtalo de nuevo.";
  if (code === "verification_expired") return "El código ha caducado. Solicita otro.";
  if (code === "form_password_pwned") return "Esta contraseña aparece en filtraciones. Elige otra más segura.";
  if (code === "form_password_length_too_short") return "La contraseña es demasiado corta. Usa al menos 8 caracteres.";
  if (code === "form_identifier_exists") return "No se pudo crear la cuenta. Intenta iniciar sesión o recuperar el acceso.";
  if (error?.status === 429 || code === "too_many_requests") return "Demasiados intentos. Espera unos minutos antes de volver a intentarlo.";
  if (error?.message === "INCOMPLETE_ACCOUNT") return "La cuenta requiere datos adicionales. Contacta con la administración de Postava.";
  if (error?.message === "UNSUPPORTED_FACTOR") return "Tu cuenta requiere un método de verificación no disponible en esta pantalla.";
  return "No se pudo completar la solicitud. Comprueba tu conexión e inténtalo de nuevo.";
}