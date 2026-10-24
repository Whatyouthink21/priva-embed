import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "node_modules", "hls.js", "dist", "hls.min.js");
const targetDir = path.join(root, "public", "vendor");
const target = path.join(targetDir, "hls.min.js");

if (!existsSync(source)) {
  console.warn("[priva] hls.js was not found in node_modules, the player will fall back to the CDN build.");
  process.exit(0);
}

await mkdir(targetDir, { recursive: true });
await copyFile(source, target);
console.log("[priva] vendored hls.js -> public/vendor/hls.min.js");
