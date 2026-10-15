# Priva Embed

A **Consumet-powered source API and iframe player**, not a streaming catalogue.
The root page is an integration playground: configure a title, preview the iframe,
copy its HTML, and inspect actual API responses.

Sources are resolved with [Consumet](https://docs.consumet.org/) — either the
published [`@consumet/extensions`](https://www.npmjs.com/package/@consumet/extensions)
library running inside this app, or a hosted Consumet REST API.

## Start

Requires **Node.js 22.16+**.

```sh
npm ci
cp .env.example .env
# Edit .env and set TMDB_API_KEY to your own key.
npm start
```

Open **http://localhost:3000/test**. The service binds to `0.0.0.0:3000`.
Without a key, the playground and `/embed/demo` still work, but real source
requests return `503 SETUP_REQUIRED`. No mock results are passed off as extraction.
Do not put the TMDB key in iframe URLs, frontend code, or Git.

### Docker

```sh
cp .env.example .env
# Edit .env and set your key.
docker compose up --build -d
```

Expose only port 3000. Use HTTPS at your reverse proxy for production and when
embedding on HTTPS sites.

## Two ways to resolve sources

### 1. Bundled providers (default)

The app runs `@consumet/extensions` in-process: it scrapes the provider sites
directly, so nothing depends on `api.consumet.org` being up. This needs
`TMDB_API_KEY`, because a TMDB id has to be matched to a provider title first.

Available providers: `flixhq`, `himovies`, `sflix`, `goku` (`CONSUMET_PROVIDERS`,
tried in order — the first one that returns sources wins).

### 2. Hosted Consumet REST API

```sh
CONSUMET_MODE=api
CONSUMET_API_URL=https://api.consumet.org   # or your own instance
```

The app then calls `/meta/tmdb/info/{id}` and `/movies/{provider}/watch` on that
server and proxies the returned streams. No local TMDB key is required, but you
inherit that server's uptime, rate limits, and provider coverage. Point
`CONSUMET_API_URL` only at an instance you control or trust.

## Iframe endpoints

All IDs below are **TMDB IDs**, not IMDb IDs.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/embed/movie/{id}` | Movie player |
| GET | `/embed/tv/{id}/{season}/{episode}` | Episode player |
| GET | `/embed/demo` | Local generated playback test; no extraction |
| GET | `/test` (or `/`) | Integration playground and API reference |

Player query parameters:

- `autoplay=1`: attempt playback automatically, **muted** to satisfy browser policy.
- `muted=1`: start muted even with manual playback.

```html
<iframe
  src="https://YOUR-EMBED-HOST/embed/movie/550"
  style="width:100%;aspect-ratio:16/9;border:0"
  allow="autoplay; fullscreen; picture-in-picture"
  allowfullscreen
></iframe>
```

Episode example: `/embed/tv/1399/1/1?autoplay=1`.
Replace `YOUR-EMBED-HOST` with the domain hosting **this app**. Your catalogue can
be on another domain. Do not configure your reverse proxy to add
`X-Frame-Options: DENY` / `SAMEORIGIN`; it would prevent embedding.

## JSON and media API

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/health` | Mode, configuration and Consumet/TMDB connectivity |
| GET | `/api/sources/movie/{id}` | Resolve movie sources |
| GET | `/api/sources/tv/{id}/{season}/{episode}` | Resolve episode sources |
| GET | `/api/media?token={token}` | Stream the exact signed URL returned by the source API |

```sh
curl https://YOUR-EMBED-HOST/api/health
curl https://YOUR-EMBED-HOST/api/sources/movie/550
curl https://YOUR-EMBED-HOST/api/sources/tv/1399/1/1
```

Each playable source contains `url`, `type` (`hls` or `mp4`), `quality`,
`provider`, and `server`. `subtitles` includes WebVTT tracks only. Source `url`
and subtitle `url` are **same-origin relative URLs**; resolve them against your
embed host if consuming JSON outside this app. `intro`/`outro` are returned when
the provider supplies them. `diagnostics` records every provider/server that was
tried, which is the first place to look when a title fails.

Illustrative response shape (not a real resolved stream):

```json
{
  "provider": "FlixHQ",
  "providerId": "flixhq",
  "mediaId": "movie/watch-fight-club-550",
  "episodeId": "EPISODE_ID",
  "title": "Fight Club",
  "sources": [
    {
      "url": "/api/media?token=SERVER_SIGNED_TOKEN",
      "type": "hls",
      "quality": "1080p",
      "provider": "flixhq",
      "server": "upcloud"
    }
  ],
  "subtitles": [
    { "url": "/api/media?token=SERVER_SIGNED_TOKEN", "lang": "English", "label": "English" }
  ],
  "intro": null,
  "outro": null,
  "diagnostics": [{ "provider": "flixhq", "server": "upcloud", "status": "ok" }]
}
```

Do not construct media tokens yourself. Request fresh sources when links expire.
Wrapper tokens last two hours; actual provider URLs can expire much sooner, and
some are single-use. Signed tokens are integrity-protected, **not encrypted**: do
not treat their contents as secret, log them unnecessarily, or persist them in a
public database.

### Errors

Errors use `{ "error": { "code": "...", "message": "..." } }`. Upstream failures
may additionally include `diagnostics`.

- `400 INVALID_PARAMETER`: invalid numeric ID, season, or episode.
- `403 INVALID_TOKEN`: tampered, missing, or expired media token.
- `404 NO_SOURCES`: no browser-compatible sources were returned.
- `429 RATE_LIMITED`: more than 30 source requests per IP per minute.
- `502 UPSTREAM_ERROR` / `MEDIA_ERROR`: resolver or upstream media failure.
- `503 SETUP_REQUIRED`: missing configuration; `BUSY`: eight unique lookups in flight.
- `504 RESOLVER_TIMEOUT`: resolution took longer than 90 seconds.

Concurrent lookups for the same title are deduplicated. TMDB title lookups and
TMDB→provider id mappings are cached in memory (24h / 6h); resolved stream URLs
are not cached because they expire. The iframe lets users switch sources, falls
back to the next source on fatal playback failure, offers HLS rendition
selection, and uses native video controls for seeking, volume, fullscreen,
captions, and picture-in-picture where available. Native controls and feature
availability vary by browser. DRM/encrypted services requiring a license server,
external embed pages, DASH, and MKV are not supported. HLS AES-128 media keys are
delivered as part of normal playlist playback.

## Configuration

See `.env.example` for all settings:

- `PORT`: public wrapper port (default `3000`).
- `TMDB_API_KEY`: used server-side to map TMDB ids to provider titles (bundled mode).
- `CONSUMET_MODE`: `library` (default) or `api`.
- `CONSUMET_API_URL`: Consumet REST API origin for `CONSUMET_MODE=api`.
- `CONSUMET_PROVIDERS`: comma-separated providers, tried in order.
- `CONSUMET_SERVERS`: preferred streaming servers, in order.
- `CONSUMET_MAX_SERVERS`: how many servers to try per title (1–6, default `3`).
- `MEDIA_TOKEN_SECRET`: stable random signing secret, recommended 32+ characters.
  Without it, restarts invalidate existing media tokens. Set the same secret on
  all replicas.
- `FRAME_ANCESTORS`: space-separated iframe parent origins. Default `*` allows
  embedding anywhere. Example: `https://your-site.example https://www.your-site.example`.

### Deployment/security boundaries

Media delivery validates URLs, rejects private/reserved IPs, pins DNS results
during connections, validates redirect targets, rewrites HLS playlists (including
segments, keys, alternate tracks and initialization maps), forwards only a small
allow-list of provider headers, and supports byte ranges. Media HTML/scripts are
rejected and responses are sandboxed. The wrapper forwards no browser cookies or
authentication headers to media hosts.

The bundled scrapers are third-party code and are **not a hardened public
service**. Configure network-level egress rules to block private/metadata
networks for this process as well. The proxy's checks do not sandbox the
scrapers' own provider fetches. Never set `CONSUMET_API_URL` from untrusted input.

There is **no account authentication**. Signed media links are temporary bearer
capabilities, not user authorization. Source resolution is rate/concurrency
limited, but media bandwidth and the playground are not access-controlled. For a
public deployment add appropriate reverse-proxy/CDN rate limits and bandwidth
quotas, and authentication if needed. `FRAME_ANCESTORS` prevents unwanted iframe
parents but is not API authentication. Source JSON has no cross-origin CORS
permission by default; a remote iframe works without CORS. Fetch JSON from your
site's backend, or configure a narrowly scoped CORS policy at your proxy.

The app does not trust forwarded IP headers by default. Behind a proxy, its
per-IP limiter may count all visitors together. Set trusted-proxy handling only
for your known infrastructure or use edge rate limiting. Multiple replicas need
shared rate/concurrency limits and the same `MEDIA_TOKEN_SECRET`.

## Tests

```sh
npm test           # routing/errors, signed tokens, URL safety, playlist rewriting, resolver behaviour
npm run test:browser   # Playwright: starts the app in setup-required mode and drives the UI
npm audit
```

`npm run test:browser` uses Playwright with the bundled Sparticuz Chromium dev
dependency. It checks actual local MP4 playback, episode iframe generation, setup
error handling, API inspection, and mobile overflow. Chromium requires OS
libraries; supply `CHROMIUM_EXECUTABLE_PATH` to use your own compatible browser
if needed. Test screenshots go into ignored `.cache/`.

Live extraction needs outbound access to TMDB and the selected providers.
Provider hosts were inaccessible in the development sandbox, so **live
extraction/playback has not been verified here**. The resolver tests use stubbed
providers and a mock Consumet REST API; a working demo does not imply that a
particular provider works. Provider availability, anti-bot protection, expiring
URLs, geoblocking, codecs and host restrictions can cause playback failures, and
scrapers break whenever a provider changes its markup.

## Upstream and license

Source resolution uses [Consumet](https://github.com/consumet/consumet.ts),
distributed on npm as `@consumet/extensions` under the **MIT** license. See
`node_modules/@consumet/extensions/LICENSE` for the full text.

> Note: the Consumet GitHub repositories (`consumet/consumet.ts` and
> `consumet/api.consumet.org`) were disabled by a GitHub DMCA takedown in March
> 2026 and cannot be cloned; the published npm package is used instead.

This application code is provided as-is. It does not include a media catalogue,
bypass DRM, or host third-party movies. `public/demo.mp4` is a generated 12-second
FFmpeg color-pattern/sine-wave test clip, not copyrighted film content. Use only
media you are authorized to access, and check the laws that apply to you.
