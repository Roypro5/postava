# Postava on Replit

Postava is a dependency-free browser app served by the included Node.js static server.

## Run

- Start the `Start application` workflow.
- The workflow runs `node server.mjs 5000`.
- Open the web preview over HTTPS and allow camera access when prompted.

The posture model and MediaPipe runtime are loaded from external CDNs, so the browser needs internet access on first load. Camera video is processed locally in the browser and is not sent to the server.

## Login screen

`login.html` is a presentational, accessibility-first login surface. It imports no camera or posture code. The form cannot submit before JavaScript installs its listener, has no `action` or credential-bearing GET fallback, and the bundled `auth-adapter.js` is deliberately unconfigured: it makes no network request and does not store credentials or sessions.

To enable sign-in later, inject an adapter into `mountLogin(document, adapter)` from `login.js`. A provider adapter must expose `configured: true` and an async `signIn({ email, password, remember })` method. Connect a real provider/session implementation there, and replace the on-page recovery and registration explanations with their provider-backed flows. Do not add credential persistence to this static frontend.