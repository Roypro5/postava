import React from "react";
import { createRoot } from "react-dom/client";
import {
  ClerkLoaded,
  ClerkLoading,
  ClerkProvider,
  Show,
  SignIn,
  SignUp,
  useClerk,
  useUser,
} from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { esES } from "@clerk/localizations";
import { shadcn } from "@clerk/themes";

// Required Replit-managed Clerk wiring. The host helper makes custom production
// domains and development use the right frontend API instance.
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// Empty in development and populated by Replit in production. Keep unconditional.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");
}

const appearance = {
  theme: shadcn,
  options: {
    logoPlacement: "inside",
    logoLinkUrl: "/",
    logoImageUrl: `${window.location.origin}/logo.svg`,
    socialButtonsPlacement: "bottom",
    socialButtonsVariant: "blockButton",
  },
  variables: {
    colorPrimary: "var(--accent)",
    colorForeground: "var(--ink)",
    colorMutedForeground: "var(--muted)",
    colorDanger: "var(--bad)",
    colorBackground: "var(--surface)",
    colorInput: "var(--surface-2)",
    colorInputForeground: "var(--ink)",
    colorNeutral: "var(--line)",
    fontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    borderRadius: "13px",
  },
  elements: {
    rootBox: { width: "100%", display: "flex", justifyContent: "center" },
    cardBox: {
      width: "min(440px, calc(100vw - 28px))",
      overflow: "hidden",
      border: "1px solid var(--line-soft)",
      borderRadius: "24px",
      background: "var(--surface)",
      boxShadow: "var(--sh-card)",
    },
    card: { border: 0, borderRadius: 0, background: "transparent", boxShadow: "none" },
    footer: { border: 0, borderRadius: 0, background: "transparent", boxShadow: "none" },
    headerTitle: { color: "var(--ink)", fontFamily: "var(--font-display)", fontWeight: 800 },
    headerSubtitle: { color: "var(--muted)" },
    socialButtonsBlockButtonText: { color: "var(--ink)", fontWeight: 700 },
    formFieldLabel: { color: "var(--ink)", fontWeight: 700 },
    footerActionLink: { color: "var(--accent-ink)", fontWeight: 700 },
    footerActionText: { color: "var(--muted)" },
    dividerText: { color: "var(--muted)" },
    identityPreviewEditButton: { color: "var(--accent-ink)" },
    formFieldSuccessText: { color: "var(--accent-ink)" },
    alertText: { color: "var(--bad-ink)" },
    logoBox: { height: "44px" },
    logoImage: { height: "42px", maxWidth: "160px" },
    socialButtonsBlockButton: {
      border: "1px solid var(--line)",
      background: "var(--surface-2)",
      color: "var(--ink)",
    },
    formButtonPrimary: {
      minHeight: "46px",
      background: "var(--ink)",
      color: "var(--surface)",
      fontWeight: 800,
      boxShadow: "var(--sh-btn)",
    },
    formFieldInput: {
      minHeight: "46px",
      border: "1px solid var(--line)",
      background: "var(--surface-2)",
      color: "var(--ink)",
    },
    footerAction: { color: "var(--muted)" },
    dividerLine: { background: "var(--line)" },
    alert: { border: "1px solid var(--bad)", background: "var(--bad-soft)" },
    otpCodeFieldInput: {
      border: "1px solid var(--line)",
      background: "var(--surface-2)",
      color: "var(--ink)",
    },
    formFieldRow: { color: "var(--ink)" },
    main: { color: "var(--ink)" },
  },
};

const localization = {
  ...esES,
  formFieldAction__forgotPassword: "¿Olvidaste tu contraseña?",
  formFieldInputPlaceholder__signUpPassword: "Crea una contraseña",
  signIn: {
    ...esES.signIn,
    start: {
      ...esES.signIn.start,
      title: "Bienvenido de nuevo",
      subtitle: "Inicia sesión para retomar tu ritmo",
      actionLink: "Crear cuenta",
    },
  },
  signUp: {
    ...esES.signUp,
    start: {
      ...esES.signUp.start,
      title: "Crea tu cuenta",
      subtitle: "Configura tu acceso personal a Postava",
      actionLink: "Iniciar sesión",
    },
  },
};

function LoadingState() {
  return (
    <div className="auth-loading" role="status">
      <span className="auth-spinner" aria-hidden="true" />
      Preparando acceso seguro…
    </div>
  );
}

function MainAccount() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const name =
    user?.firstName ||
    user?.primaryEmailAddress?.emailAddress?.split("@")[0] ||
    "Tu cuenta";

  return (
    <>
      <Show when="signed-out">
        <a className="nav-login" href="/sign-in">Iniciar sesión</a>
      </Show>
      <Show when="signed-in">
        <div className="nav-account">
          <span className="nav-user" title={user?.primaryEmailAddress?.emailAddress || ""}>
            {name}
          </span>
          <button
            className="nav-login nav-signout"
            type="button"
            onClick={() => signOut({ redirectUrl: "/" })}
          >
            Cerrar sesión
          </button>
        </div>
      </Show>
    </>
  );
}

function AuthPage() {
  const isSignUp = window.location.pathname.startsWith("/sign-up");
  return (
    <div className="auth-widget">
      {isSignUp ? (
        <SignUp
          routing="path"
          path="/sign-up"
          signInUrl="/sign-in"
          fallbackRedirectUrl="/"
          signInFallbackRedirectUrl="/"
        />
      ) : (
        <SignIn
          routing="path"
          path="/sign-in"
          signUpUrl="/sign-up"
          fallbackRedirectUrl="/"
          signUpFallbackRedirectUrl="/"
        />
      )}
      <p className="session-note">
        Clerk conserva la sesión mediante una cookie segura durante el tiempo configurado
        para Postava. Cerrar la pestaña no equivale a cerrar sesión; usa «Cerrar sesión»
        cuando termines en un equipo compartido.
      </p>
    </div>
  );
}

const rootElement = document.querySelector("#auth-root");
if (rootElement) {
  createRoot(rootElement).render(
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={appearance}
      localization={localization}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
    >
      <ClerkLoading>
        <LoadingState />
      </ClerkLoading>
      <ClerkLoaded>
        {document.body.classList.contains("login-page") ? <AuthPage /> : <MainAccount />}
      </ClerkLoaded>
    </ClerkProvider>,
  );
}