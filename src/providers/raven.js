import { getJson, request, withTimeout } from "../lib/http.js";
import { cached } from "../lib/cache.js";
import { pickBest } from "../lib/match.js";

/** Raven — movieboxweb engine. */
export const id = "raven";
export const name = "Raven";

const BASE = "https://officialmoviebox.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const apiHeaders = {
  Cookie: "token=",
  Accept: "application/json",
  "User-Agent": UA,
  "x-client-info": JSON.stringify({ timezone: "Asia/Colombo" }),
  "x-source": "",
};

/* ------------------------------- nuxt payload ------------------------------ */

function readNuxtPayload(html) {
  const match = String(html).match(
    /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function decodeNuxtData(values) {
  if (!Array.isArray(values) || !values.length) return null;
  const entries = values;
  const hydrated = new Array(entries.length);

  function hydrate(index) {
    if (index === -1 || index === -2) return undefined;
    if (index === -3) return NaN;
    if (index === -4) return Infinity;
    if (index === -5) return -Infinity;
    if (index === -6) return -0;
    if (typeof index !== "number" || index < 0 || index >= entries.length) return undefined;
    if (Object.prototype.hasOwnProperty.call(hydrated, index)) return hydrated[index];

    const value = entries[index];
    if (!value || typeof value !== "object") {
      hydrated[index] = value;
      return value;
    }

    if (Array.isArray(value)) {
      const type = value[0];
      if (type === "Reactive" || type === "ShallowReactive" || type === "Ref" || type === "ShallowRef") {
        const result = hydrate(value[1]);
        hydrated[index] = result;
        return result;
      }
      if (type === "Set") {
        const result = new Set();
        hydrated[index] = result;
        for (let i = 1; i < value.length; i += 1) result.add(hydrate(value[i]));
        return result;
      }
      if (typeof type === "string") return undefined;

      const result = [];
      hydrated[index] = result;
      for (const item of value) result.push(item === -2 ? undefined : hydrate(item));
      return result;
    }

    const result = {};
    hydrated[index] = result;
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__") continue;
      result[key] = hydrate(item);
    }
    return result;
  }

  try {
    return hydrate(0);
  } catch {
    return null;
  }
}

function walk(value, visit, seen = new Set()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, seen);
  } else {
    for (const item of Object.values(value)) walk(item, visit, seen);
  }
}

function parseNuxtData(html) {
  const payload = readNuxtPayload(html);
  if (!payload) return null;
  return decodeNuxtData(payload);
}

function findDetail(value) {
  let found = null;
  walk(value, (node) => {
    if (found) return;
    if (node.subject && node.resource && typeof node.subject === "object") {
      found = { subject: node.subject, resource: node.resource };
    }
  });
  return found;
}

function collectSubjects(value) {
  const subjects = new Map();
  walk(value, (node) => {
    if (typeof node.detailPath !== "string" || node.detailPath.length < 3) return;
    if (typeof node.title !== "string" || !node.title) return;
    if (!subjects.has(node.detailPath)) {
      subjects.set(node.detailPath, {
        detailPath: node.detailPath,
        title: node.title,
        year: node.releaseDate ? String(node.releaseDate).slice(0, 4) : "",
        subjectType: node.subjectType,
        subjectId: node.subjectId,
        hasResource: node.hasResource,
        cover: node.cover?.url || "",
      });
    }
  });
  return [...subjects.values()];
}

/* ---------------------------------- search -------------------------------- */

async function searchSubjects(keyword, signal) {
  const html = await request(
    `${BASE}/newWeb/searchResult?keyword=${encodeURIComponent(keyword)}`,
    { headers: { "User-Agent": UA }, timeout: 14000, responseType: "text", signal },
  );

  const data = parseNuxtData(html);
  let subjects = data ? collectSubjects(data) : [];

  if (!subjects.length) {
    // Fallback: plain markup anchors.
    const anchors = [...String(html).matchAll(/href="\/moviesDetail\/([^"]+)"[^>]*?(?:title="([^"]*)")?/g)];
    const map = new Map();
    for (const anchor of anchors) {
      const detailPath = anchor[1];
      if (!detailPath || map.has(detailPath)) continue;
      map.set(detailPath, {
        detailPath,
        title: (anchor[2] || detailPath.split("-").slice(0, -1).join(" ")).replace(/-/g, " "),
        year: "",
      });
    }
    subjects = [...map.values()];
  }

  return subjects.filter((subject) => subject.hasResource !== false);
}

async function detailPage(detailPath, signal) {
  return cached(`raven:detail:${detailPath}`, 20 * 60 * 1000, async () => {
    const html = await request(`${BASE}/moviesDetail/${detailPath}`, {
      headers: { "User-Agent": UA },
      timeout: 15000,
      responseType: "text",
      signal,
    });
    const data = parseNuxtData(html);
    return data ? findDetail(data) : null;
  });
}

function pickDub(subject) {
  const dubs = Array.isArray(subject?.dubs) ? subject.dubs : [];
  if (!dubs.length) return { subjectId: subject.subjectId, detailPath: subject.detailPath, language: "Original" };
  const preferred =
    dubs.find((dub) => dub?.original) ||
    dubs.find((dub) => dub?.lanCode === "en") ||
    dubs.find((dub) => /original|english/i.test(String(dub?.lanName || ""))) ||
    dubs[0];
  return {
    subjectId: preferred.subjectId || subject.subjectId,
    detailPath: preferred.detailPath || subject.detailPath,
    language: preferred.lanName || preferred.lanCode || "Original",
    fallbackSubjectId: subject.subjectId,
    fallbackDetailPath: subject.detailPath,
  };
}

function streamType(format, url) {
  const normalized = String(format || "").toUpperCase();
  if (normalized === "HLS" || normalized === "M3U8") return "hls";
  if (normalized === "DASH" || normalized === "MPD") return "dash";
  const clean = String(url || "").split("?")[0].toLowerCase();
  if (clean.endsWith(".m3u8")) return "hls";
  if (clean.endsWith(".mpd")) return "dash";
  return "mp4";
}

function qualityOf(resolutions) {
  const values = String(resolutions || "")
    .split(",")
    .map((value) => Number(value))
    .filter((value) => [360, 480, 720, 1080, 2160].includes(value));
  if (!values.length) return "";
  return String(Math.max(...values));
}

async function playData(subjectId, detailPath, season, episode, isSeries, referer, signal) {
  const params = new URLSearchParams({ subjectId, detailPath });
  if (isSeries && season > 0) {
    params.set("se", String(season));
    params.set("ep", String(episode));
  }
  try {
    const response = await getJson(`${BASE}/wefeed-h5api-bff/subject/play?${params.toString()}`, {
      headers: { ...apiHeaders, Referer: referer },
      timeout: 15000,
      signal,
    });
    return response;
  } catch {
    return null;
  }
}

function hasStreams(payload) {
  if (!payload || payload.code !== 0 || payload.data?.hasResource === false) return false;
  const sources = [
    ...(payload.data?.streams || []),
    ...(payload.data?.hls || []),
    ...(payload.data?.dash || []),
  ];
  return sources.some((source) => source?.url && !source?.vipLocked);
}

async function captions(subjectId, detailPath, source, referer, signal) {
  if (!source?.id || !source?.format) return [];
  try {
    const params = new URLSearchParams({
      format: source.format,
      id: source.id,
      subjectId,
      detailPath,
    });
    const response = await getJson(`${BASE}/wefeed-h5api-bff/subject/caption?${params.toString()}`, {
      headers: { ...apiHeaders, Referer: referer },
      timeout: 10000,
      signal,
    });
    return (response?.data?.captions || [])
      .filter((caption) => caption?.url)
      .map((caption) => ({
        title: caption.lanName || caption.lan || "Subtitle",
        language: String(caption.lan || "und").slice(0, 2).toLowerCase(),
        url: caption.url,
      }));
  } catch {
    return [];
  }
}

/* --------------------------------- resolve -------------------------------- */

export async function resolve({ tmdbId, title, year, type, season = 1, episode = 1, signal }) {
  return withTimeout(
    (async () => {
      if (!title) return [];

      const subjects = await cached(`raven:search:${title}`, 10 * 60 * 1000, () =>
        searchSubjects(title, signal),
      );
      if (!subjects.length) return [];

      const best = pickBest(subjects, title, { type, year, typeOf: (item) => (item.subjectType === 2 ? "tv" : "movie") });
      if (!best) return [];

      const detail = await detailPage(best.detailPath, signal);
      const subject = detail?.subject || best;
      const isSeries = Number(subject.subjectType) === 2 || type === "tv";
      const dub = pickDub(subject);

      const watchParams = new URLSearchParams({
        id: dub.subjectId || subject.subjectId || "",
        type: "/movie/detail",
        detailSe: isSeries ? String(season) : "",
        detailEp: isSeries ? String(episode) : "",
        lang: "en",
      });
      const referer = `${BASE}/movies/${dub.detailPath}?${watchParams.toString()}`;

      let payload = await playData(
        dub.subjectId,
        dub.detailPath,
        Number(season),
        Number(episode),
        isSeries,
        referer,
        signal,
      );

      if (!hasStreams(payload) && dub.fallbackSubjectId && dub.fallbackSubjectId !== dub.subjectId) {
        payload = await playData(
          dub.fallbackSubjectId,
          dub.fallbackDetailPath,
          Number(season),
          Number(episode),
          isSeries,
          referer,
          signal,
        );
      }

      if (!payload || payload.data?.hasResource === false) return [];

      const sources = [
        ...(payload.data?.streams || []),
        ...(payload.data?.hls || []),
        ...(payload.data?.dash || []),
      ].filter((source) => source?.url && !source?.vipLocked);

      const streamHeaders = { Referer: `${BASE}/`, Origin: BASE, "User-Agent": UA };

      return Promise.all(
        sources.map(async (source) => ({
          server: "Raven",
          label: `${dub.language !== "Original" ? `${dub.language} · ` : ""}${qualityOf(source.resolutions) || source.format || "Auto"}${
            qualityOf(source.resolutions) ? "p" : ""
          }`,
          url: source.url,
          type: streamType(source.format, source.url),
          quality: qualityOf(source.resolutions),
          headers: streamHeaders,
          subtitles: await captions(dub.subjectId, dub.detailPath, source, referer, signal),
        })),
      );
    })(),
    24000,
    [],
  );
}
