import express from "express";
import cors from "cors";
import path from "path";
import { resolveTmdbMeta } from "./lib/tmdb";
import {
  clarkeStreams,
  ravenStreams,
  bellamyStreams,
  ALL_PROVIDERS,
  PROVIDER_DISPLAY,
} from "./providers/registry";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ORIGIN_ALLOW = process.env.CORS_ORIGIN || "*";

app.set("trust proxy", 1);
app.use(cors({ origin: ORIGIN_ALLOW }));
app.use(express.json());

// Allow the embed to be iframed anywhere (no frame-ancestors restrictions).
app.use((_req, res, next) => {
  res.removeHeader("X-Frame-Options");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "priva-embed", providers: ALL_PROVIDERS });
});

/* Resolve TMDB id -> display metadata (title, poster, year, ...) */
app.get("/api/meta", async (req, res) => {
  const tmdbId = String(req.query.tmdb_id || "").trim();
  const type = (req.query.type as "movie" | "series") || "movie";
  if (!tmdbId) {
    return res.status(400).json({ error: "tmdb_id is required" });
  }
  try {
    const meta = await resolveTmdbMeta(tmdbId, type);
    res.json(meta);
  } catch (err: any) {
    res.status(502).json({
      error: "tmdb resolution failed",
      detail: err?.message || String(err),
    });
  }
});

/* Fetch streams from all three providers (Clarke / Raven / Bellamy) */
app.get("/api/streams", async (req, res) => {
  const tmdbId = String(req.query.tmdb_id || "").trim();
  const type = String(req.query.type || "movie");
  const season = Number(req.query.season) || 1;
  const episode = Number(req.query.episode) || 1;
  const title = String(req.query.title || "");
  const year = String(req.query.year || "");
  const imdbId = String(req.query.imdb_id || "");

  if (!tmdbId) {
    return res.status(400).json({ error: "tmdb_id is required" });
  }

  const input: any = { tmdbId, type, season, episode, title, year, imdbId };

  const results = await Promise.all([
    clarkeStreams(input),
    ravenStreams(input),
    bellamyStreams(input),
  ]);

  const streams: any[] = [];
  for (const r of results) {
    for (const s of r.streams) {
      streams.push({
        provider: PROVIDER_DISPLAY[r.provider],
        providerId: r.provider,
        server: s.server,
        link: s.link,
        type: s.type,
        quality: s.quality,
        tag: s.tag,
        tags: s.tags,
        subtitles: s.subtitles,
        headers: s.headers,
      });
    }
  }

  // Best quality first
  streams.sort((a, b) => {
    const qa = parseInt(String(a.quality || "0"), 10);
    const qb = parseInt(String(b.quality || "0"), 10);
    return qb - qa;
  });

  res.json({
    tmdbId,
    type,
    season,
    episode,
    providers: results.map((r) => ({
      provider: PROVIDER_DISPLAY[r.provider],
      ok: r.ok,
      count: r.streams.length,
      error: r.error,
    })),
    streams,
  });
});

/* ---------- Embed player pages ---------- */
const publicDir = path.join(process.cwd(), "public");

const playerShell = (tmdbId: string, season?: string, episode?: string) => `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Priva Embed</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<link rel="stylesheet" href="/style.css">
<script src="/player.js" defer></script>
</head>
<body data-tmdb-id="${tmdbId}" data-season="${season || ""}" data-episode="${episode || ""}" data-api-base="">
<div id="root"></div>
</body>
</html>
`;

app.get("/player/:tmdb_id", (req, res) => {
  res.send(playerShell(req.params.tmdb_id));
});

app.get("/player/:tmdb_id/:season/:episode", (req, res) => {
  res.send(playerShell(req.params.tmdb_id, req.params.season, req.params.episode));
});

/* Landing page with iframe embed instructions */
app.get("/", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Priva Embed</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d12;color:#e8eaf2;line-height:1.6} .max{max-width:900px;margin:40px auto;padding:0 20px} h1{font-size:2rem;margin-bottom:.5rem} .card{background:#13151f;border:1px solid #25293b;border-radius:12px;padding:24px;margin:24px 0} code{background:#1d202c;padding:2px 6px;border-radius:4px;color:#7dd3fc} pre{background:#10121c;border:1px solid #25293b;border-radius:8px;padding:16px;overflow:auto} .endpoint{color:#7dd3fc;font-weight:700} .badge{display:inline-block;background:#25293b;padding:2px 8px;border-radius:10px;font-size:.8rem;margin-right:6px}</style>
</head><body>
<div class="max">
<h1>🎬 Priva Embed</h1>
<p>API embed player for movies &amp; TV shows. Drop an iframe into your streaming site and stream instantly.</p>

<div class="card">
<h2>Endpoints</h2>
<p><span class="endpoint">GET /player/{tmdb_id}</span> — Movie embed<br>
<span class="endpoint">GET /player/{tmdb_id}/{season}/{episode}</span> — TV show embed</p>
</div>

<div class="card">
<h2>Basic usage</h2>
<pre>&lt;iframe
  src="https://priva-embed.onrender.com/player/550"
  width="100%"
  height="100%"
  frameborder="0"
  allowfullscreen
  allow="encrypted-media"&gt;&lt;/iframe&gt;</pre>
</div>

<div class="card">
<h2>Responsive 16:9</h2>
<pre>&lt;div style="position:relative;padding-bottom:56.25%;height:0;"&gt;
  &lt;iframe src="https://priva-embed.onrender.com/player/550"
    style="position:absolute;top:0;left:0;width:100%;height:100%;"
    frameborder="0" allowfullscreen allow="encrypted-media"&gt;&lt;/iframe&gt;
&lt;/div&gt;</pre>
</div>

<div class="card">
<h2>Providers</h2>
<p>Three extractors back the player (shown by codename only): <span class="badge">Clarke</span> <span class="badge">Raven</span> <span class="badge">Bellamy</span></p>
<p><span class="endpoint">GET /api/health</span> — service health</p>
</div>
</div>
</body></html>`);
});

app.use(express.static(publicDir));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Priva Embed listening on http://0.0.0.0:${PORT}`);
});
