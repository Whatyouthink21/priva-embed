# Priva Embed

A drop-in **iframe player** for movies and TV shows. It resolves real streams on the
server from three source engines, which are only ever exposed under their codenames:

| Codename | Engine |
| -------- | ------ |
| **Clarke** | castle |
| **Bellamy** | autoembed (multi-extractor) |
| **Raven** | movieboxweb |

## Embed it

```html
<iframe
  src="https://YOUR-RENDER-APP.onrender.com/player/550?theme=ffffff"
  width="100%"
  height="100%"
  frameborder="0"
  allowfullscreen
  allow="encrypted-media; autoplay; picture-in-picture; fullscreen"
></iframe>
```

Responsive 16:9 wrapper:

```html
<div style="position:relative;padding-bottom:56.25%;height:0;">
  <iframe
    src="https://YOUR-RENDER-APP.onrender.com/player/550"
    style="position:absolute;top:0;left:0;width:100%;height:100%;"
    frameborder="0"
    allowfullscreen
    allow="encrypted-media; autoplay; picture-in-picture; fullscreen"
  ></iframe>
</div>
```

### Endpoints

| What | URL |
| ---- | --- |
| Movie | `/player/{tmdb_id}` |
| TV | `/player/{tmdb_id}/{season}/{episode}` |
| Alias | `/embed/movie/{tmdb_id}`, `/embed/tv/{tmdb_id}/{season}/{episode}` |
| Docs page | `/embed` |

### Query parameters

| Param | Default | Meaning |
| ----- | ------- | ------- |
| `theme` | `ffffff` | Accent colour (hex, no `#`) |
| `autoplay` / `autoPlay` | `0` | Try to start playback as soon as sources resolve |
| `autoNext` | `1` | Auto-play the next episode |
| `title` | – | Show this title instead of the TMDB one |
| `poster` | – | Custom poster/backdrop image |
| `provider` | `auto` | `clarke`, `bellamy`, `raven` or `auto` |
| `muted` | `1` | Start muted (helps browser autoplay policies) |
| `start` | `0` | Start offset in seconds |
| `lang` | – | Preferred subtitle language (ISO-639-1) |

### Events (window.postMessage)

The player posts these to the parent window:

```js
{ source: "priva-embed", event: "ready",     payload: { tmdbId, type, title } }
{ source: "priva-embed", event: "sources",   payload: { provider, count } }
{ source: "priva-embed", event: "play",      payload: { currentTime, duration } }
{ source: "priva-embed", event: "pause",     payload: { currentTime, duration } }
{ source: "priva-embed", event: "timeupdate",payload: { currentTime, duration } }
{ source: "priva-embed", event: "ended",     payload: { currentTime, duration } }
{ source: "priva-embed", event: "provider",  payload: { provider } }
{ source: "priva-embed", event: "error",     payload: { message } }
```

### Commands (parent → player)

```js
iframe.contentWindow.postMessage({ source: "priva-parent", command: "play" }, "*");
iframe.contentWindow.postMessage({ source: "priva-parent", command: "pause" }, "*");
iframe.contentWindow.postMessage({ source: "priva-parent", command: "seek", value: 120 }, "*");
iframe.contentWindow.postMessage({ source: "priva-parent", command: "setProvider", value: "bellamy" }, "*");
```

## Player controls

Hover or tap the frame to bring the chrome back while playing; it stays pinned while
paused. Menus in the bottom bar (subtitles, settings) open upward into the player, so
they never fall outside a short iframe. The bottom bar has play/pause, −10s / +10s, mute, a volume slider, the
scrubber, time, subtitles, settings (speed + subtitles), picture-in-picture and
fullscreen. The top bar has back, the sources pill (Clarke / Bellamy / Raven) and the
quality pill; on TV the episode pill opens the drawer.

## Provider status

| Engine | Status |
| ------ | ------ |
| **Clarke** | Working. Encrypted-envelope API; verified live across movies and TV. |
| **Bellamy** | Working. Fans out to the three sub-extractors and merges links. |
| **Raven** | Resolves links, but the media CDN answers **426/429** to datacenter IPs. Same on GitHub Actions and Render, so its links usually will not play from a hosted server. The player detects the failure and falls through to Clarke/Bellamy. |

The player tries Clarke first, then Bellamy, then Raven, and only moves on when a link
actually fails — so a dead engine never blocks playback.

## Preview mode (`?demo=1`)

Add `demo=1` to any player URL to run the full UI against sample metadata and public
test streams — no provider or TMDB traffic:

```
/player/550?demo=1            Fight Club (movie)
/player/1396/2/3?demo=1       Breaking Bad S2E3
```

Demo mode is **opt-in**: the docs preview and every copied snippet use real providers.
Tick the **demo** switch in the configurator to append `demo=1` manually.

## Deploy to Render

**Blueprint (recommended)**

1. Push this repo to GitHub.
2. Render → **New → Blueprint** → pick the repo. `render.yaml` is detected.
3. Add `TMDB_API_KEY` when prompted (optional — a public fallback key is baked in).
4. Deploy, then open `https://YOUR-APP.onrender.com/embed`.

**Manual web service**

| Setting | Value |
| ------- | ----- |
| Runtime | Node |
| Build command | `npm install` |
| Start command | `npm start` |
| Health check path | `/healthz` |

Environment variables:

| Var | Default | Meaning |
| --- | ------- | ------- |
| `PORT` | `3000` | Render sets this automatically |
| `TMDB_API_KEY` | bundled fallback | Your own TMDB v3 key |
| `PUBLIC_URL` | request host | Canonical origin used in docs snippets (Render sets `RENDER_EXTERNAL_URL` automatically) |
| `ALLOWED_ORIGINS` | *(empty = any site)* | Comma separated allowlist for `frame-ancestors` |

> The free Render plan sleeps after inactivity; the first request after a nap takes a
> few seconds. The player shows its "Finding sources" splash during that window.

## Local development

```bash
npm install
npm start          # http://localhost:3000/embed  (docs + live preview)
                   # http://localhost:3000/player/550?demo=1
npm run dev        # same, with --watch
npm test           # unit + proxy + jsdom player tests
```

## How it works

1. The browser asks `/api/sources` for a TMDB id.
2. The server resolves metadata from TMDB, then queries the three engines in
   parallel (Clarke, Bellamy, Raven) with a per-provider timeout.
3. Streams, keys and subtitles are returned as same-origin proxy URLs
   (`/api/stream`, `/api/subtitle`) so HLS playlists, AES keys, segments and SRT
   tracks all load without CORS or `Referer` problems.
4. `player.js` plays them with hls.js, falling through mirrors and providers if a
   link dies, and reports state to the parent window via `postMessage`.

Each provider is capped by a timeout (12s) and its links are deduplicated before
they reach the player; the player itself is bounded to 8 fallback attempts, so a
dead source cannot pin the browser in a retry loop.
