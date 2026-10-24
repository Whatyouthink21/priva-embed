import crypto from "node:crypto";
import { getJson, request, withTimeout } from "../lib/http.js";
import { cached } from "../lib/cache.js";
import { pickBest, yearOf } from "../lib/match.js";

/**
 * Clarke — castle engine.
 * The upstream API answers with AES-128-CBC encrypted JSON envelopes.
 */
export const id = "clarke";
export const name = "Clarke";

const DEFAULT_API = "https://api.hlowb.com";
const CHANNEL = "IndiaA";
const CLIENT_TYPE = "1";
const LANG = "en-US";
const MODE = "1";
const PACKAGE = "com.external.castle";
const APP_MARKET = "GuanWang";
const APK_SIGN = "ED0955EB04E67A1D9F3305B95454FED485261475";
const ANDROID_VER = "13";
const LOCATION_ID = "1001";
const SUFFIX = "T!BgJB";
const UA = "okhttp/4.9.0";

const SERIES_TYPES = new Set(["1", "3", "5"]);
const QUALITY_NAME = { 3: "1080p", 2: "720p", 1: "480p" };
const QUALITY_NUM = { 3: 1080, 2: 720, 1: 480 };
const RESOLUTIONS = ["3", "2", "1"];

const URLS_ENDPOINT =
  "https://raw.githubusercontent.com/Zenda-Cross/vega-providers/refs/heads/main/urls.json";

let baseCache = { url: DEFAULT_API, at: 0 };

async function getApiBase() {
  if (Date.now() - baseCache.at < 60 * 60 * 1000) return baseCache.url;
  try {
    const config = await getJson(URLS_ENDPOINT, { timeout: 6000 });
    const url = config?.castle?.url;
    if (typeof url === "string" && url.startsWith("http")) {
      baseCache = { url: url.replace(/\/+$/, ""), at: Date.now() };
      return baseCache.url;
    }
  } catch {
    /* keep the default */
  }
  baseCache = { url: DEFAULT_API, at: Date.now() };
  return DEFAULT_API;
}

/* ---------------------------------- crypto -------------------------------- */

export function deriveKey(securityKeyB64) {
  const decoded = Buffer.from(String(securityKeyB64), "base64");
  const suffix = Buffer.from(SUFFIX, "utf8");
  const key = Buffer.alloc(16);
  let index = 0;
  for (let i = 0; i < decoded.length && index < 16; i += 1) key[index++] = decoded[i];
  for (let i = 0; i < suffix.length && index < 16; i += 1) key[index++] = suffix[i];
  return key;
}

export function decryptCBC(cipherB64, key) {
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, key);
  const plain = Buffer.concat([
    decipher.update(Buffer.from(String(cipherB64), "base64")),
    decipher.final(),
  ]);
  const text = plain.toString("utf8");
  if (!text) throw new Error("Clarke: empty decrypted payload");
  return text;
}

export function castleSafeParse(text) {
  const cleaned = String(text).replace(
    /"([A-Za-z0-9_]*Id|id)"\s*:\s*(-?\d+)/g,
    '"$1":"$2"',
  );
  return JSON.parse(cleaned);
}

let keyCache = { key: null, at: 0 };

async function getSecurityKey(signal) {
  if (keyCache.key && Date.now() - keyCache.at < 5 * 60 * 1000) return keyCache.key;
  const base = await getApiBase();
  const url = `${base}/v0.1/system/getSecurityKey/1?channel=${CHANNEL}&clientType=${CLIENT_TYPE}&lang=${LANG}`;
  const data = await getJson(url, { headers: { "User-Agent": UA }, timeout: 10000, signal });
  const raw = typeof data === "string" ? JSON.parse(data) : data;
  if (!raw || raw.code !== 200 || !raw.data) throw new Error("Clarke: security key unavailable");
  keyCache = { key: deriveKey(raw.data), at: Date.now() };
  return keyCache.key;
}

function parseEnvelope(body) {
  if (body && typeof body === "object" && body.data && typeof body.data === "object") return body;
  return null;
}

async function unwrap(body, key) {
  const direct = parseEnvelope(body);
  if (direct) return direct;

  let cipher = body;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && typeof parsed.data === "object") return parsed;
      if (parsed && typeof parsed.data === "string") cipher = parsed.data;
      else if (typeof parsed === "string") cipher = parsed;
    } catch {
      cipher = body;
    }
  } else if (body && Buffer.isBuffer(body)) {
    cipher = body.toString("utf8");
  }

  const text = String(cipher).trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* encrypted */
  }
  return castleSafeParse(decryptCBC(text, key));
}

async function callApi(url, signal, body) {
  const key = await getSecurityKey(signal);
  const response = await request(url, {
    method: body ? "POST" : "GET",
    headers: {
      "User-Agent": UA,
      ...(body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    timeout: 14000,
    signal,
  });
  return unwrap(response, key);
}

/* ----------------------------------- api ---------------------------------- */

async function apiSearch(query, page, signal) {
  const base = await getApiBase();
  const url = `${base}/film-api/v1.1.0/movie/searchByKeyword?channel=${CHANNEL}&clientType=${CLIENT_TYPE}&keyword=${encodeURIComponent(
    query,
  )}&lang=${LANG}&mode=${MODE}&packageName=${PACKAGE}&page=${page}&size=24`;
  return callApi(url, signal);
}

async function apiDetails(movieId, signal) {
  const base = await getApiBase();
  const url = `${base}/film-api/v1.9.9/movie?channel=${CHANNEL}&clientType=${CLIENT_TYPE}&lang=${LANG}&movieId=${encodeURIComponent(
    String(movieId),
  )}&packageName=${PACKAGE}`;
  return callApi(url, signal);
}

async function apiVideoUrl(movieId, episodeId, resolution, languageId, signal) {
  const base = await getApiBase();
  const url = `${base}/film-api/v2.0.1/movie/getVideo2?clientType=${CLIENT_TYPE}&packageName=${PACKAGE}&channel=${CHANNEL}&lang=${LANG}`;
  const body = {
    mode: MODE,
    appMarket: APP_MARKET,
    clientType: CLIENT_TYPE,
    woolUser: "false",
    apkSignKey: APK_SIGN,
    androidVersion: ANDROID_VER,
    movieId: String(movieId),
    episodeId: String(episodeId),
    isNewUser: "true",
    resolution: String(resolution),
    packageName: PACKAGE,
  };
  if (languageId !== null && languageId !== undefined && languageId !== "") {
    body.languageId = String(languageId);
  }
  return callApi(url, signal, body);
}

function pickDetails(envelope) {
  const outer = envelope?.data;
  if (!outer || typeof outer !== "object") return {};
  const inner = outer.data;
  if (
    inner &&
    typeof inner === "object" &&
    (inner.title || inner.episodes || inner.seasons || inner.id)
  ) {
    return inner;
  }
  return outer;
}

function pickRows(envelope) {
  const data = envelope?.data;
  if (!data) return [];
  if (Array.isArray(data.rows)) return data.rows;
  if (Array.isArray(data.data?.rows)) return data.data.rows;
  return [];
}

/* --------------------------------- resolve -------------------------------- */

function typeOf(item) {
  return SERIES_TYPES.has(String(item?.movieType)) ? "tv" : "movie";
}

async function findTitle(title, type, year, signal) {
  const envelope = await cached(`clarke:search:${title}:${type}`, 10 * 60 * 1000, () =>
    apiSearch(title, 1, signal),
  );
  const rows = pickRows(envelope)
    .map((row) => ({
      id: row.id ?? row.redirectId,
      title: row.title || row.name,
      movieType: row.movieType,
      year: yearOf(row.publishTime),
      score: row.score,
      image: row.coverVerticalImage || row.coverHorizontalImage,
      languages: row.languages || [],
    }))
    .filter((row) => row.id && row.title);

  const best = pickBest(rows, title, { type, year, typeOf });
  if (best) return best;

  // Fall back to the first series/movie hit when the fuzzy matcher is too strict.
  const sameType = rows.filter((row) => typeOf(row) === type);
  return sameType[0] || null;
}

async function resolveEpisode(details, seasonNumber, episodeNumber, signal) {
  const seasons = Array.isArray(details.seasons) ? details.seasons : [];
  if (seasons.length) {
    const season =
      seasons.find((entry) => Number(entry.number) === Number(seasonNumber)) || seasons[0];
    if (season?.movieId) {
      const seasonEnvelope = await cached(`clarke:details:${season.movieId}`, 10 * 60 * 1000, () =>
        apiDetails(season.movieId, signal),
      );
      const seasonDetails = pickDetails(seasonEnvelope);
      const episodes = Array.isArray(seasonDetails.episodes) ? seasonDetails.episodes : [];
      if (episodes.length) {
        const episode =
          episodes.find((entry) => Number(entry.number) === Number(episodeNumber)) ||
          episodes[Number(episodeNumber) - 1] ||
          episodes[0];
        return { ownerId: season.movieId, episode, episodes };
      }
    }
  }

  const episodes = Array.isArray(details.episodes) ? details.episodes : [];
  if (!episodes.length) return null;
  const episode =
    episodes.find((entry) => Number(entry.number) === Number(episodeNumber)) ||
    episodes[Number(episodeNumber) - 1] ||
    episodes[0];
  return { ownerId: details.id, episode, episodes };
}

function detectType(url) {
  if (/\.m3u8(\?|#|$)/i.test(url)) return "hls";
  if (/\.mpd(\?|#|$)/i.test(url)) return "dash";
  return "mp4";
}

export async function resolve({ tmdbId, title, year, type, season = 1, episode = 1, signal }) {
  return withTimeout(
    (async () => {
      if (!title) return [];
      const match = await findTitle(title, type, year, signal);
      if (!match) return [];

      const envelope = await cached(`clarke:details:${match.id}`, 10 * 60 * 1000, () =>
        apiDetails(match.id, signal),
      );
      const details = pickDetails(envelope);
      if (!details || !details.title) return [];

      let ownerId = details.id ?? match.id;
      let targetEpisode = null;
      let tracks = [];

      if (type === "tv") {
        const resolved = await resolveEpisode(details, season, episode, signal);
        if (!resolved || !resolved.episode?.id) return [];
        ownerId = resolved.ownerId ?? ownerId;
        targetEpisode = resolved.episode;
      } else {
        const episodes = Array.isArray(details.episodes) ? details.episodes : [];
        targetEpisode = episodes[0];
        if (!targetEpisode?.id) return [];
      }

      tracks = Array.isArray(targetEpisode.tracks) ? targetEpisode.tracks : [];
      const perLanguage = tracks.some((track) => track && track.existIndividualVideo === true);

      const streams = [];
      const seen = new Set();

      const attempt = async (languageId, languageName, resolution) => {
        try {
          const envelopeVideo = await apiVideoUrl(
            ownerId,
            targetEpisode.id,
            resolution,
            languageId,
            signal,
          );
          const video = envelopeVideo?.data?.data ?? envelopeVideo?.data ?? {};
          const url = video.videoUrl;
          if (!url || video.permissionDenied === true) return;
          if (seen.has(url)) return;
          seen.add(url);

          const quality = QUALITY_NUM[resolution] || 720;
          const label = languageName ? `${languageName} · ${quality}p` : `${quality}p`;
          streams.push({
            server: "Clarke",
            label,
            url,
            type: detectType(url),
            quality: String(quality),
            language: languageName || "",
            headers: {},
            subtitles: [],
          });
        } catch {
          /* try the next rendition */
        }
      };

      if (!perLanguage) {
        const languageName =
          tracks
            .map((track) => track && (track.languageName || track.abbreviate))
            .filter(Boolean)
            .join(", ") || "";
        for (const resolution of RESOLUTIONS) {
          await attempt(null, languageName, resolution);
          if (streams.length >= 1 && resolution === "3") {
            // 1080p is usually enough; keep fetching 720/480 for the quality menu.
          }
        }
      } else {
        for (const track of tracks) {
          if (!track || track.languageId === null || track.languageId === undefined) continue;
          const languageName = track.languageName || track.abbreviate || "";
          for (const resolution of RESOLUTIONS) {
            await attempt(String(track.languageId), languageName, resolution);
          }
        }
      }

      return streams;
    })(),
    22000,
    [],
  );
}
