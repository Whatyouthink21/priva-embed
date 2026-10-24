import { getJson, withTimeout } from "../lib/http.js";
import { cached } from "../lib/cache.js";
import { extractVidukiStreams } from "./oneflex/crypto.js";

/**
 * Nova — 1flex engine (Vidzee edge + Viduki backends).
 *
 * Ported from Zenda-Cross/vega-providers (providers/1flex), minus everything
 * Bellamy already covers: the cinejoy / movy / vidstuck fallback scrapers and
 * the db.1flex.org metadata call exist only to feed those scrapers, so neither
 * is fetched here.
 *
 * Two native surfaces remain:
 *   - Vidzee edge: GET /streams/...?e=0 -> plain `{url, language, headers}`.
 *                  (`e=1` returns a `{c}` blob the site decrypts in the browser
 *                  with a WASM bundle it serves itself; we ask for `e=0` and
 *                  skip the crypto entirely.)
 *   - Viduki:      Altcha proof-of-work handshake, then a WASM-sealed envelope
 *                  per backend (Sherry / Jill / Ada / Ethan).
 */
export const id = "nova";
export const name = "Nova";

const CORE_BASE = "https://core.vidzee.wtf";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const playerHeaders = {
  Referer: "https://player.vidzee.wtf/",
  Origin: "https://player.vidzee.wtf",
  "User-Agent": UA,
};

// The player's own edge list, in its order. `v6:Hindi` is the Hindi dub, so it
// is labelled rather than ranked with the English sources.
const VIDZEE_SERVERS = [
  { id: "dcloud", label: "FastCloud", quality: "1080" },
  { id: "tik", label: "TikCloud (backup)", quality: "1080" },
  { id: "ipcloud", label: "IPCloud", quality: "1080" },
  { id: "v6:Hindi", label: "Hindi", quality: "1080", language: "Hindi" },
];

const LANGUAGES = {
  english: "en",
  english_sdh: "en",
  spanish: "es",
  french: "fr",
  german: "de",
  italian: "it",
  portuguese: "pt",
  "brazilian portuguese": "pt-BR",
  russian: "ru",
  arabic: "ar",
  hindi: "hi",
  tamil: "ta",
  telugu: "te",
  malayalam: "ml",
  kannada: "kn",
  bengali: "bn",
  urdu: "ur",
  turkish: "tr",
  dutch: "nl",
  polish: "pl",
  indonesian: "id",
  malay: "ms",
  thai: "th",
  vietnamese: "vi",
  japanese: "ja",
  korean: "ko",
  chinese: "zh",
  "chinese (simplified)": "zh-Hans",
  "chinese (traditional)": "zh-Hant",
};

function languageOf(label) {
  const key = String(label || "").trim().toLowerCase();
  if (LANGUAGES[key]) return LANGUAGES[key];
  const direct = key.match(/^([a-z]{2})(?:[-_]|$)/);
  if (direct) return direct[1];
  const named = Object.keys(LANGUAGES).find((entry) => key.startsWith(entry));
  return named ? LANGUAGES[named] : "und";
}

function streamType(url) {
  return String(url || "").includes(".m3u8") ? "hls" : "mp4";
}

/* -------------------------------- subtitles ------------------------------- */

async function subtitles({ tmdbId, type, season, episode, signal }) {
  const endpoint =
    type === "tv"
      ? `${CORE_BASE}/subs/tv/${tmdbId}/${season || 1}/${episode || 1}`
      : `${CORE_BASE}/subs/movie/${tmdbId}`;
  try {
    const payload = await getJson(endpoint, { headers: playerHeaders, timeout: 5000, signal });
    const list = Array.isArray(payload) ? payload : [];
    return list
      .filter((entry) => entry && entry.file)
      .map((entry) => ({
        title: entry.label || "Subtitle",
        language: languageOf(entry.label),
        url: entry.file,
        // The subtitle CDN 403s without the player origin.
        headers: playerHeaders,
      }))
      .slice(0, 24);
  } catch {
    return [];
  }
}

/* --------------------------------- vidzee --------------------------------- */

async function vidzeeStreams({ tmdbId, type, season, episode, signal }) {
  const path =
    type === "tv"
      ? `/streams/tv/${tmdbId}/${season || 1}/${episode || 1}`
      : `/streams/movie/${tmdbId}`;

  const results = await Promise.all(
    VIDZEE_SERVERS.map(async (server) => {
      try {
        const payload = await getJson(
          `${CORE_BASE}${path}?s=${encodeURIComponent(server.id)}&e=0`,
          { headers: playerHeaders, timeout: 6000, signal },
        );

        const url = typeof payload?.url === "string" ? payload.url.trim() : "";
        if (!/^https?:\/\//i.test(url)) return null;

        return {
          server,
          url,
          language: payload?.language || server.language || "",
          headers: {
            ...playerHeaders,
            ...(payload?.headers && typeof payload.headers === "object" ? payload.headers : {}),
          },
        };
      } catch {
        return null;
      }
    }),
  );

  return results.filter(Boolean).map(({ server, url, language, headers }) => ({
    // Only the codename reaches the browser; the backend name lives in the label.
    server: name,
    label: `${server.label} · ${server.quality}p`,
    url,
    type: streamType(url),
    quality: server.quality,
    language,
    headers,
  }));
}

/* --------------------------------- resolve -------------------------------- */

async function lookup({ tmdbId, type, season, episode, signal }) {
  const isMovie = type !== "tv";
  const seasonNumber = Number(season) || 1;
  const episodeNumber = Number(episode) || 1;

  const [captions, vidzee, viduki] = await Promise.all([
    subtitles({ tmdbId, type: isMovie ? "movie" : "tv", season: seasonNumber, episode: episodeNumber, signal }),
    vidzeeStreams({ tmdbId, type: isMovie ? "movie" : "tv", season: seasonNumber, episode: episodeNumber, signal }),
    extractVidukiStreams({
      tmdbId,
      isMovie,
      season: seasonNumber,
      episode: episodeNumber,
      signal,
    }).catch(() => []),
  ]);

  const vidukiStreams = viduki.map((stream) => ({
    server: name,
    label: `${stream.server} · ${stream.label}`,
    url: stream.url,
    type: stream.type,
    quality: stream.quality,
    headers: stream.headers,
    subtitles: captions,
  }));

  return [...vidukiStreams, ...vidzee.map((stream) => ({ ...stream, subtitles: captions }))];
}

export async function resolve({ tmdbId, type, season = 1, episode = 1, signal }) {
  const numericId = String(tmdbId || "").replace(/\D/g, "");
  if (!numericId) return [];

  const key = `nova:${type === "tv" ? "tv" : "movie"}:${numericId}:${season}:${episode}`;

  return withTimeout(
    cached(key, 2 * 60 * 1000, () =>
      lookup({ tmdbId: numericId, type, season, episode, signal }),
    ),
    // Viduki's handshake is three sequential round trips before the envelope
    // call, so this budget is deliberately larger than the other engines'.
    24000,
    [],
  );
}
