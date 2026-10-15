import { MOVIES } from '@consumet/extensions';
import { ALLOWED_HEADERS } from './media.js';

// Movies/TV providers shipped by @consumet/extensions that accept
// fetchEpisodeSources(episodeId, mediaId, server). DramaCool and Turkish123 use a
// different arity and only cover niche catalogues, so they are not offered.
export const PROVIDERS = { flixhq: 'FlixHQ', himovies: 'HiMovies', sflix: 'SFlix', goku: 'Goku' };
export const DEFAULT_PROVIDERS = ['flixhq'];
// Preferred streaming servers, best first. The provider's own default is always
// tried before this list, so the ordering only matters for fallbacks.
export const DEFAULT_SERVERS = [
  'upcloud', 'megacloud', 'vidcloud', 'mycloud', 'mixdrop', 'streamtape', 'filemoon', 'voe', 'vidmoly', 'streamwish'
];
const TMDB_API = 'https://api.themoviedb.org/3';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export function normalizeTitle(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
// Sørensen–Dice coefficient over character bigrams, used to match a TMDB title
// against the loosely formatted titles returned by scraping providers.
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = value => { const map = new Map(); for (let i = 0; i < value.length - 1; i++) { const g = value.slice(i, i + 2); map.set(g, (map.get(g) || 0) + 1); } return map; };
  const left = grams(a); const right = grams(b);
  let hits = 0;
  for (const [gram, count] of left) hits += Math.min(count, right.get(gram) || 0);
  return (2 * hits) / (a.length + b.length - 2);
}
export function normalizeSources(payload, provider, server) {
  const absolute = value => typeof value === 'string' && /^https?:\/\//i.test(value);
  const sources = (payload.sources || []).flatMap(video => {
    if (!absolute(video?.url)) return [];
    const type = video.isM3U8 ? 'hls' : video.isDASH ? 'dash' : 'mp4';
    if (type === 'dash') return [];
    return [{ url: video.url, type, quality: video.quality || 'auto', provider, server }];
  });
  const subtitles = (payload.subtitles || []).flatMap(track => {
    if (!absolute(track?.url) || !/\.vtt(\?|$)/i.test(track.url)) return [];
    return [{ url: track.url, lang: track.lang || 'Unknown' }];
  });
  const headers = {};
  for (const [key, value] of Object.entries(payload.headers || {})) {
    if (typeof value === 'string' && value.length < 4096 && ALLOWED_HEADERS.includes(String(key).toLowerCase())) headers[key] = value;
  }
  return { headers, sources, subtitles, intro: payload.intro || null, outro: payload.outro || null };
}
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms); })
  ]);
}

class Backend {
  constructor({ servers = DEFAULT_SERVERS, maxServers = 3, attemptTimeout = 25000, movies = MOVIES, fetchImpl = fetch } = {}) {
    this.servers = servers;
    this.maxServers = Math.max(1, Math.min(Number(maxServers) || 3, 6));
    this.attemptTimeout = attemptTimeout;
    this.movies = movies;
    this.fetchImpl = fetchImpl;
  }
  async collect(providerId, { episodeId, mediaId, fetchSources, fetchServers }, diagnostics) {
    let names = [];
    try { names = (await fetchServers(episodeId, mediaId)) || []; } catch { names = []; }
    const available = names.map(item => String(item?.name || '').toLowerCase()).filter(Boolean);
    const preferred = this.servers.filter(name => available.includes(name));
    const remaining = available.filter(name => !this.servers.includes(name));
    const queue = [...new Set([...preferred, ...remaining])].slice(0, this.maxServers);
    const found = [];
    for (const server of queue) {
      try {
        const payload = await withTimeout(fetchSources(episodeId, mediaId, server), this.attemptTimeout, `Server ${server}`);
        const normalized = normalizeSources(payload, providerId, server);
        diagnostics.push({ provider: providerId, server, status: normalized.sources.length ? 'ok' : 'empty' });
        if (normalized.sources.length) found.push(normalized);
      } catch (error) {
        diagnostics.push({ provider: providerId, server, status: 'error', error: error.message });
      }
    }
    return found;
  }
  pick(results) {
    const sources = results.flatMap(item => item.sources);
    const subtitles = [];
    for (const item of results) for (const track of item.subtitles) {
      if (!subtitles.some(existing => existing.label === track.lang)) subtitles.push({ ...track, label: track.lang });
    }
    const first = results[0] || {};
    return { headers: first.headers || {}, sources, subtitles, intro: first.intro || null, outro: first.outro || null };
  }
}

/**
 * Bundled backend: scrapes the provider sites in-process with @consumet/extensions.
 * Needs a TMDB key to translate a TMDB id into a provider id.
 */
export class LibraryBackend extends Backend {
  constructor({ tmdbKey, providers = DEFAULT_PROVIDERS, infoTtl = 6 * 60 * 60 * 1000, titleTtl = 24 * 60 * 60 * 1000, tmdbUrl = TMDB_API, ...rest } = {}) {
    super(rest);
    this.tmdbKey = tmdbKey;
    this.ids = providers.map(id => String(id).toLowerCase()).filter(id => PROVIDERS[id]);
    this.infoTtl = infoTtl;
    this.titleTtl = titleTtl;
    this.tmdbUrl = tmdbUrl;
    this.instances = new Map();
    this.info = new Map();
    this.titles = new Map();
  }
  get configured() { return Boolean(this.tmdbKey) && this.ids.length > 0; }
  async health({ fetchImpl = this.fetchImpl } = {}) {
    if (!this.configured) return false;
    const url = `${this.tmdbUrl}/configuration?api_key=${encodeURIComponent(this.tmdbKey)}`;
    const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    return response.ok;
  }
  instance(id) {
    if (!this.instances.has(id)) {
      const provider = new this.movies[PROVIDERS[id]]();
      this.instances.set(id, { id, provider, name: provider.name });
    }
    return this.instances.get(id);
  }
  async title(type, id) {
    const key = `${type}:${id}`;
    const cached = this.titles.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const url = `${this.tmdbUrl}/${type === 'movie' ? 'movie' : 'tv'}/${id}?api_key=${encodeURIComponent(this.tmdbKey)}&language=en-US`;
    const response = await this.fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`TMDB lookup failed (${response.status})`);
    const data = await response.json();
    const value = {
      title: data.title || data.name || '',
      year: Number(String(data.release_date || data.first_air_date || '').slice(0, 4)) || 0,
      seasons: Number(data.number_of_seasons) || 0
    };
    if (!value.title) throw new Error('TMDB returned no title for this id');
    this.titles.set(key, { value, expires: Date.now() + this.titleTtl });
    return value;
  }
  async mapping(entry, query) {
    const key = `${entry.id}:${query.type}:${query.id}`;
    const cached = this.info.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const meta = await this.title(query.type, query.id);
    const wanted = normalizeTitle(meta.title);
    const search = await entry.provider.search(meta.title);
    const results = (search?.results || []).filter(item => item?.id);
    if (!results.length) throw new Error(`${entry.name} returned no search results for this title`);
    let best = null;
    for (const item of results) {
      const candidate = normalizeTitle(typeof item.title === 'string' ? item.title : item.title?.english || item.title?.romaji || '');
      if (!candidate) continue;
      const year = Number(String(item.releaseDate || '').slice(0, 4)) || 0;
      const yearPenalty = meta.year && year && Math.abs(year - meta.year) > 1 ? 0.25 : 0;
      const score = similarity(wanted, candidate) + (candidate === wanted ? 0.5 : 0) - yearPenalty;
      if (!best || score > best.score) best = { item, score };
    }
    if (!best || best.score < 0.45) throw new Error(`${entry.name} has no close match for “${meta.title}”`);
    const value = { mediaId: String(best.item.id), title: meta.title, year: meta.year };
    this.info.set(key, { value, expires: Date.now() + this.infoTtl });
    return value;
  }
  async episodeId(entry, query) {
    const mapping = await this.mapping(entry, query);
    const info = await entry.provider.fetchMediaInfo(mapping.mediaId);
    const episodes = info?.episodes || [];
    if (!episodes.length) throw new Error(`${entry.name} returned no episodes for this title`);
    if (query.type === 'movie') {
      const id = episodes[0]?.id;
      if (!id) throw new Error(`${entry.name} returned no playable id for this movie`);
      return { ...mapping, episodeId: String(id) };
    }
    const match = episodes.find(item => Number(item.season) === query.season && Number(item.number) === query.episode) ||
      episodes.find(item => Number(item.number) === query.episode && (!item.season || Number(item.season) === query.season));
    if (!match?.id) throw new Error(`${entry.name} does not have season ${query.season} episode ${query.episode}`);
    return { ...mapping, episodeId: String(match.id) };
  }
  async resolve(query) {
    const diagnostics = [];
    for (const id of this.ids) {
      const entry = this.instance(id);
      try {
        const { mediaId, episodeId, title } = await this.episodeId(entry, query);
        const results = await this.collect(id, {
          episodeId,
          mediaId,
          fetchSources: (ep, media, server) => entry.provider.fetchEpisodeSources(ep, media, server),
          fetchServers: (ep, media) => entry.provider.fetchEpisodeServers(ep, media)
        }, diagnostics);
        const picked = this.pick(results);
        if (!picked.sources.length) { diagnostics.push({ provider: id, server: null, status: 'error', error: 'No browser-playable sources' }); continue; }
        return { provider: entry.name, providerId: id, mediaId, episodeId, title, diagnostics, ...picked };
      } catch (error) {
        diagnostics.push({ provider: id, server: null, status: 'error', error: error.message });
      }
    }
    const error = new Error(diagnostics.map(item => item.error).filter(Boolean).join('; ') || 'No Consumet provider returned sources.');
    error.diagnostics = diagnostics;
    throw error;
  }
}

/**
 * REST backend: talks to a hosted Consumet API instance (default api.consumet.org).
 * Does not need a local TMDB key — the API maps TMDB ids to provider ids itself.
 */
export class ApiBackend extends Backend {
  constructor({ apiUrl = 'https://api.consumet.org', providers = DEFAULT_PROVIDERS, ...rest } = {}) {
    super(rest);
    this.apiUrl = String(apiUrl).replace(/\/+$/, '');
    this.ids = providers.map(id => String(id).toLowerCase()).filter(id => PROVIDERS[id]);
  }
  get configured() { return this.ids.length > 0; }
  async health({ fetchImpl = this.fetchImpl } = {}) {
    if (!this.configured) return false;
    const response = await fetchImpl(this.apiUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    await response.arrayBuffer().catch(() => null);
    return response.status < 500;
  }
  async request(path, params) {
    const url = new URL(this.apiUrl + path);
    for (const [key, value] of Object.entries(params || {})) if (value !== undefined) url.searchParams.set(key, value);
    const response = await this.fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.message || `Consumet API error (${response.status})`);
    return body;
  }
  async episodeId(id, query) {
    const info = await this.request(`/meta/tmdb/info/${encodeURIComponent(query.id)}`, { type: query.type === 'movie' ? 'movie' : 'tv', provider: id });
    const mediaId = info?.id ? String(info.id) : '';
    if (!mediaId) throw new Error(`Consumet API could not map this ${query.type} id`);
    if (query.type === 'movie') {
      if (!info.episodeId) throw new Error('Consumet API returned no episode id for this movie');
      return { mediaId, episodeId: String(info.episodeId), title: info.title || '' };
    }
    const season = (info.seasons || []).find(item => Number(item.season) === query.season);
    const episode = (season?.episodes || []).find(item => Number(item.episode ?? item.number) === query.episode);
    if (!episode?.id) throw new Error(`Consumet API has no season ${query.season} episode ${query.episode}`);
    return { mediaId, episodeId: String(episode.id), title: info.title || '' };
  }
  async resolve(query) {
    const diagnostics = [];
    for (const id of this.ids) {
      try {
        const { mediaId, episodeId, title } = await this.episodeId(id, query);
        const results = await this.collect(id, {
          episodeId,
          mediaId,
          fetchSources: (ep, media, server) => this.request(`/movies/${id}/watch`, { episodeId: ep, mediaId: media, server }),
          fetchServers: (ep, media) => this.request(`/movies/${id}/servers`, { episodeId: ep, mediaId: media })
        }, diagnostics);
        const picked = this.pick(results);
        if (!picked.sources.length) { diagnostics.push({ provider: id, server: null, status: 'error', error: 'No browser-playable sources' }); continue; }
        return { provider: PROVIDERS[id], providerId: id, mediaId, episodeId, title, diagnostics, ...picked };
      } catch (error) {
        diagnostics.push({ provider: id, server: null, status: 'error', error: error.message });
      }
    }
    const error = new Error(diagnostics.map(item => item.error).filter(Boolean).join('; ') || 'No Consumet provider returned sources.');
    error.diagnostics = diagnostics;
    throw error;
  }
}

export function createResolver({ mode = 'library', tmdbKey, apiUrl, providers, servers, maxServers, movies = MOVIES } = {}) {
  const list = String(providers || '').split(/[\s,]+/).map(item => item.trim().toLowerCase()).filter(Boolean);
  const chosen = list.length ? list : DEFAULT_PROVIDERS;
  const serverList = String(servers || '').split(/[\s,]+/).map(item => item.trim().toLowerCase()).filter(Boolean);
  const shared = {
    providers: chosen,
    servers: serverList.length ? serverList : DEFAULT_SERVERS,
    maxServers: Number(maxServers) || 3,
    movies
  };
  if (mode === 'api') return new ApiBackend({ ...shared, apiUrl });
  return new LibraryBackend({ ...shared, tmdbKey });
}
