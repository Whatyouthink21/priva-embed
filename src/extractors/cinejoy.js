import { getJson, request } from "../lib/http.js";

const ORIGIN = "https://cinejoy.pk";
const CHUNK_FALLBACK = `${ORIGIN}/_app/immutable/chunks/DHJgaGwg.js`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let chunkCache = { code: null, at: 0 };
let serverCache = { list: ["Nebula", "Solara", "Athens"], at: 0 };

async function fetchChunk(headers, signal) {
  if (chunkCache.code && Date.now() - chunkCache.at < 30 * 60 * 1000) return chunkCache.code;

  try {
    const code = await request(CHUNK_FALLBACK, { headers, timeout: 8000, responseType: "text", signal });
    if (typeof code === "string" && code.includes("WebAssembly") && code.includes('+"/g"')) {
      chunkCache = { code, at: Date.now() };
      return code;
    }
  } catch {
    /* try discovery */
  }

  try {
    const html = await request(ORIGIN, { headers, timeout: 8000, responseType: "text", signal });
    const appMatch = String(html).match(/_app\/immutable\/entry\/app\.[a-zA-Z0-9_-]+\.js/);
    if (appMatch) {
      const appText = await request(`${ORIGIN}/${appMatch[0]}`, {
        headers,
        timeout: 8000,
        responseType: "text",
        signal,
      });
      const nodeMatch = String(appText).match(/nodes\/25\.[a-zA-Z0-9_-]+\.js/);
      if (nodeMatch) {
        const nodeText = await request(`${ORIGIN}/_app/immutable/${nodeMatch[0]}`, {
          headers,
          timeout: 8000,
          responseType: "text",
          signal,
        });
        const chunks = [...String(nodeText).matchAll(/chunks\/([a-zA-Z0-9_-]+\.js)/g)].map((m) => m[1]);
        for (const chunk of chunks.slice(0, 12)) {
          const chunkUrl = `${ORIGIN}/_app/immutable/chunks/${chunk}`;
          try {
            const code = await request(chunkUrl, {
              headers,
              timeout: 8000,
              responseType: "text",
              signal,
            });
            if (typeof code === "string" && code.includes("WebAssembly") && code.includes('+"/g"')) {
              chunkCache = { code, at: Date.now() };
              return code;
            }
          } catch {
            /* next chunk */
          }
        }
      }
    }
  } catch {
    /* ignore */
  }

  const fallback = await request(CHUNK_FALLBACK, { headers, timeout: 8000, responseType: "text", signal });
  chunkCache = { code: fallback, at: Date.now() };
  return fallback;
}

async function fetchServers(headers, signal) {
  if (Date.now() - serverCache.at < 5 * 60 * 1000) return serverCache.list;
  try {
    const response = await getJson("https://api.wing.st/servers", { headers, timeout: 6000, signal });
    const list = (response?.servers || [])
      .filter((server) => server && server.name !== "Lisbon" && server.status !== "offline")
      .map((server) => server.name);
    if (list.length) {
      serverCache = { list, at: Date.now() };
    }
  } catch {
    /* keep the previous list */
  }
  return serverCache.list;
}

async function fetchSubtitles(tmdbId, isMovie, season, episode, headers, signal) {
  try {
    const url = `https://subs.wing.st/subtitles?tmdb=${tmdbId}${
      isMovie ? "" : `&season=${season || 1}&episode=${episode || 1}`
    }`;
    const data = await getJson(url, { headers, timeout: 6000, signal });
    if (!Array.isArray(data)) return [];
    return data
      .filter((sub) => sub && sub.url)
      .map((sub) => ({
        title: sub.display || sub.language || "Subtitle",
        language: String(sub.language || "en").slice(0, 2).toLowerCase(),
        url: sub.url,
      }));
  } catch {
    return [];
  }
}

function buildSandbox(headers, signal) {
  return {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    caches: { open: async () => ({ match: () => null, put: () => {} }) },
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Uint8Array,
    ArrayBuffer,
    Symbol,
    window: {
      location: {
        origin: ORIGIN,
        href: `${ORIGIN}/`,
        pathname: "/",
        host: "cinejoy.pk",
        hostname: "cinejoy.pk",
      },
      localStorage: { getItem: () => null, setItem: () => {} },
    },
    document: {
      referrer: `${ORIGIN}/`,
      title: "Cinejoy",
      createElement: () => ({}),
      head: { appendChild: () => {} },
      body: { appendChild: () => {} },
    },
    navigator: { onLine: true },
    URLSearchParams,
    URL,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    btoa: (value) => Buffer.from(String(value), "binary").toString("base64"),
    atob: (value) => Buffer.from(String(value), "base64").toString("binary"),
    WebAssembly: globalThis.WebAssembly,
    fetch: async (url, options) => {
      try {
        const buffer = await request(url, {
          method: options?.method || "GET",
          headers: { ...headers, ...(options?.headers || {}) },
          body: options?.body,
          timeout: 9000,
          responseType: "buffer",
          signal,
        });
        const bytes = new Uint8Array(buffer);
        return {
          ok: true,
          status: 200,
          text: async () => Buffer.from(bytes).toString("utf8"),
          json: async () => JSON.parse(Buffer.from(bytes).toString("utf8")),
          arrayBuffer: async () => bytes.buffer,
          headers: new Map(),
        };
      } catch (error) {
        return {
          ok: false,
          status: 500,
          text: async () => "",
          json: async () => ({}),
          arrayBuffer: async () => new ArrayBuffer(0),
          headers: new Map(),
          error,
        };
      }
    },
  };
}

export async function extractCinejoy({ tmdbId, type, season, episode, signal }) {
  const isMovie = type !== "tv";
  if (!tmdbId) return [];

  const watchPath = isMovie
    ? `/watch/movie/${tmdbId}`
    : `/watch/tv/${tmdbId}/${season || 1}/${episode || 1}`;
  const headers = {
    "User-Agent": UA,
    Origin: ORIGIN,
    Referer: `${ORIGIN}${watchPath}`,
    Accept: "*/*",
  };
  const streamHeaders = { Referer: `${ORIGIN}/`, Origin: ORIGIN, "User-Agent": UA };

  try {
    const [code, servers, subtitles] = await Promise.all([
      fetchChunk(headers, signal),
      fetchServers(headers, signal),
      fetchSubtitles(tmdbId, isMovie, season, episode, headers, signal),
    ]);
    if (!code) return [];

    const cleaned = String(code)
      .replace(/import[^;]+;/g, "")
      .replace(/export\s*\{[^}]+\};?/g, "");

    let exportsObject;
    try {
      const runner = new Function(
        "sandbox",
        `with(sandbox) {
          const u = new Proxy({}, { get: () => () => ({}) });
          const B = () => ({});
          const nW = () => ({});
          ${cleaned};
          return {
            resolveMovie: typeof pW !== "undefined" ? pW : (typeof k !== "undefined" ? k : null),
            resolveTv: typeof qW !== "undefined" ? qW : (typeof l !== "undefined" ? l : null),
          };
        }`,
      );
      exportsObject = runner(buildSandbox(headers, signal));
    } catch {
      return [];
    }

    const tasks = servers.map(async (serverName) => {
      try {
        const query = (async () => {
          if (isMovie && typeof exportsObject?.resolveMovie === "function") {
            return exportsObject.resolveMovie(serverName, String(tmdbId));
          }
          if (!isMovie && typeof exportsObject?.resolveTv === "function") {
            return exportsObject.resolveTv(
              serverName,
              String(tmdbId),
              Number(season || 1),
              Number(episode || 1),
            );
          }
          return null;
        })();

        const result = await Promise.race([
          query,
          new Promise((resolve) => setTimeout(() => resolve(null), 9000)),
        ]);
        if (!result?.stream || !Array.isArray(result.stream)) return [];

        const out = [];
        for (const item of result.stream) {
          const itemSubtitles = (item.captions || [])
            .filter((caption) => caption && caption.url)
            .map((caption) => ({
              title: caption.id || caption.language || "Subtitle",
              language: String(caption.language || caption.id || "en").slice(0, 2).toLowerCase(),
              url: caption.url,
            }));

          const merged = [...itemSubtitles];
          for (const sub of subtitles) {
            if (!merged.some((entry) => entry.url === sub.url)) merged.push(sub);
          }

          if (item.type === "hls" && item.playlist) {
            if (item.playlist.includes("cheaptruckrepairs")) continue;
            out.push({
              server: "Bellamy",
              variant: `Mirror ${serverName.slice(0, 1).toUpperCase()}`,
              url: item.playlist,
              type: "hls",
              quality: "1080",
              headers: streamHeaders,
              subtitles: merged,
            });
          } else if (item.type === "file" && item.qualities) {
            for (const [key, value] of Object.entries(item.qualities)) {
              if (!value?.url) continue;
              out.push({
                server: "Bellamy",
                variant: `Mirror ${serverName.slice(0, 1).toUpperCase()}`,
                url: value.url,
                type: value.type || "mp4",
                quality: key.includes("2160")
                  ? "2160"
                  : key.includes("1080")
                  ? "1080"
                  : key.includes("720")
                  ? "720"
                  : "480",
                headers: streamHeaders,
                subtitles: merged,
              });
            }
          }
        }
        return out;
      } catch {
        return [];
      }
    });

    const results = await Promise.allSettled(tasks);
    return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  } catch {
    return [];
  }
}
