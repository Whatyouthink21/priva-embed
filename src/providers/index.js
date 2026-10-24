import * as clarke from "./clarke.js";
import * as bellamy from "./bellamy.js";
import * as nova from "./nova.js";

/**
 * Provider registry. Only codenames are ever exposed to the browser.
 */
export const PROVIDERS = {
  clarke: { id: clarke.id, name: clarke.name, resolve: clarke.resolve },
  bellamy: { id: bellamy.id, name: bellamy.name, resolve: bellamy.resolve },
  nova: { id: nova.id, name: nova.name, resolve: nova.resolve },
};

export const PROVIDER_ORDER = ["clarke", "bellamy", "nova"];

export function providerList() {
  return PROVIDER_ORDER.map((key) => ({ id: key, name: PROVIDERS[key].name }));
}

function sortStreams(streams) {
  return [...streams].sort((a, b) => {
    const aScore = a.type === "hls" ? 3 : a.type === "mp4" ? 2 : 1;
    const bScore = b.type === "hls" ? 3 : b.type === "mp4" ? 2 : 1;
    if (aScore !== bScore) return bScore - aScore;
    return Number(b.quality || 0) - Number(a.quality || 0);
  });
}

/**
 * Resolve sources for one or more providers in parallel.
 * Always resolves; never throws for a single failing engine.
 */
export async function resolveSources(context, { providers, signal } = {}) {
  const wanted = (providers && providers.length ? providers : PROVIDER_ORDER).filter(
    (key) => PROVIDERS[key],
  );

  const started = Date.now();
  const results = await Promise.all(
    wanted.map(async (key) => {
      const startedAt = Date.now();
      try {
        const streams = await PROVIDERS[key].resolve({ ...context, signal });
        const cleaned = sortStreams(
          (streams || [])
            .filter((stream) => stream && stream.url)
            .map((stream, index) => ({
              id: `${key}-${index}`,
              server: stream.server || PROVIDERS[key].name,
              label: stream.label || stream.quality || "Auto",
              url: stream.url,
              type: stream.type || "mp4",
              quality: stream.quality || "",
              language: stream.language || "",
              headers: stream.headers || {},
              subtitles: Array.isArray(stream.subtitles) ? stream.subtitles : [],
            })),
        );
        return {
          id: key,
          name: PROVIDERS[key].name,
          status: cleaned.length ? "ok" : "empty",
          ms: Date.now() - startedAt,
          streams: cleaned.slice(0, 12),
        };
      } catch (error) {
        return {
          id: key,
          name: PROVIDERS[key].name,
          status: "error",
          ms: Date.now() - startedAt,
          message: error?.message || "provider failed",
          streams: [],
        };
      }
    }),
  );

  return {
    providers: results,
    ms: Date.now() - started,
  };
}

export { bellamy };
