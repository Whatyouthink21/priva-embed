import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import playerRouter from "./routes/player.js";
import apiRouter from "./routes/api.js";
import proxyRouter from "./routes/proxy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const frameAncestors = allowedOrigins.length ? `'self' ${allowedOrigins.join(" ")}` : "*";

  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy":
        "autoplay=*, fullscreen=*, encrypted-media=*, picture-in-picture=*, clipboard-write=*",
      "Content-Security-Policy": [
        "default-src 'self'",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob: data: https:",
        "worker-src 'self' blob:",
        "connect-src 'self' https:",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "frame-src 'self' https:",
        `frame-ancestors ${frameAncestors}`,
      ].join("; "),
    });
    next();
  });

  app.use(
    express.static(publicDir, {
      maxAge: "1h",
      setHeaders(res, filePath) {
        if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
      },
    }),
  );

  app.use("/api", (req, res, next) => {
    res.set("Access-Control-Allow-Origin", allowedOrigins.length ? allowedOrigins[0] : "*");
    res.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.use("/api", apiRouter);
  app.use("/api", proxyRouter);

  app.get("/favicon.ico", (_req, res) => {
    res.type("image/svg+xml").sendFile(path.join(publicDir, "assets", "favicon.svg"));
  });

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.use(playerRouter);

  app.use((req, res) => {
    res.status(404).json({ error: "not_found", path: req.path });
  });

  app.use((error, _req, res, _next) => {
    console.error("[priva] unhandled", error);
    if (res.headersSent) return;
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}

export default createApp;
