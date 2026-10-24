import crypto from "node:crypto";
import { getJson, request } from "../lib/http.js";

const BASE_URL = "https://vidstuck.cc";
const AES_KEY = "7f4c9e2a81d63b05c4f7a9e8126d3b50e1a8c7f23d9465ab0c6e9f1d4a7b832c";

const SERVERS = [
  { id: "orion", quality: "1080" },
  { id: "andromeda", quality: "1080" },
  { id: "atlas", quality: "1080" },
  { id: "daedalus", quality: "1080" },
  { id: "ursa", quality: "1080" },
];

const API_KEYS = {
  tmdbId: "a7f39c821d604e5b9c1e547b",
  mediaType: "c281b306d28147a35632e816b",
  server: "6b491e7258d392e7561a9384c",
  season: "d8427b59c38a2f957c3613e85b",
  episode: "91c6e4a753d1f785c92346b713d",
  ts: "61d9a5274c8e3b29f38c291e6",
  token: "c492f7a183d601e436c538a716d",
  title: "5e28c9147a306d1e29f3674b392a1",
  year: "b731e6c94f08675f8341c306e",
  date: "e1649321a39e5814b3027",
  imdbId: "f35a8c1943265e871c4933a725f",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function evpBytesToKey(passphrase, salt, keyLength = 32, ivLength = 16) {
  const pass = Buffer.from(passphrase, "utf8");
  let derived = Buffer.alloc(0);
  let previous = Buffer.alloc(0);
  while (derived.length < keyLength + ivLength) {
    previous = crypto.createHash("md5").update(Buffer.concat([previous, pass, salt])).digest();
    derived = Buffer.concat([derived, previous]);
  }
  return { key: derived.subarray(0, keyLength), iv: derived.subarray(keyLength, keyLength + ivLength) };
}

export function opensslDecrypt(cipherB64, passphrase) {
  try {
    const raw = Buffer.from(String(cipherB64), "base64");
    if (raw.length < 32) return "";
    if (raw.subarray(0, 8).toString("latin1") !== "Salted__") return "";
    const salt = raw.subarray(8, 16);
    const cipher = raw.subarray(16);
    const { key, iv } = evpBytesToKey(passphrase, salt);
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    const text = Buffer.concat([decipher.update(cipher), decipher.final()]).toString("utf8");
    return /^(\/|https?:)/.test(text) ? text : "";
  } catch {
    return "";
  }
}

function streamType(item, url) {
  if (item?.type === "dash" || url.includes("database/andromeda")) return "dash";
  if (
    item?.type === "hls" ||
    url.includes(".m3u8") ||
    url.includes("atlas") ||
    url.includes("ursa") ||
    url.includes("daedalus")
  ) {
    return "hls";
  }
  return "mp4";
}

export async function extractVidstuck({ tmdbId, imdbId, title, year, date, type, season, episode, signal }) {
  const isMovie = type !== "tv";
  const mediaType = isMovie ? "movie" : "tv";
  if (!tmdbId) return [];

  const embedUrl = `${BASE_URL}/embed/${mediaType}/${tmdbId}${isMovie ? "" : `/${season || 1}/${episode || 1}`}`;
  const headers = {
    "User-Agent": UA,
    Origin: BASE_URL,
    Referer: embedUrl,
    Accept: "application/json",
  };
  const streamHeaders = { Referer: `${BASE_URL}/`, Origin: BASE_URL, "User-Agent": UA };
  const effectiveDate = date || (year ? `${year}-01-01` : "2020-01-01");

  const subtitlesPromise = (async () => {
    try {
      const tokenResponse = await request(`${BASE_URL}/backend/vidstuck`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          [API_KEYS.tmdbId]: Number(tmdbId),
          [API_KEYS.mediaType]: mediaType,
          [API_KEYS.server]: "subtitle",
          ...(isMovie ? {} : {
            [API_KEYS.season]: Number(season || 1),
            [API_KEYS.episode]: Number(episode || 1),
          }),
        }),
        timeout: 6000,
        signal,
      });
      const { token, ts } = tokenResponse || {};
      if (!token || !ts) return [];

      const params = new URLSearchParams({
        [API_KEYS.tmdbId]: String(tmdbId),
        [API_KEYS.mediaType]: mediaType,
        [API_KEYS.server]: "subtitle",
        [API_KEYS.ts]: String(ts),
        [API_KEYS.token]: token,
        [API_KEYS.date]: effectiveDate,
      });
      if (title) params.set(API_KEYS.title, title);
      if (year) params.set(API_KEYS.year, year);
      if (!isMovie) {
        params.set(API_KEYS.season, String(season || 1));
        params.set(API_KEYS.episode, String(episode || 1));
      }

      const response = await getJson(`${BASE_URL}/backend/subtitle?${params.toString()}`, {
        headers,
        timeout: 6000,
        signal,
      });
      return (response?.captions || [])
        .filter((caption) => caption && caption.file)
        .map((caption) => ({
          title: caption.display || "Subtitle",
          language: String(caption.display || "en").slice(0, 2).toLowerCase(),
          url: caption.file,
        }));
    } catch {
      return [];
    }
  })();

  const tasks = SERVERS.map(async (server) => {
    try {
      const payload = {
        [API_KEYS.tmdbId]: Number(tmdbId),
        [API_KEYS.mediaType]: mediaType,
        [API_KEYS.server]: server.id,
        ...(isMovie ? {} : {
          [API_KEYS.season]: Number(season || 1),
          [API_KEYS.episode]: Number(episode || 1),
        }),
      };
      const tokenResponse = await request(`${BASE_URL}/backend/vidstuck`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeout: 7000,
        signal,
      });
      const { token, ts } = tokenResponse || {};
      if (!token || !ts) return [];

      const params = new URLSearchParams({
        [API_KEYS.tmdbId]: String(tmdbId),
        [API_KEYS.server]: server.id,
        [API_KEYS.mediaType]: mediaType,
        [API_KEYS.ts]: String(ts),
        [API_KEYS.token]: token,
        [API_KEYS.date]: effectiveDate,
      });
      if (title) params.set(API_KEYS.title, title);
      if (year) params.set(API_KEYS.year, year);
      if (imdbId) params.set(API_KEYS.imdbId, imdbId);
      if (!isMovie) {
        params.set(API_KEYS.season, String(season || 1));
        params.set(API_KEYS.episode, String(episode || 1));
      }

      const serverResponse = await getJson(
        `${BASE_URL}/backend/servers/${server.id}?${params.toString()}`,
        { headers, timeout: 8000, signal },
      );

      const links = Array.isArray(serverResponse?.links) ? serverResponse.links : [];
      if (!links.length) return [];

      const subtitles = await subtitlesPromise;
      const multiAudio = Array.isArray(serverResponse?.dubs) && serverResponse.dubs.length > 1;

      const out = [];
      for (const item of links) {
        if (!item?.link) continue;
        const decrypted = opensslDecrypt(item.link, AES_KEY);
        if (!decrypted) continue;
        const url = decrypted.startsWith("http") ? decrypted : `${BASE_URL}${decrypted}`;
        out.push({
          server: "Bellamy",
          variant: `Mirror ${server.id.slice(0, 1).toUpperCase()}${multiAudio ? " · Multi-Audio" : ""}`,
          url,
          type: streamType(item, url),
          quality: server.quality,
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
