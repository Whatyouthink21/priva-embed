import express from "express";
import { getMeta, getSeason, fallbackMeta } from "../tmdb.js";
import { resolveSources, providerList, PROVIDERS } from "../providers/index.js";
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
  const token = encodeHeaders(subtitle.headers);
  return `/api/subtitle?u=${b64url(subtitle.url)}${token ? `&h=${token}` : ""}`;
}

/**
 * Progressive streams (mp4) do not need CORS to play in a <video>, so the browser
 * can fetch them straight from the CDN using the viewer's own IP. That matters for
 * engines whose CDN rejects datacenter IPs — proxying them from Render guarantees
 * a 426/429, while playing them client-side does not.
 *
 * HLS and subtitles stay proxied: hls.js and <track> both need CORS headers that
 * the upstreams do not send.
 */
const DIRECT_PLAY_TYPES = new Set(["mp4"]);

export function publicStream(stream) {
  const direct = DIRECT_PLAY_TYPES.has(stream.type) ? String(stream.url || "") : "";
  return {
    id: stream.id,
    server: stream.server,
    label: stream.label,
    type: stream.type,
    quality: stream.quality,
    language: stream.language,
    // Same-origin proxy — always usable, and the fallback for `direct`.
    url: streamProxyUrl(stream),
    // Raw upstream URL the browser may try first (empty when not applicable).
    direct,
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
  // Ask the registry instead of a hardcoded list so a provider swap cannot drift.
  const providers =
    requested && requested !== "auto" && Object.hasOwn(PROVIDERS, requested)
      ? [requested]
      : undefined;
  const refresh = String(req.query.refresh || "") === "1";

  if (!tmdbId) {
    return res.status(400).json({ error: "A numeric tmdb id is required" });
  }

  if (String(req.query.demo || "") === "1") {
    const meta = demoMeta(type);
    const demo = demoSources({ type, season, episode });
    return res.json({
      ...demo,
      // Honour ?provider= here too, so previewing one engine matches the real path.
      providers: providers
        ? demo.providers.filter((provider) => providers.includes(provider.id))
        : demo.providers,
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
