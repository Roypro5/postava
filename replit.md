# Postava on Replit

Postava is a dependency-free browser app served by the included Node.js static server.

## Run

- Start the `Start application` workflow.
- The workflow runs `node server.mjs 5000`.
- Open the web preview over HTTPS and allow camera access when prompted.

The posture model and MediaPipe runtime are loaded from external CDNs, so the browser needs internet access on first load. Camera video is processed locally in the browser and is not sent to the server.