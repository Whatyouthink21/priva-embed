import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { createTokens, publicAddress, validateUrl, rewritePlaylist } from '../src/media.js';
async function withApp(options, run) {
  const server = createApp(options).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
function fakeResolver(result, calls = []) {
  return {
    calls,
    async health() { return true; },
    async resolve(query) {
      calls.push(query);
      if (typeof result === 'function') return result(query);
      return result;
    }
  };
}
const payload = {
  provider: 'FlixHQ',
  providerId: 'flixhq',
  mediaId: 'movie/watch-test-1',
  episodeId: '9',
  title: 'Test Movie',
  headers: { Referer: 'https://provider.example/' },
  sources: [
    { url: 'https://media.example/master.m3u8', type: 'hls', quality: '1080p', provider: 'FlixHQ', server: 'upcloud' },
    { url: 'https://media.example/file.mpd', type: 'dash', quality: '1080p' },
    { url: 'https://media.example/page', type: 'embed' },
    { url: 'http://127.0.0.1/private.mp4', type: 'mp4' }
  ],
  subtitles: [
    { url: 'https://media.example/en.vtt', lang: 'English', label: 'English' },
    { url: 'http://127.0.0.1/x.vtt', lang: 'Private' }
  ],
  diagnostics: [{ provider: 'flixhq', server: 'upcloud', status: 'ok' }]
};
test('health honestly reports missing setup; sources return actionable errors', async () => {
  await withApp({}, async base => {
    const health = await (await fetch(base + '/api/health')).json();
    assert.equal(health.status, 'setup_required');
    assert.equal(health.consumet.configured, false);
    const response = await fetch(base + '/api/sources/movie/550');
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'SETUP_REQUIRED');
  });
});
test('health reports readiness and mode when a resolver is configured', async () => {
  await withApp({ resolver: fakeResolver(payload), configured: true, mode: 'api' }, async base => {
    const health = await (await fetch(base + '/api/health')).json();
    assert.equal(health.status, 'ready');
    assert.equal(health.mode, 'api');
    assert.equal(health.consumet.reachable, true);
  });
});
test('validates movie and episode IDs before upstream access', async () => {
  await withApp({ resolver: fakeResolver(payload), configured: true }, async base => {
    for (const route of ['/movie/abc', '/movie/0', '/tv/1/0/2', '/tv/1/1/-2', '/movie/999999999999']) {
      assert.equal((await fetch(base + '/api/sources' + route)).status, 400, route);
    }
  });
});
test('movie and TV map to Consumet, sign source URLs and drop unsupported formats', async () => {
  const calls = [];
  const tokens = createTokens('test');
  await withApp({ resolver: fakeResolver(payload, calls), configured: true, secret: 'test' }, async base => {
    for (const [endpoint, expected] of [
      ['/api/sources/movie/550', { type: 'movie', id: '550', season: undefined, episode: undefined }],
      ['/api/sources/tv/1399/1/2', { type: 'tv', id: '1399', season: 1, episode: 2 }]
    ]) {
      const response = await fetch(base + endpoint); assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.sources.length, 1);
      assert.equal(body.subtitles.length, 1);
      assert.equal(body.title, 'Test Movie');
      assert.equal(body.provider, 'FlixHQ');
      const token = new URL(body.sources[0].url, base).searchParams.get('token');
      const decoded = tokens.read(token);
      assert.equal(decoded.url, 'https://media.example/master.m3u8');
      assert.equal(decoded.headers.Referer, 'https://provider.example/');
      assert.deepEqual(calls.at(-1), expected);
    }
  });
});
test('propagates resolver errors, timeouts and empty results', async () => {
  const cases = [
    [async () => { throw Object.assign(new Error('boom'), { diagnostics: [{ provider: 'flixhq', error: 'boom' }] }); }, 502, 'UPSTREAM_ERROR'],
    [async () => { throw Object.assign(new Error('slow'), { name: 'TimeoutError' }); }, 504, 'RESOLVER_TIMEOUT'],
    [async () => ({ provider: 'FlixHQ', headers: {}, sources: [], subtitles: [], diagnostics: [] }), 404, 'NO_SOURCES']
  ];
  for (const [resolve, status, code] of cases) await withApp({ resolver: { resolve, health: async () => true }, configured: true }, async base => {
    const response = await fetch(base + '/api/sources/movie/550');
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  });
});
test('tokens reject tampering, expiration and unsigned media requests', async () => {
  const tokens = createTokens('secret');
  const token = tokens.sign({ url: 'https://media.example/file.mp4' });
  assert.equal(tokens.read(token).url, 'https://media.example/file.mp4');
  assert.throws(() => tokens.read(token + 'x'));
  assert.throws(() => tokens.read(tokens.sign({ url: 'https://media.example/x' }, Date.now() - 100)));
  await withApp({}, async base => assert.equal((await fetch(base + '/api/media?url=https://example.com')).status, 403));
});
test('blocks private addresses, mapped IPv6, unsafe protocols and arbitrary ports', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1', '100.64.0.1']) assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true);
  for (const url of ['file:///etc/passwd', 'http://localhost/x', 'http://127.1/x', 'https://example.com:1234/x', 'http://[::ffff:127.0.0.1]/', 'https://user:pass@example.com']) assert.throws(() => validateUrl(url), url);
});
test('rewrites HLS variants, segments, encryption keys and map URIs with original expiration', () => {
  const tokens = createTokens('secret'); const expires = Date.now() + 10000;
  const text = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n../720/index.m3u8\nchunk.ts';
  const rewritten = rewritePlaylist(text, 'https://media.example/main/master.m3u8', { headers: { Referer: 'https://provider.example' }, expires }, tokens);
  const matches = [...rewritten.matchAll(/token=([A-Za-z0-9_.-]+)/g)].map(match => tokens.read(match[1]));
  assert.equal(matches.length, 4);
  assert.equal(matches[2].url, 'https://media.example/720/index.m3u8');
  assert.ok(matches.every(match => match.expires === expires));
  assert.throws(() => rewritePlaylist('#EXTM3U\nhttp://127.0.0.1/x', 'https://media.example/a', { expires }, tokens));
});
test('iframe routes, local HLS asset, media range delivery and CSP', async () => {
  await withApp({}, async base => {
    for (const url of ['/test', '/embed/movie/550', '/embed/tv/1399/1/2', '/embed/demo', '/assets/hls.min.js']) {
      const response = await fetch(base + url); assert.equal(response.status, 200, url);
      assert.match(response.headers.get('content-security-policy'), /frame-ancestors \*/);
    }
    const range = await fetch(base + '/demo.mp4', { headers: { Range: 'bytes=0-99' } });
    assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 100);
    assert.equal((await fetch(base + '/v1/proxy?data=whatever')).status, 404);
  });
});
