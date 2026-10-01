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

`/sign-in`, `/sign-up`, and `/login` remain entry routes. `GET /api/account` remains protected by Clerk plus the presence cookie. The earlier React island prototype has been removed; there must be only one active auth client.

## Authentication test limits

Automated checks may validate anonymous pages, client-side validation surfaces, routing, and the protected API's `401`. They must not create external accounts or trigger recovery/verification email delivery without explicit permission. Full email receipt and Production session behavior therefore require an authorized manual test in the matching Clerk environment.

## Private session statistics

Completed focus blocks are saved as aggregates for the account active when the block began through `POST /api/stats/sessions`; `GET /api/stats?days=7|30` reads only that account's sessions for the selected UTC calendar period. Both endpoints require Clerk authentication and the signed presence cookie. Each request is scoped by the server-derived Clerk user ID, not a user ID supplied by the browser. The POST compares that identity to the block's expected account to reject cross-account retries. It also rejects raw video and landmark fields. Sessions are deduplicated by account and client-generated session ID. A guest can still use the timer, but guest activity is not attached to any account. Failed sends are retained in an account-scoped browser queue and can be retried.

The `posture_stats_sessions` table lives in Replit's managed development PostgreSQL database. Publish applies the development schema to the managed production database; never create the table at server startup or run production DDL manually. The old shared demo JSON is removed. Video and landmarks stay on the device; only rounded duration, measured posture time, issue counts, and alert counts are saved. A score remains unavailable when no posture measurements were collected.
