import { getJson, withTimeout } from "../lib/http.js";
import { extractCinejoy } from "../extractors/cinejoy.js";
import { extractMovy } from "../extractors/movy.js";
import { extractVidstuck } from "../extractors/vidstuck.js";
import { cached } from "../lib/cache.js";

/** Bellamy — autoembed engine (multi-extractor). */
export const id = "bellamy";
export const name = "Bellamy";

const MAX_STREAMS = 14;

export async function skipTimings({ imdbId, tmdbId, season, episode }) {
  if (!season || !episode) return [];
  if (!imdbId && !tmdbId) return [];

  return cached(`bellamy:skip:${imdbId || tmdbId}:${season}:${episode}`, 60 * 60 * 1000, async () => {
    const params = new URLSearchParams();
    if (imdbId) params.set("imdb_id", imdbId);
    if (tmdbId) params.set("tmdb_id", String(tmdbId));
    params.set("season", String(season));
    params.set("episode", String(episode));
    try {
      const data = await getJson(`https://api.theintrodb.org/v2/media?${params.toString()}`, {
        headers: { Accept: "application/json" },
        timeout: 5000,
      });
      const intervals = [];
      const push = (list, title) => {
        for (const item of Array.isArray(list) ? list : []) {
          const start = item?.start_ms;
          const end = item?.end_ms;
          if (typeof start === "number" && typeof end === "number" && end > start) {
            intervals.push({ title, from: +(start / 1000).toFixed(2), to: +(end / 1000).toFixed(2) });
          }
        }
      };
      push(data?.intro, "Intro");
      push(data?.recap, "Recap");
      push(data?.credits, "Credits");
      return intervals;
    } catch {
      return [];
    }
  });
}

function normalize(streams) {
  const seen = new Set();
  const cleaned = [];

  for (const stream of streams) {
    if (!stream?.url || !/^https?:\/\//i.test(stream.url)) continue;
    if (seen.has(stream.url)) continue;
    seen.add(stream.url);

    const quality = String(stream.quality || "").replace(/p$/, "");
    const label = stream.variant ? `${stream.variant} · ${quality}p` : `${quality}p`;
    cleaned.push({
      server: "Bellamy",
      label,
      url: stream.url,
      type: stream.type === "dash" ? "dash" : stream.type === "hls" ? "hls" : "mp4",
      quality,
      headers: stream.headers || {},
      subtitles: (stream.subtitles || []).filter((sub) => sub?.url),
    });
    if (cleaned.length >= MAX_STREAMS) break;
  }

  cleaned.sort((a, b) => {
    const aHls = a.type === "hls" ? 1 : 0;
    const bHls = b.type === "hls" ? 1 : 0;
    if (aHls !== bHls) return bHls - aHls;
    return Number(b.quality || 0) - Number(a.quality || 0);
  });
  return cleaned;
}

const EXTRACTORS = [extractCinejoy, extractMovy, extractVidstuck];

/** One-line reason an extractor returned nothing, safe to show in the player. */
export function describeFailure(error) {
  const status = Number(error?.status);
  if (status) return `HTTP ${status}`;
  const message = String(error?.message || "").replace(/\s+/g, " ").trim();
  return message ? message.slice(0, 60) : "failed";
}

/**
 * Resolve through a fixed extractor list.
 *
 * Exported separately from `resolve` so the failure paths can be exercised
 * without hitting the network — an engine that returns nothing used to be
 * indistinguishable from one that was blocked, and the player only ever said
 * "no links".
 */
export async function resolveWith(extractors, context, { timeoutMs = 26000 } = {}) {
  const results = await withTimeout(
    Promise.allSettled(extractors.map((extractor) => extractor(context))),
    timeoutMs,
    null,
  );

  if (!results) {
    throw new Error(`Extractors timed out after ${Math.round(timeoutMs / 1000)}s`);
  }

  const streams = [];
  const failures = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      streams.push(...(Array.isArray(result.value) ? result.value : []));
    } else {
      // Never name the upstream: only the codename is public.
      failures.push(`source ${index + 1}: ${describeFailure(result.reason)}`);
    }
  });

  const cleaned = normalize(streams);
  if (!cleaned.length && failures.length) {
    throw new Error(`All extractors failed (${failures.join(", ")})`);
  }
  return cleaned;
}

export async function resolve({ tmdbId, imdbId, title, year, type, season = 1, episode = 1, signal }) {
  if (!tmdbId) return [];

  return resolveWith(EXTRACTORS, {
    tmdbId: String(tmdbId),
    imdbId,
    title,
    year,
    type,
    season: Number(season) || 1,
    episode: Number(episode) || 1,
    signal,
  });
}
