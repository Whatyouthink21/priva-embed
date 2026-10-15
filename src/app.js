import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTokens, unwrapSource, proxyMedia } from './media.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function createApp({ coreUrl = 'http://127.0.0.1:3101', configured = false, secret = crypto.randomBytes(32), fetchCore = fetch } = {}) {
  const app = express();
  const tokens = createTokens(secret);
  const parents = process.env.FRAME_ANCESTORS || '*';
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${parents}`);
    next();
  });
  const inFlight = new Map();
  const clients = new Map();
  const cleanup = setInterval(() => { const now = Date.now(); for (const [key, value] of clients) if (value.reset < now) clients.delete(key); }, 60000);
  cleanup.unref();
  app.use('/api', (req, res, next) => {
    if (!req.path.startsWith('/sources/')) return next();
    const key = req.ip;
    const now = Date.now();
    const record = clients.get(key) || { count: 0, reset: now + 60000 };
    if (record.reset < now) { record.count = 0; record.reset = now + 60000; }
    clients.set(key, record);
    if (++record.count > 30) return res.status(429).set('Retry-After', '60').json({ error: { code: 'RATE_LIMITED', message: 'Too many source requests. Retry in one minute.' } });
    next();
  });
  app.get('/api/health', async (req, res) => {
    let reachable = false;
    if (configured) try { reachable = (await fetchCore(`${coreUrl}/v1/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
    res.json({ service: 'Priva Embed', status: configured && reachable ? 'ready' : 'setup_required', cinepro: { configured, reachable }, version: '1.0.0' });
  });
  const positive = x => /^\d{1,9}$/.test(x) && Number(x) > 0;
  async function sources(req, res) {
    const { id, season, episode } = req.params;
    if (!positive(id) || (season !== undefined && (!positive(season) || !positive(episode)))) return res.status(400).json({ error: { code: 'INVALID_PARAMETER', message: 'TMDB ID, season and episode must be positive integers.' } });
    if (!configured) return res.status(503).json({ error: { code: 'SETUP_REQUIRED', message: 'Set TMDB_API_KEY in .env and restart the server to enable CinePro extraction.' } });
    const endpoint = season ? `/v1/tv/${id}/seasons/${season}/episodes/${episode}` : `/v1/movies/${id}`;
    res.set('Cache-Control', 'no-store');
    try {
      let promise = inFlight.get(endpoint);
      if (!promise) {
        if (inFlight.size >= 8) return res.status(503).json({ error: { code: 'BUSY', message: 'Resolver busy. Please retry shortly.' } });
        promise = (async () => {
          const response = await fetchCore(coreUrl + endpoint, { signal: AbortSignal.timeout(90000) });
          const body = await response.json();
          return { ok: response.ok, status: response.status, body };
        })().finally(() => inFlight.delete(endpoint));
        inFlight.set(endpoint, promise);
      }
      const result = await promise;
      if (!result.ok) return res.status(result.status >= 400 && result.status < 600 ? result.status : 502).json(result.body);
      const wrap = item => {
        try { return { ...item, url: '/api/media?token=' + tokens.sign(unwrapSource(item.url)) }; } catch { return null; }
      };
      const playable = (result.body.sources || []).filter(s => ['hls', 'mp4', 'webm', 'http'].includes(s.type)).map(wrap).filter(Boolean);
      if (!playable.length) return res.status(404).json({ error: { code: 'NO_SOURCES', message: 'CinePro returned no browser-playable sources. Try another title later.' } });
      res.json({ ...result.body, sources: playable, subtitles: (result.body.subtitles || []).filter(s => s.format === 'vtt').map(wrap).filter(Boolean) });
    } catch (error) {
      const timeout = ['TimeoutError', 'AbortError'].includes(error.name);
      res.status(timeout ? 504 : 502).json({ error: { code: timeout ? 'RESOLVER_TIMEOUT' : 'UPSTREAM_ERROR', message: timeout ? 'CinePro extraction timed out. Please retry.' : 'CinePro could not resolve this title. Check server configuration and provider connectivity.' } });
    }
  }
  app.get('/api/sources/movie/:id', sources);
  app.get('/api/sources/tv/:id/:season/:episode', sources);
  app.get('/api/media', (req, res) => proxyMedia(req, res, tokens));
  app.get('/assets/hls.min.js', (req, res) => res.sendFile(path.join(root, 'node_modules/hls.js/dist/hls.min.js')));
  app.get(['/embed/movie/:id', '/embed/tv/:id/:season/:episode', '/embed/demo'], (req, res) => res.sendFile(path.join(root, 'public/player.html')));
  app.get(['/','/test'], (req, res) => res.sendFile(path.join(root, 'public/index.html')));
  app.use(express.static(path.join(root, 'public'), { index: false }));
  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found. Open /test for documentation.' } }));
  return app;
}
