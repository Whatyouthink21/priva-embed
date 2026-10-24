import { getJson } from "../lib/http.js";

const API_BASE = "https://api.wecollege.net";
const ORIGIN = "https://www.movy.sx";

const SERVERS = [
  { id: "miami", mayHave4K: true },
  { id: "boise", mayHave4K: true },
  { id: "atlanta", quality: "1080" },
  { id: "phoenix", quality: "1080" },
  { id: "austin" },
  { id: "delhi", audio: "Hindi" },
  { id: "dallas" },
  { id: "tampa" },
  { id: "orlando" },
  { id: "vegas" },
  { id: "cancun" },
];

const D_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
];
const MAGIC_PREFIX = [109, 118, 109, 49];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function rotR(value, shift) {
  let v = value >>> 0;
  let s = shift & 31;
  if (s === 0) return v >>> 0;
  return ((v << s) | (v >>> (32 - s))) >>> 0;
}

function scramble(value) {
  let v = value >>> 0;
  v ^= v >>> 16;
  v = Math.imul(v, 0x85ebca6b) >>> 0;
  v ^= v >>> 13;
  v = Math.imul(v, 0xc2b2ae35) >>> 0;
  return (v ^ (v >>> 16)) >>> 0;
}

export function decodePayload(ciphertext, seed, mediaId) {
  const raw = Buffer.from(String(ciphertext).trim(), "base64");
  const length = raw.length;
  if (length < MAGIC_PREFIX.length) throw new Error("Payload too short");

  const S = new Array(61);
  let seedAcc = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    seedAcc = Math.imul(seedAcc ^ seed.charCodeAt(i), 0x1000193) >>> 0;
  }

  let n = scramble(scramble(seedAcc) ^ scramble((Number(mediaId) >>> 0) ^ 0x9e3779b9)) >>> 0;

  for (let e = 0; e < 8; e += 1) {
    if (((e * (e + 1)) & 1) === 0) {
      const a = n % 61;
      n = rotR((n + 0x9e3779b9) >>> 0, 7 + (7 & e));
      S[a] = (n ^ scramble(n)) >>> 0;
      n = scramble((n + a) >>> 0);
    } else {
      S[e] = D_CONSTANTS[15 & e];
    }
  }

  let acc = scramble(0xa5a5a5a5 ^ n) >>> 0;
  const keyStream = Buffer.alloc(length);
  let l = 0;

  for (let e = 0; e < length; ) {
    const sD = acc % 61;
    const sI = 0 - Number(sD in S);
    const sR = S[sD] >>> 0;
    const sC = Math.imul(0x9e3779b9, l + 1) >>> 0;
    let sB = (((acc ^ ((sR ^ sC) >>> 0)) >>> 0) | (acc & (sR ^ sC) & sI)) >>> 0;
    sB = (rotR((sB + acc) >>> 0, 31 & sD) ^ rotR(acc, 31 & Math.imul(sD, 7))) >>> 0;
    acc = scramble((sB + 0x9e3779b9) >>> 0);
    S[sD] = acc >>> 0;
    l += 1;

    keyStream[e++] = 255 & acc;
    if (e < length) keyStream[e++] = (acc >>> 8) & 255;
    if (e < length) keyStream[e++] = (acc >>> 16) & 255;
    if (e < length) keyStream[e++] = (acc >>> 24) & 255;
  }

  for (let e = 0; e < length; e += 1) keyStream[e] = raw[e] ^ keyStream[e];
  for (let e = 0; e < MAGIC_PREFIX.length; e += 1) {
    if (keyStream[e] !== MAGIC_PREFIX[e]) throw new Error("Invalid decrypted magic");
  }
  return keyStream.subarray(MAGIC_PREFIX.length).toString("utf8");
}

function extractQuality(quality) {
  if (!quality) return undefined;
  const text = String(quality).toLowerCase();
  if (text.includes("2160") || text.includes("4k")) return "2160";
  if (text.includes("1080")) return "1080";
  if (text.includes("800")) return "1080";
  if (text.includes("720")) return "720";
  if (text.includes("480")) return "480";
  if (text.includes("360")) return "360";
  return undefined;
}

let seedCache = null;

async function fetchSeed(headers, mediaId, signal) {
  if (seedCache && seedCache.mediaId === mediaId && seedCache.expiresAt - 5000 > Date.now()) {
    return seedCache.seed;
  }
  try {
    const response = await getJson(`${API_BASE}/seed?mediaId=${mediaId}`, {
      headers,
      timeout: 6000,
      signal,
    });
    if (response?.seed) {
      seedCache = {
        seed: response.seed,
        mediaId,
        expiresAt: Date.now() + (response.ttlMs || 30000),
      };
      return response.seed;
    }
  } catch {
    /* no seed, no movy */
  }
  return null;
}

export async function extractMovy({ tmdbId, imdbId, title, year, type, season, episode, signal }) {
  const isMovie = type !== "tv";
  if (!tmdbId) return [];

  const headers = { "User-Agent": UA, Origin: ORIGIN, Referer: `${ORIGIN}/`, Accept: "application/json" };
  const seed = await fetchSeed(headers, String(tmdbId), signal);
  if (!seed) return [];

  const streamHeaders = { Referer: `${ORIGIN}/`, Origin: ORIGIN, "User-Agent": UA };

  const params = {
    title: encodeURIComponent(title || ""),
    mediaType: isMovie ? "movie" : "tv",
    year: year || "",
    tmdbId: String(tmdbId),
    enc: "2",
    seed,
  };
  if (imdbId) params.imdbId = imdbId;
  if (!isMovie) {
    params.seasonId = season || 1;
    params.episodeId = episode || 1;
  }

  const tasks = SERVERS.map(async (server) => {
    try {
      const query = new URLSearchParams(params).toString();
      const response = await getJson(`${API_BASE}/${server.id}/sources?${query}`, {
        headers,
        timeout: 7000,
        signal,
      });
      const cipherText = typeof response === "string" ? response : JSON.stringify(response);
      if (!cipherText || cipherText.length < 10) return [];

      const parsed = JSON.parse(decodePayload(cipherText, seed, String(tmdbId)));
      const subtitles = (parsed.subtitles || [])
        .filter((sub) => sub && (sub.url || sub.file || sub.src))
        .map((sub) => {
          const url = sub.url || sub.file || sub.src;
          const language = sub.language || sub.lang || sub.label || sub.name || "en";
          return {
            title: String(language),
            language: String(language).slice(0, 2).toLowerCase(),
            url,
          };
        });

      const out = [];
      if (parsed.playlist) {
        out.push({
          server: "Bellamy",
          variant: `Mirror ${server.id.slice(0, 1).toUpperCase()}`,
          url: parsed.playlist,
          type: "hls",
          quality: server.mayHave4K ? "2160" : server.quality || "1080",
          headers: streamHeaders,
          subtitles,
        });
      }

      for (const source of parsed.sources || []) {
        if (!source?.url) continue;
        if (source.url === parsed.playlist) continue;
        const quality = extractQuality(source.quality) || server.quality;
        out.push({
          server: "Bellamy",
          variant: `Mirror ${server.id.slice(0, 1).toUpperCase()}`,
          url: source.url,
          type: source.url.includes(".m3u8") ? "hls" : "mp4",
          quality,
          headers: streamHeaders,
          subtitles,
        });
      }
      return out;
    } catch {
      return [];
    }
  });

  const results = await Promise.allSettled(tasks);
  return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
}
