import express from "express";
import { getMeta, fallbackMeta } from "../tmdb.js";
import { renderPlayer } from "../views/player.js";
import { renderDocs } from "../views/docs.js";
import { demoMeta } from "../demo.js";
import { asyncRoute } from "../lib/express.js";

const router = express.Router();

function sanitizeHex(value) {
  if (!value) return "ffffff";
  const raw = String(value).trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return raw
      .split("")
      .map((char) => char + char)
      .join("")
      .toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  return "ffffff";
}

const truthy = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

function numberParam(value, fallback = 0) {
  const parsed = Number(String(value ?? "").replace(/[^0-9]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function requestBase(req) {
  const configured = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  if (configured) return configured.replace(/\/+$/, "");
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function configFromQuery(req) {
  const query = req.query;
  return {
    theme: `#${sanitizeHex(query.theme || query.color)}`,
    autoplay: truthy(query.autoplay ?? query.autoPlay, false),
    autoNext: truthy(query.autoNext ?? query.autonext, true),
    provider: ["clarke", "bellamy", "nova"].includes(String(query.provider || "").toLowerCase())
      ? String(query.provider).toLowerCase()
      : "auto",
    lang: String(query.lang || "").slice(0, 5),
    muted: truthy(query.muted, false),
    start: numberParam(query.start, 0),
    displayTitle: String(query.title || "").slice(0, 120),
    poster: /^https?:\/\//i.test(String(query.poster || "")) ? String(query.poster) : "",
    seasonOverride: numberParam(query.season, 0),
    demo: truthy(query.demo, false),
    embed: true,
  };
}

async function servePlayer(req, res, { type, tmdbId, season, episode }) {
  const kind = String(type).toLowerCase() === "tv" ? "tv" : "movie";
  const id = String(tmdbId || "").replace(/[^0-9]/g, "");
  if (!id) return res.status(400).send("A numeric TMDB id is required.");

  const config = configFromQuery(req);
  const seasonNumber = numberParam(season, 1);
  const episodeNumber = numberParam(episode, 1);

  let meta;
  if (config.demo) {
    meta = demoMeta(kind);
    if (config.displayTitle) meta.title = config.displayTitle;
    if (config.poster) {
      meta.backdrop = config.poster;
      meta.backdropLarge = config.poster;
      meta.poster = config.poster;
    }
  } else {
    try {
      meta = await getMeta(kind, id);
    } catch {
      meta = fallbackMeta(kind, id, {
        title: config.displayTitle,
        poster: config.poster,
      });
    }
  }

  const html = renderPlayer({
    meta,
    type: kind === "tv" ? "tv" : "movie",
    season: seasonNumber,
    episode: episodeNumber,
    config,
  });

  res.set({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=120, s-maxage=600, stale-while-revalidate=60",
  });
  res.send(html);
}

router.get("/", (_req, res) => res.redirect("/embed"));

router.get("/embed", (req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.send(renderDocs({ baseUrl: requestBase(req) }));
});

router.get("/embed/movie/:id", asyncRoute((req, res) =>
  servePlayer(req, res, { type: "movie", tmdbId: req.params.id, season: 1, episode: 1 }),
));

router.get("/embed/tv/:id/:season/:episode", asyncRoute((req, res) =>
  servePlayer(req, res, {
    type: "tv",
    tmdbId: req.params.id,
    season: req.params.season,
    episode: req.params.episode,
  }),
));

router.get("/embed/tv/:id", asyncRoute((req, res) =>
  servePlayer(req, res, { type: "tv", tmdbId: req.params.id, season: 1, episode: 1 }),
));

router.get("/embed/:id", asyncRoute((req, res) =>
  servePlayer(req, res, { type: "movie", tmdbId: req.params.id, season: 1, episode: 1 }),
));

router.get("/player/:id", asyncRoute((req, res) =>
  servePlayer(req, res, { type: "movie", tmdbId: req.params.id, season: 1, episode: 1 }),
));

router.get("/player/:id/:season/:episode", asyncRoute((req, res) =>
  servePlayer(req, res, {
    type: "tv",
    tmdbId: req.params.id,
    season: req.params.season,
    episode: req.params.episode,
  }),
));

export default router;
