import { createApp } from "./app.js";

const PORT = Number(process.env.PORT) || 3000;
const app = createApp();

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[priva] Priva Embed listening on http://0.0.0.0:${PORT}`);
});

const shutdown = (signal) => {
  console.log(`[priva] ${signal} received, closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
