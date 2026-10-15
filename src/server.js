import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = process.env.TMDB_API_KEY;
const configured = Boolean(process.env.CINEPRO_URL || (key && !key.startsWith('your_')));
let child;
if (configured && !process.env.CINEPRO_URL) {
  if (!existsSync(path.join(root, 'vendor/cinepro/dist/server.js'))) {
    console.error('Run npm run build before starting CinePro.'); process.exit(1);
  }
  child = spawn(process.execPath, ['dist/server.js'], {
    cwd: path.join(root, 'vendor/cinepro'), stdio: 'inherit',
    env: { ...process.env, HOST: '127.0.0.1', PORT: '3101', PUBLIC_URL: 'http://127.0.0.1:3101', STREMIO_ADDON: 'false', MCP_ENABLED: 'false', CORS_ORIGIN: 'http://127.0.0.1' }
  });
  child.on('exit', code => console.error(`CinePro exited (${code}); source resolution is unavailable until restart.`));
}
const app = createApp({ coreUrl: (process.env.CINEPRO_URL || 'http://127.0.0.1:3101').replace(/\/$/, ''), configured, secret: process.env.MEDIA_TOKEN_SECRET || undefined });
const server = app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
  console.log(`Priva Embed listening on port ${process.env.PORT || 3000}. Test page: /test`);
  if (!configured) console.log('Setup required: add TMDB_API_KEY to .env. The test page and local demo are available.');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child?.kill('SIGTERM'); server.close(() => process.exit(0)); });
