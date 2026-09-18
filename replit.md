# Postava on Replit

Postava is a vanilla browser Pomodoro with a small React island for Clerk authentication. The included Express server serves only an explicit public-file allowlist, Clerk's production proxy, and protected API routes.

## Run

- Start the `Start application` workflow.
- The workflow runs `node server.mjs 5000`.
- Open the web preview over HTTPS and allow camera access when prompted.

The posture model and MediaPipe runtime are loaded from external CDNs, so the browser needs internet access on first load. Camera video is processed locally in the browser and is not sent to the server.

## Accounts

- `/sign-in` and `/sign-up` render branded, Spanish Clerk flows. Password recovery is part of the sign-in flow.
- The home page remains public and the Pomodoro, theme, posture model, and camera work without an account.
- Clerk owns secure browser sessions through its cookie and configured session lifetime. Closing a tab is not a logout; authenticated users can explicitly use **Cerrar sesión** in the main navigation.
- Browser API calls use Clerk's cookie automatically. Do not add bearer-token storage to frontend code.
- `GET /api/account` is an example protected route and returns `401` to anonymous requests.

Development and Production use separate Clerk user stores. The canonical `/api/__clerk` production proxy is mounted before parsers and auth middleware; Replit provides its production configuration automatically.

In development, Vite transforms only the isolated `client/` auth island and accepts the Replit preview hostname. In Production, the same server command builds that island once at startup and serves only the known bundled entry; Vite's development middleware is not mounted.

## Authentication test limits

Automated checks may validate anonymous pages, client-side validation surfaces, routing, and the protected API's `401`. They must not create external accounts or trigger recovery/verification email delivery without explicit permission. Full email receipt and Production session behavior therefore require an authorized manual test in the matching Clerk environment.