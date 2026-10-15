# Priva Embed

A **CinePro-powered source API and iframe player**, not a streaming catalogue.
The root page is an integration playground: configure a title, preview the iframe,
copy its HTML, and inspect actual API responses.

## Start

Requires **Node.js 22.16+** and a **TMDB API key** for bundled extraction.

```sh
npm ci
cp .env.example .env
# Edit .env and set TMDB_API_KEY to your own key.
npm run build
npm start
```

Open **http://localhost:3000/test**. The service binds to `0.0.0.0:3000`.
Without a key, the playground and `/embed/demo` still work, but real source
requests return `503 SETUP_REQUIRED`. No mock results are passed off as extraction.
Do not put the TMDB key in iframe URLs, frontend code, or Git.

Alternatively, set `CINEPRO_URL` to an existing **CinePro Core** server. This
supersedes the bundled process and does not require a local TMDB key. Core must
remain private. Its host must be reachable **from the server**, not the browser.
The old CinePro Backend API is not supported; it has moved to Core.

### Docker

```sh
cp .env.example .env
# Edit .env and set your key.
docker compose up --build -d
```

Expose only port 3000. The bundled Core runs internally on `127.0.0.1:3101`.
Use HTTPS at your reverse proxy for production and when embedding on HTTPS sites.
Run `npm run build` again after updating upstream sources.

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
| GET | `/api/health` | Configuration and Core connectivity status |
| GET | `/api/sources/movie/{id}` | Resolve movie sources |
| GET | `/api/sources/tv/{id}/{season}/{episode}` | Resolve episode sources |
| GET | `/api/media?token={token}` | Stream the exact signed URL returned by the source API |

```sh
curl https://YOUR-EMBED-HOST/api/health
curl https://YOUR-EMBED-HOST/api/sources/movie/550
curl https://YOUR-EMBED-HOST/api/sources/tv/1399/1/1
```

Successful source responses retain Core's `responseId`, `expiresAt`, and
`diagnostics`. Each playable source contains `url`, `type`, `quality`,
`audioTracks`, and `provider` (as provided by CinePro). `subtitles` includes WebVTT
tracks only. Source `url` and subtitle `url` are **same-origin relative URLs**;
resolve them against your embed host if consuming JSON outside this app.

Illustrative response shape (not a real resolved stream):

```json
{
  "responseId": "CORE_RESPONSE_ID",
  "expiresAt": "CORE_EXPIRY_TIMESTAMP",
  "sources": [
    {
      "url": "/api/media?token=SERVER_SIGNED_TOKEN",
      "type": "hls",
      "quality": "1080p",
      "audioTracks": [],
      "provider": { "id": "provider-id", "name": "Provider name" }
    }
  ],
  "subtitles": [],
  "diagnostics": []
}
```

Do not construct media tokens yourself. Request fresh sources when links expire.
Wrapper tokens last two hours; actual provider URLs may expire sooner. The Core
`expiresAt` is its cache expiry, not a guarantee that every upstream URL will work.
Signed tokens are integrity-protected, **not encrypted**: do not treat their
contents as secret, log them unnecessarily, or persist them in a public database.

### Errors

Errors use `{ "error": { "code": "...", "message": "..." } }`. Upstream Core
errors may additionally include a `traceId` and `details`.

- `400 INVALID_PARAMETER`: invalid numeric ID, season, or episode.
- `403 INVALID_TOKEN`: tampered, missing, or expired media token.
- `404 NO_SOURCES`: no browser-compatible sources (or a Core 404).
- `429 RATE_LIMITED`: more than 30 source requests per IP per minute.
- `502 UPSTREAM_ERROR` / `MEDIA_ERROR`: resolver or upstream media failure.
- `503 SETUP_REQUIRED`: missing configuration; `BUSY`: eight unique lookups in flight.
- `504 RESOLVER_TIMEOUT`: Core took longer than 90 seconds.

Concurrent lookups for the same title are deduplicated. CinePro handles the source
cache. The iframe lets users select providers, switches sources on fatal playback
failure, offers HLS rendition selection, and uses native video controls for
seeking, volume, fullscreen, captions, and picture-in-picture where available.
Native controls and feature availability vary by browser. DRM/encrypted services
requiring a license server, external embed pages, DASH, and MKV are not supported.
HLS AES-128 media keys are delivered as part of normal playlist playback.

## Configuration

See `.env.example` for optional settings:

- `PORT`: public wrapper port (default `3000`).
- `TMDB_API_KEY`: key used only in the server-side CinePro process.
- `CINEPRO_URL`: trusted private Core origin (optional).
- `MEDIA_TOKEN_SECRET`: stable random signing secret, recommended 32+ characters.
  Without it, restarts invalidate existing media tokens. Set the same secret on
  all replicas.
- `FRAME_ANCESTORS`: space-separated iframe parent origins. Default `*` allows
  embedding anywhere. Example: `https://your-site.example https://www.your-site.example`.
- Core additionally reads `CACHE_TYPE`, `REDIS_HOST`, `REDIS_PORT`, and
  `REDIS_PASSWORD`; see `vendor/cinepro/README.md` and upstream documentation.

### Deployment/security boundaries

The app does not expose Core's arbitrary `/v1/proxy` endpoint. Only URLs issued
from trusted Core responses can be proxied. Media delivery validates URLs,
rejects private/reserved IPs, pins DNS results during connections, validates
redirect targets, rewrites HLS playlists (including segments, keys, alternate
tracks and initialization maps), preserves required provider headers, and
forwards byte ranges. Media HTML/scripts are rejected and responses are sandboxed.
The wrapper forwards no browser cookies or authentication headers to media hosts.

The raw Core scraper itself is third-party code and is **not a hardened public
service**. Keep Core private and configure network-level egress rules to block
private/metadata networks for it, too. The wrapper's media checks do not sandbox
Core's internal provider fetches. Never set `CINEPRO_URL` from untrusted input.

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
npm test          # API routing/errors, signed tokens, URL safety, playlist rewriting, static media ranges
npm run build    # Type-check and compile all bundled CinePro provider sources
npm audit
npm audit --prefix vendor/cinepro
```

With the server running, `npm run test:browser` uses Playwright and the bundled
Sparticuz Chromium dev dependency. It checks actual local MP4 playback, episode
iframe generation, setup error handling, API inspection, and mobile overflow.
Chromium requires OS libraries; supply `CHROMIUM_EXECUTABLE_PATH` to use your own
compatible browser if needed. Test screenshots go into ignored `.cache/`.

Live CinePro extraction requires a valid TMDB key and outbound access to TMDB and
all selected providers. Provider hosts were inaccessible in the development
sandbox, so **live extraction/playback has not been verified here**. Tests use
mock Core responses for resolver integration and an explicitly labeled, locally
generated video for real browser playback. A working demo does not imply that a
particular provider works. Provider availability, anti-bot protection, expiring
URLs, geoblocking, codecs and host restrictions can cause playback failures.

## Upstream and license

CinePro's official backend moved from `cinepro-org/backend` to
**https://github.com/cinepro-org/core**. All provider/utility TypeScript sources
are vendored under `vendor/cinepro/` at revision
`98ba005f75d2675877774f5a676b3bc1c4150c27`. The original source code is unmodified;
compatible dependency security updates were applied to the lockfile. See
`vendor/cinepro/UPSTREAM.md` for provenance and `vendor/cinepro/LICENSE` for terms.

**CinePro Core uses PolyForm Noncommercial 1.0.0.** This rebuild does not remove
those restrictions. Do not assume you can use it for a commercial, monetized, or
ad-supported service; obtain appropriate permissions first. Use only media you
are authorized to access. This app does not include a media catalogue, bypass
DRM, or host third-party movies. `public/demo.mp4` is a generated 12-second FFmpeg
color-pattern/sine-wave test clip, not copyrighted film content.
