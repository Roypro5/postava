/* Servidor de Postava: Clerk, API protegida y archivos públicos permitidos. */
import express from "express";
import cors from "cors";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as buildViteClient, createServer as createViteServer } from "vite";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./server/middlewares/clerkProxyMiddleware.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.argv[2]) || 5173;
const app = express();

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

const requireAuth = (req, res, next) => {
  const auth = getAuth(req);
  const userId = auth?.sessionClaims?.userId || auth?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  req.userId = userId;
  next();
};

app.get("/api/account", requireAuth, (req, res) => {
  res.json({ userId: req.userId });
});

const PUBLIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/login.css", "login.css"],
  ["/theme.js", "theme.js"],
  ["/app.js", "app.js"],
  ["/posture.js", "posture.js"],
  ["/logo.svg", "logo.svg"],
]);

async function sendPublic(fileName, res) {
  try {
    const file = join(root, fileName);
    const data = await readFile(file);
    res.status(200).set({
      "Content-Type": TYPES[extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.send(data);
  } catch {
    res.status(404).type("text").send("404");
  }
}

app.get(["/login.html", "/login"], (_req, res) => res.redirect(302, "/sign-in"));
app.get(/^\/sign-(in|up)(\/.*)?$/, (_req, res) => sendPublic("login.html", res));
for (const [url, file] of PUBLIC_FILES) {
  app.get(url, (_req, res) => sendPublic(file, res));
}

if (process.env.NODE_ENV === "production") {
  // Keep the existing `node server.mjs 5000` command production-ready: bundle
  // the isolated island once at startup, then serve only its known output.
  const outDir = join(root, ".postava-build");
  await buildViteClient({
    root: join(root, "client"),
    publicDir: false,
    logLevel: "warn",
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: {
        input: join(root, "client/auth-entry.jsx"),
        output: {
          entryFileNames: "auth-entry.js",
          codeSplitting: false,
        },
      },
    },
  });
  app.get("/auth-entry.jsx", (_req, res) =>
    sendPublic(".postava-build/auth-entry.js", res),
  );
} else {
  // Development transforms the small React auth island only. Its root is
  // isolated from application/server files and accepts Replit's preview host.
  const vite = await createViteServer({
    root: join(root, "client"),
    publicDir: false,
    appType: "custom",
    server: { middlewareMode: true, allowedHosts: true },
  });
  app.use(vite.middlewares);
}

app.use((_req, res) => res.status(404).type("text").send("404"));

app.listen(port, () => {
  console.log(`Postava en http://localhost:${port}`);
});
