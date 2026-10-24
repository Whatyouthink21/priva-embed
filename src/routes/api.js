import express from "express";
import { getMeta, getSeason, fallbackMeta } from "../tmdb.js";
import { resolveSources, providerList } from "../providers/index.js";
import { bellamy } from "../providers/index.js";
import { b64url, encodeHeaders } from "../lib/tokens.js";
import { cached } from "../lib/cache.js";
import { demoSources, demoSeason, demoMeta } from "../demo.js";
import { asyncRoute } from "../lib/express.js";

const router = express.Router();

const SOURCE_TTL = 3 * 60 * 1000;

function streamProxyUrl(stream) {
  const token = encodeHeaders(stream.headers);
  return `/api/stream?u=${b64url(stream.url)}${token ? `&h=${token}` : ""}`;
}

function subtitleProxyUrl(subtitle) {
  return `/api/subtitle?u=${b64url(subtitle.url)}`;
}

function publicStream(stream) {
  return {
    id: stream.id,
    server: stream.server,
    label: stream.label,
    type: stream.type,
    quality: stream.quality,
    language: stream.language,
    url: streamProxyUrl(stream),
    subtitles: (stream.subtitles || [])
      .filter((subtitle) => subtitle?.url)
      .slice(0, 24)
      .map((subtitle) => ({
        title: subtitle.title || "Subtitle",
        language: subtitle.language || "und",
        url: subtitleProxyUrl(subtitle),
      })),
  };
}

router.get("/health", (_req, res) => {
  res.json({ ok: true, service: "priva-embed", providers: providerList(), uptime: process.uptime() });
});

router.get("/providers", (_req, res) => {
  res.json({ providers: providerList() });
});

router.get("/meta/:type/:id", asyncRoute(async (req, res) => {
  const { type, id } = req.params;
  try {
    const meta = await getMeta(type, id);
    res.set("Cache-Control", "public, max-age=1800");
    res.json(meta);
  } catch (error) {
    res.status(200).json({
      ...fallbackMeta(type, id, { title: req.query.title, poster: req.query.poster }),
      degraded: true,
      message: error?.message || "metadata unavailable",
    });
  }
}));

router.get("/season/:id/:season", asyncRoute(async (req, res) => {
  if (String(req.query.demo || "") === "1") {
    return res.json(demoSeason(req.params.season));
  }
  try {
    const season = await getSeason(req.params.id, req.params.season);
    res.set("Cache-Control", "public, max-age=1800");
    res.json(season);
  } catch (error) {
    res.status(200).json({ season: Number(req.params.season) || 1, episodes: [], message: error?.message });
  }
}));

router.get("/sources", asyncRoute(async (req, res) => {
  const type = String(req.query.type || "movie").toLowerCase() === "tv" ? "tv" : "movie";
  const tmdbId = String(req.query.tmdb || req.query.id || "").replace(/[^0-9]/g, "");
  const season = Math.max(1, Number(req.query.season) || 1);
  const episode = Math.max(1, Number(req.query.episode) || 1);
  const requested = String(req.query.provider || "auto").toLowerCase();
  const providers =
    requested && requested !== "auto" && ["clarke", "bellamy", "raven"].includes(requested)
      ? [requested]
      : undefined;
  const refresh = String(req.query.refresh || "") === "1";

  if (!tmdbId) {
    return res.status(400).json({ error: "A numeric tmdb id is required" });
  }

  if (String(req.query.demo || "") === "1") {
    const meta = demoMeta(type);
    return res.json({
      ...demoSources({ type, season, episode }),
      tmdbId: meta.id,
    });
  }

  const controller = new AbortController();
  req.on("close", () => controller.abort(new Error("client closed")));

  let meta;
  try {
    meta = await getMeta(type, tmdbId);
  } catch {
    meta = fallbackMeta(type, tmdbId, {
      title: req.query.title,
      year: req.query.year,
      imdbId: req.query.imdb,
      poster: req.query.poster,
    });
  }

  const context = {
    tmdbId,
    imdbId: req.query.imdb || meta.imdbId || "",
    title: req.query.title || meta.title,
    year: req.query.year || meta.year,
    type,
    season,
    episode,
    signal: controller.signal,
  };

  const cacheKey = `sources:${tmdbId}:${type}:${season}:${episode}:${providers ? providers.join(",") : "all"}:${context.title}`;

  try {
    const result = refresh
      ? await resolveSources(context, { providers, signal: controller.signal })
      : await cached(cacheKey, SOURCE_TTL, () =>
          resolveSources(context, { providers, signal: controller.signal }),
        );

    const payload = {
      tmdbId: Number(tmdbId),
      type,
      season,
      episode,
      title: meta.title,
      matched: req.query.title || meta.title,
      providers: result.providers.map((provider) => ({
        ...provider,
        streams: provider.streams.map(publicStream),
      })),
      ms: result.ms,
    };

    if (type === "tv") {
      payload.skip = await bellamy
        .skipTimings({ imdbId: context.imdbId, tmdbId, season, episode })
        .catch(() => []);
    }

    res.json(payload);
  } catch (error) {
    res.status(502).json({
      error: "sources_unavailable",
      message: error?.message || "Unable to resolve sources right now",
      providers: [],
    });
  }
}));

export default router;
