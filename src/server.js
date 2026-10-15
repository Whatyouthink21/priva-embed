import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createResolver, DEFAULT_PROVIDERS } from './consumet.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = (process.env.TMDB_API_KEY || '').trim();
const mode = (process.env.CONSUMET_MODE || 'library').toLowerCase() === 'api' ? 'api' : 'library';
const apiUrl = (process.env.CONSUMET_API_URL || 'https://api.consumet.org').trim();
const usableKey = key && !key.startsWith('your_');
const configured = mode === 'api' || Boolean(usableKey);
const resolver = configured ? createResolver({
  mode,
  tmdbKey: key,
  apiUrl,
  providers: process.env.CONSUMET_PROVIDERS,
  servers: process.env.CONSUMET_SERVERS,
  maxServers: process.env.CONSUMET_MAX_SERVERS
}) : null;
if (!configured) console.error('Setup required: set TMDB_API_KEY in .env (bundled mode) or CONSUMET_MODE=api to use a hosted Consumet API.');
const app = createApp({ resolver, configured, mode, secret: process.env.MEDIA_TOKEN_SECRET || undefined });
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Priva Embed listening on port ${port}. Test page: /test`);
  console.log(`Consumet mode: ${mode}${mode === 'api' ? ` (${apiUrl})` : ''} · providers: ${process.env.CONSUMET_PROVIDERS || DEFAULT_PROVIDERS.join(',')}`);
  if (!configured) console.log('The test page and the local demo are available; real source resolution is disabled.');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
