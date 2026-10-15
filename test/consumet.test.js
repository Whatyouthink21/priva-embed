import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { LibraryBackend, ApiBackend, createResolver, normalizeSources, normalizeTitle, similarity, PROVIDERS } from '../src/consumet.js';

function json(value) { return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }); }
function tmdbFetch(body) {
  return async url => {
    if (String(url).includes('/configuration')) return new Response('{}', { status: 200 });
    return json(body);
  };
}
class StubProvider {
  constructor(options = {}) {
    this.name = options.name || 'Stub';
    this.options = options;
    this.calls = [];
  }
  async search(title) {
    this.calls.push(['search', title]);
    if (this.options.searchFails) throw new Error('search down');
    return this.options.search || { results: [{ id: 'movie/watch-test-1', title: 'Test Movie', releaseDate: '1999-10-15', type: 'Movie' }] };
  }
  async fetchMediaInfo(id) {
    this.calls.push(['info', id]);
    if (this.options.emptyEpisodes) return { id, episodes: [] };
    return { id, episodes: [{ id: '100', season: 1, number: 1 }, { id: '200', season: 1, number: 2 }] };
  }
  async fetchEpisodeServers(episodeId, mediaId) {
    this.calls.push(['servers', episodeId, mediaId]);
    if (this.options.serversFails) throw new Error('server list down');
    return this.options.servers || [{ name: 'upcloud' }, { name: 'mixdrop' }];
  }
  async fetchEpisodeSources(episodeId, mediaId, server) {
    this.calls.push(['sources', episodeId, mediaId, server]);
    if (this.options.badServer === server) throw new Error(`${server} exploded`);
    if (server === 'mixdrop') return { headers: { Referer: 'https://mixdrop.example/' }, sources: [{ url: 'https://media.example/b.mp4', quality: '720p' }], subtitles: [{ url: 'https://media.example/en.vtt', lang: 'English' }] };
    return { headers: { Referer: 'https://upcloud.example/' }, sources: [{ url: 'https://media.example/a.m3u8', isM3U8: true, quality: '1080p' }, { url: 'https://media.example/a.mpd', isDASH: true }], subtitles: [{ url: 'https://media.example/en.vtt', lang: 'English' }, { url: 'https://media.example/fr.srt', lang: 'French' }] };
  }
}
function library(options = {}) {
  return new LibraryBackend({
    tmdbKey: 'key',
    movies: { FlixHQ: StubProvider, HiMovies: class extends StubProvider { constructor() { super({ name: 'Second' }); } } },
    fetchImpl: tmdbFetch({ title: 'Test Movie', release_date: '1999-10-15' }),
    ...options
  });
}
test('normalizeTitle and similarity rank close titles above unrelated ones', () => {
  assert.equal(normalizeTitle('Spider-Man: No Way Home!'), 'spider man no way home');
  assert.ok(similarity('fight club', 'fight club') === 1);
  assert.ok(similarity('test movie', 'test movie 2') > similarity('test movie', 'completely different'));
});
test('normalizeSources keeps hls/mp4, drops dash and non-vtt subtitles, sanitizes headers', () => {
  const result = normalizeSources({
    headers: { Referer: 'https://x/', 'X-Evil': 'no', '': 'blank' },
    sources: [
      { url: 'https://media.example/a.m3u8', isM3U8: true, quality: '1080p' },
      { url: 'https://media.example/b.mp4' },
      { url: 'https://media.example/c.mpd', isDASH: true },
      { url: 'javascript:alert(1)' },
      { url: 'http://127.0.0.1/x.mp4' }
    ],
    subtitles: [{ url: 'https://media.example/en.vtt', lang: 'English' }, { url: 'https://media.example/fr.srt', lang: 'French' }]
  }, 'FlixHQ', 'upcloud');
  assert.deepEqual(result.sources, [
    { url: 'https://media.example/a.m3u8', type: 'hls', quality: '1080p', provider: 'FlixHQ', server: 'upcloud' },
    { url: 'https://media.example/b.mp4', type: 'mp4', quality: 'auto', provider: 'FlixHQ', server: 'upcloud' },
    { url: 'http://127.0.0.1/x.mp4', type: 'mp4', quality: 'auto', provider: 'FlixHQ', server: 'upcloud' }
  ]);
  assert.deepEqual(result.subtitles, [{ url: 'https://media.example/en.vtt', lang: 'English' }]);
  assert.deepEqual(result.headers, { Referer: 'https://x/' });
});
test('bundled backend maps a TMDB id through search, collects servers and dedupes subtitles', async () => {
  const backend = library({ maxServers: 2 });
  const result = await backend.resolve({ type: 'movie', id: '550' });
  assert.equal(result.provider, 'Stub');
  assert.equal(result.mediaId, 'movie/watch-test-1');
  assert.equal(result.episodeId, '100');
  assert.equal(result.title, 'Test Movie');
  assert.deepEqual(result.sources.map(s => s.type), ['hls', 'mp4']);
  assert.deepEqual(result.sources.map(s => s.server), ['upcloud', 'mixdrop']);
  assert.deepEqual(result.subtitles, [{ url: 'https://media.example/en.vtt', lang: 'English', label: 'English' }]);
  assert.ok(result.diagnostics.every(item => item.status === 'ok'));
});
test('bundled backend picks the requested season and episode', async () => {
  const backend = library({ maxServers: 1 });
  const result = await backend.resolve({ type: 'tv', id: '1399', season: 1, episode: 2 });
  assert.equal(result.episodeId, '200');
  await assert.rejects(backend.resolve({ type: 'tv', id: '1399', season: 3, episode: 1 }), /season 3 episode 1/);
});
test('bundled backend records per-server failures and falls through to the next provider', async () => {
  const backend = library({
    providers: ['flixhq', 'himovies'],
    maxServers: 2,
    movies: {
      FlixHQ: class extends StubProvider { constructor() { super({ searchFails: true }); } },
      HiMovies: class extends StubProvider { constructor() { super({ name: 'Second' }); } }
    }
  });
  const result = await backend.resolve({ type: 'movie', id: '550' });
  assert.equal(result.provider, 'Second');
  assert.ok(result.diagnostics.some(item => item.error === 'search down'));

  const failing = library({ maxServers: 2, movies: { FlixHQ: class extends StubProvider { constructor() { super({ serversFails: true }); } } } });
  await assert.rejects(failing.resolve({ type: 'movie', id: '550' }), /No browser-playable sources|timed out|down/);

  const partial = library({ maxServers: 2, movies: { FlixHQ: class extends StubProvider { constructor() { super({ badServer: 'upcloud' }); } } } });
  const ok = await partial.resolve({ type: 'movie', id: '550' });
  assert.deepEqual(ok.sources.map(s => s.server), ['mixdrop']);
  assert.ok(ok.diagnostics.some(item => item.status === 'error'));
});
test('bundled backend refuses titles no provider carries', async () => {
  const backend = library({
    movies: { FlixHQ: class extends StubProvider { constructor() { super({ search: { results: [{ id: 'x', title: 'Unrelated Show' }] } }); } } }
  });
  await assert.rejects(backend.resolve({ type: 'movie', id: '550' }), /no close match/i);
  const none = library({ movies: { FlixHQ: class extends StubProvider { constructor() { super({ search: { results: [] } }); } } } });
  await assert.rejects(none.resolve({ type: 'movie', id: '550' }), /no search results/i);
});
async function withApi(run) {
  const app = express();
  app.get('/', (req, res) => res.json({ message: 'Consumet API' }));
  app.get('/meta/tmdb/info/:id', (req, res) => {
    if (req.params.id !== '550' && req.params.id !== '1399') return res.status(404).json({ message: 'Media Not found.' });
    if (req.query.type === 'tv') return res.json({ id: 'tv/watch-test-1', title: 'Test Show', seasons: [{ season: 1, episodes: [{ id: 'e1', episode: 1 }, { id: 'e2', episode: 2 }] }] });
    return res.json({ id: 'movie/watch-test-1', episodeId: '100', title: 'Test Movie' });
  });
  app.get('/movies/:provider/servers', (req, res) => res.json([{ name: 'upcloud' }, { name: 'mixdrop' }]));
  app.get('/movies/:provider/watch', (req, res) => {
    if (req.query.server === 'mixdrop') return res.json({ headers: { Referer: 'https://mixdrop.example/' }, sources: [{ url: 'https://media.example/b.mp4', quality: '360p' }] });
    return res.json({ headers: { Referer: 'https://upcloud.example/' }, sources: [{ url: 'https://media.example/a.m3u8', isM3U8: true, quality: '1080p' }], subtitles: [{ url: 'https://media.example/en.vtt', lang: 'English' }] });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
test('hosted API backend maps TMDB ids, resolves episodes and merges servers', async () => {
  await withApi(async base => {
    const backend = new ApiBackend({ apiUrl: base, maxServers: 2 });
    assert.equal(await backend.health(), true);
    const movie = await backend.resolve({ type: 'movie', id: '550' });
    assert.equal(movie.provider, 'FlixHQ');
    assert.equal(movie.episodeId, '100');
    assert.deepEqual(movie.sources.map(s => [s.type, s.server]), [['hls', 'upcloud'], ['mp4', 'mixdrop']]);
    assert.deepEqual(movie.subtitles, [{ url: 'https://media.example/en.vtt', lang: 'English', label: 'English' }]);
    const episode = await backend.resolve({ type: 'tv', id: '1399', season: 1, episode: 2 });
    assert.equal(episode.episodeId, 'e2');
    await assert.rejects(backend.resolve({ type: 'movie', id: '404' }), /Media Not found/);
  });
});
test('createResolver selects a backend and honours configured providers', () => {
  assert.ok(createResolver({ tmdbKey: 'k' }) instanceof LibraryBackend);
  assert.ok(createResolver({ mode: 'api' }) instanceof ApiBackend);
  const backend = createResolver({ mode: 'api', providers: 'himovies, sflix', servers: 'mixdrop' });
  assert.deepEqual(backend.ids, ['himovies', 'sflix']);
  assert.deepEqual(backend.servers, ['mixdrop']);
  assert.deepEqual(createResolver({ tmdbKey: 'k', providers: 'nope' }).ids, []);
  assert.equal(createResolver({ tmdbKey: '' }).configured, false);
  assert.equal(Object.keys(PROVIDERS).length > 0, true);
});
