import crypto from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import ipaddr from 'ipaddr.js';

export function publicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function validateUrl(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port))) throw new Error('Unsupported media URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host) && !publicAddress(host)) throw new Error('Private media address blocked');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Local host blocked');
  return url;
}
function lookup(host, options, callback) {
  dns.lookup(host, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) return callback(new Error('Private DNS address blocked'));
    callback(null, options.all ? addresses : addresses[0].address, addresses[0].family);
  });
}
export function createTokens(secret) {
  return {
    sign(data, expires = Date.now() + 2 * 60 * 60 * 1000) {
      const body = Buffer.from(JSON.stringify({ ...data, expires })).toString('base64url');
      return body + '.' + crypto.createHmac('sha256', secret).update(body).digest('base64url');
    },
    read(token) {
      if (typeof token !== 'string' || token.length > 24000) throw new Error('Invalid media token');
      const [body, signature, extra] = token.split('.');
      const expected = crypto.createHmac('sha256', secret).update(body || '').digest();
      const actual = Buffer.from(signature || '', 'base64url');
      if (extra || actual.length !== expected.length || !crypto.timingSafeEqual(expected, actual)) throw new Error('Invalid media token');
      const data = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (!Number.isFinite(data.expires) || data.expires < Date.now()) throw new Error('Media token expired; reload sources');
      validateUrl(data.url);
      return data;
    }
  };
}
// CinePro providers wrap the real stream URL and required headers in OMSS proxy data.
export function unwrapSource(value) {
  const parsed = new URL(value, 'http://core.internal');
  if (parsed.pathname === '/v1/proxy') {
    let data = parsed.searchParams.get('data');
    for (let i = 0; i < 3; i++) {
      try { const result = JSON.parse(data); validateUrl(result.url); return result; }
      catch { data = decodeURIComponent(data); }
    }
    throw new Error('Invalid Core proxy URL');
  }
  validateUrl(value);
  return { url: value, headers: {} };
}
function safeHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).filter(([k, v]) =>
    ['referer', 'origin', 'user-agent', 'accept', 'accept-language', 'authorization', 'cookie'].includes(k.toLowerCase()) && typeof v === 'string'));
}
export function rewritePlaylist(text, base, data, tokens) {
  const link = value => {
    const url = validateUrl(new URL(value, base).href).href;
    return '/api/media?token=' + tokens.sign({ url, headers: data.headers }, data.expires);
  };
  return text.split(/\r?\n/).map(line => {
    if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${link(uri)}"`);
    return line.trim() ? link(line.trim()) : line;
  }).join('\n');
}
function open(url, headers, signal, redirects = 0) {
  return new Promise((resolve, reject) => {
    const target = validateUrl(url);
    const req = (target.protocol === 'https:' ? https : http).get(target, {
      headers: { ...headers, 'accept-encoding': 'identity' }, lookup, signal,
      timeout: 20000
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirects >= 5) return reject(new Error('Too many media redirects'));
        try {
          const next = validateUrl(new URL(response.headers.location, target).href);
          const forwarded = { ...headers };
          if (next.origin !== target.origin) for (const key of Object.keys(forwarded)) {
            if (['authorization', 'cookie'].includes(key.toLowerCase())) delete forwarded[key];
          }
          resolve(open(next.href, forwarded, signal, redirects + 1));
        } catch (err) { reject(err); }
      } else resolve({ response, url: target.href });
    });
    req.on('timeout', () => req.destroy(new Error('Media request timed out')));
    req.on('error', reject);
  });
}
export async function proxyMedia(req, res, tokens) {
  let data;
  try { data = tokens.read(req.query.token); } catch (error) { return res.status(403).json({ error: { code: 'INVALID_TOKEN', message: error.message } }); }
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const headers = safeHeaders(data.headers);
  if (req.headers.range) headers.Range = req.headers.range;
  try {
    const { response, url } = await open(data.url, headers, controller.signal);
    if (![200, 206, 416].includes(response.statusCode)) { response.destroy(); throw new Error('Media host rejected the request'); }
    const type = String(response.headers['content-type'] || '').split(';')[0];
    const playlist = /mpegurl/i.test(type) || /\.m3u8(?:\?|$)/i.test(url);
    res.status(response.statusCode).set('Cache-Control', 'private, no-store');
    // Sandboxing and nosniff also apply to navigations to media URLs.
    res.set('Content-Security-Policy', "sandbox; default-src 'none'");
    if (playlist) {
      let size = 0; const chunks = [];
      for await (const chunk of response) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { response.destroy(); throw new Error('Playlist too large'); }
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid HLS playlist');
      return res.type('application/vnd.apple.mpegurl').send(rewritePlaylist(text, url, data, tokens));
    }
    if (/html|javascript|xml/i.test(type)) { response.destroy(); throw new Error('Unexpected media format'); }
    res.set('Content-Type', type || 'application/octet-stream');
    for (const key of ['content-range', 'accept-ranges', 'content-length']) if (response.headers[key]) res.set(key, response.headers[key]);
    response.on('error', () => res.destroy());
    response.pipe(res);
  } catch (error) {
    if (!res.headersSent && !res.destroyed) res.status(502).json({ error: { code: 'MEDIA_ERROR', message: error.message } });
    else res.destroy();
  }
}
