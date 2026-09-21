# Postava on Replit

Postava is a browser-based Pomodoro/posture app served by Node.js and Express. Clerk manages optional accounts; the timer and local camera processing remain available without an account.

## Run

- Start the `Start application` workflow.
- The workflow runs `node server.mjs 5000`.
- Open the web preview over HTTPS and allow camera access when prompted.

The posture model and MediaPipe runtime are loaded from external CDNs, so the browser needs internet access on first load. Camera video is processed locally in the browser and is not sent to the server.

## Accounts

`login.html`, `login.js`, and `auth-adapter.js` implement email/password login, registration with email verification, and password recovery through Replit-managed Clerk. Development and production have separate Clerk user stores. No password is stored by this app.

Server startup builds the browser adapter with esbuild. Run `npm install` after cloning and `npm test` for regression tests. Static serving is allowlisted; never expose the whole workspace.

`Recordarme` uses an additional HttpOnly, Secure, SameSite=Lax signed presence cookie bound to the Clerk session. Unchecked: browser-session cookie; checked: up to 30 days, subject to Clerk's shorter expiry/revocation rules. Browsers that restore sessions may also restore session cookies; users of shared computers must explicitly sign out. Clerk remains the authentication authority and its SDK owns sign-out. All future private routes must require BOTH verified Clerk auth and a valid presence cookie, as `/api/auth/session` does.

Configuration is automatically provisioned with Clerk. `SESSION_SECRET` signs the presence cookie; keep it stable across server restarts. The canonical proxy is mounted before body parsing for published custom domains. Frontend requests are same-origin and cookie-based, never explicit bearer tokens.

`/sign-in`, `/sign-up`, and `/login` remain entry routes. `GET /api/account` remains protected by Clerk plus the presence cookie. The earlier React island source is retained in `client/` but is not mounted or served; there must be only one active auth client.

## Authentication test limits

Automated checks may validate anonymous pages, client-side validation surfaces, routing, and the protected API's `401`. They must not create external accounts or trigger recovery/verification email delivery without explicit permission. Full email receipt and Production session behavior therefore require an authorized manual test in the matching Clerk environment.
