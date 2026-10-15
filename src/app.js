import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTokens, proxyMedia, validateUrl } from './media.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '1.0.0';
// The bundled Consumet scrapers cannot be aborted, so this only bounds how long
// we wait; abandoned provider requests finish (and are discarded) on their own.
function deadline(ms, message) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { name: 'TimeoutError' })), ms);
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

export function createApp({ resolver, configured = false, mode = 'library', secret = crypto.randomBytes(32), fetchProbe = fetch } = {}) {
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
    if (configured && resolver) try { reachable = await resolver.health({ fetchImpl: fetchProbe }); } catch {}
    res.json({
      service: 'Priva Embed',
      status: configured && reachable ? 'ready' : 'setup_required',
      mode,
      consumet: { configured, reachable },
      version
    });
  });
  const positive = x => /^\d{1,9}$/.test(x) && Number(x) > 0;
  const setupMessage = mode === 'api'
    ? 'Set CONSUMET_API_URL in .env and restart the server to enable source resolution.'
    : 'Set TMDB_API_KEY in .env and restart the server to enable Consumet extraction.';
  async function sources(req, res) {
    const { id, season, episode } = req.params;
    if (!positive(id) || (season !== undefined && (!positive(season) || !positive(episode)))) return res.status(400).json({ error: { code: 'INVALID_PARAMETER', message: 'TMDB ID, season and episode must be positive integers.' } });
    if (!configured || !resolver) return res.status(503).json({ error: { code: 'SETUP_REQUIRED', message: setupMessage } });
    const type = season ? 'tv' : 'movie';
    const query = { type, id, season: season ? Number(season) : undefined, episode: episode ? Number(episode) : undefined };
    const key = `${type}:${id}${season ? `:${season}:${episode}` : ''}`;
    res.set('Cache-Control', 'no-store');
    let promise = inFlight.get(key);
    if (!promise) {
      if (inFlight.size >= 8) return res.status(503).json({ error: { code: 'BUSY', message: 'Resolver busy. Please retry shortly.' } });
      const limit = deadline(90000, 'Consumet extraction timed out. Please retry.');
      promise = Promise.race([resolver.resolve(query), limit.promise]).finally(() => { limit.cancel(); inFlight.delete(key); });
      inFlight.set(key, promise);
    }
    try {
      const result = await promise;
      const wrap = item => {
        try { return { ...item, url: '/api/media?token=' + tokens.sign({ url: validateUrl(item.url).href, headers: result.headers || {} }) }; } catch { return null; }
      };
      const playable = (result.sources || []).filter(s => ['hls', 'mp4'].includes(s.type)).map(wrap).filter(Boolean);
      if (!playable.length) return res.status(404).json({ error: { code: 'NO_SOURCES', message: 'Consumet returned no browser-playable sources. Try another title or server later.', diagnostics: result.diagnostics } });
      res.json({
        provider: result.provider,
        providerId: result.providerId,
        mediaId: result.mediaId,
        episodeId: result.episodeId,
        title: result.title || null,
        sources: playable,
        subtitles: (result.subtitles || []).map(wrap).filter(Boolean),
        intro: result.intro || null,
        outro: result.outro || null,
        diagnostics: result.diagnostics || []
      });
    } catch (error) {
      const timeout = ['TimeoutError', 'AbortError'].includes(error.name);
      res.status(timeout ? 504 : 502).json({ error: { code: timeout ? 'RESOLVER_TIMEOUT' : 'UPSTREAM_ERROR', message: timeout ? 'Consumet extraction timed out. Please retry.' : error.message || 'Consumet could not resolve this title.', diagnostics: error.diagnostics } });
    }
  }
  app.get('/api/sources/movie/:id', sources);
  app.get('/api/sources/tv/:id/:season/:episode', sources);
  app.get('/api/media', (req, res) => proxyMedia(req, res, tokens));
  app.get('/assets/hls.min.js', (req, res) => res.sendFile(path.join(root, 'node_modules/hls.js/dist/hls.min.js')));
  app.get(['/embed/movie/:id', '/embed/tv/:id/:season/:episode', '/embed/demo'], (req, res) => res.sendFile(path.join(root, 'public/player.html')));
  app.get(['/', '/test'], (req, res) => res.sendFile(path.join(root, 'public/index.html')));
  app.use(express.static(path.join(root, 'public'), { index: false }));
  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found. Open /test for documentation.' } }));
  return app;
}
