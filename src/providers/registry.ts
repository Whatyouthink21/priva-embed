/*
 * Priva Embed provider registry.
 *
 * Real provider names are intentionally never exposed to the player.
 * The player only sees the codename:
 *   castle   -> Clarke
 *   movieBoxWeb -> Raven
 *   autoEmbed -> Bellamy
 */
import type { Stream, ProviderContext } from "../../providers/vega/types";
import { providerContext } from "./context";

export type ProviderId = "clarke" | "raven" | "bellamy";

export const PROVIDER_DISPLAY: Record<ProviderId, string> = {
  clarke: "Clarke",
  raven: "Raven",
  bellamy: "Bellamy",
};

export const ALL_PROVIDERS: ProviderId[] = ["clarke", "raven", "bellamy"];

export interface ResolvedStream {
  provider: ProviderId;
  server: string;
  link: string;
  type: string;
  quality?: string;
  tag?: string;
  tags?: string[];
  subtitles?: any[];
  headers?: Record<string, string>;
  isDownload?: boolean;
}

export interface ProviderResult {
  provider: ProviderId;
  ok: boolean;
  streams: ResolvedStream[];
  error?: string;
}

type GetStreamInput = {
  link: string;
  type: string;
  signal?: AbortSignal;
  season?: number;
  episode?: number;
};

/* ------------------------------------------------------------------ */
/* Clarke — castle                                                    */
/* ------------------------------------------------------------------ */
import {
  getMeta as clarkeGetMeta,
} from "../../providers/vega/castle/meta";
import {
  getStream as clarkeGetStream,
} from "../../providers/vega/castle/stream";
import {
  apiSearch,
  apiMovieDetails,
  mediaLink,
  parseMediaLink,
  playLink,
} from "../../providers/vega/castle/castleCore";

function matchTitle(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.includes(y) || y.includes(x);
}

function findEpisode(
  episodes: any[],
  season: number,
  episode: number,
): { id: string; index: number } | null {
  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    if (
      ep &&
      (Number(ep.season ?? ep.seasonNumber ?? 0) === season ||
        Number(ep.season_id ?? 0) === season) &&
      (Number(ep.episode ?? ep.episodeNumber ?? 0) === episode ||
        Number(ep.episode_id ?? 0) === episode)
    ) {
      return { id: String(ep.id), index: i };
    }
  }
  return null;
}

async function clarkeResolveLink(
  title: string,
  isSeries: boolean,
  season: number,
  episode: number,
): Promise<string | null> {
  const posts = await (
    (await import("../../providers/vega/castle/posts")).getPosts({
      filter: isSeries ? "series" : "movie",
      page: 1,
      providerContext,
    })
  );
  const post = posts.find((p) => matchTitle(p.title, title));
  if (!post) return null;
  const movieId = parseMediaLink(post.link);
  if (!movieId) return null;

  if (!isSeries) {
    const meta = await clarkeGetMeta({ link: mediaLink(movieId), providerContext });
    const direct = meta.linkList?.[0]?.directLinks?.[0]?.link;
    if (direct) return direct;
    return playLink(movieId, "1");
  }

  const details = await apiMovieDetails(movieId, providerContext);
  const picked: any = (details?.data?.data ?? details?.data ?? details) ?? {};
  const episodes: any[] = Array.isArray(picked.episodes) ? picked.episodes : [];
  const ep = findEpisode(episodes, season, episode);
  if (ep) return playLink(movieId, ep.id);
  const fallback = episodes[Math.max(0, episode - 1)];
  if (fallback?.id) return playLink(movieId, String(fallback.id));
  return playLink(movieId, "1");
}

export async function clarkeStreams(input: GetStreamInput): Promise<ProviderResult> {
  const { type, signal, season = 1, episode = 1 } = input;
  try {
    // Bellamy autoEmbed passes title/year in its payload; clarke needs a title.
    // Without a resolved title we cannot search castle.
    const title = (input as any).title || `tmdb-${(input as any).tmdbId}`;
    const link = await clarkeResolveLink(
      title,
      type === "series",
      season,
      episode,
    );
    if (!link) {
      return { provider: "clarke", ok: true, streams: [], error: "no castle match" };
    }
    const raw = await clarkeGetStream({ link, type, signal: signal as AbortSignal, providerContext });
    const streams: ResolvedStream[] = raw.map((s: Stream) => ({
      provider: "clarke",
      server: s.server || "Clarke",
      link: s.link,
      type: s.type || "mp4",
      quality: s.quality,
      tag: s.tag,
      tags: s.tags,
      subtitles: s.subtitles,
      headers: s.headers,
    }));
    return { provider: "clarke", ok: true, streams };
  } catch (err: any) {
    return {
      provider: "clarke",
      ok: false,
      streams: [],
      error: err?.message || String(err),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Raven — movieBoxWeb                                                */
/* ------------------------------------------------------------------ */
import {
  getMeta as ravenGetMeta,
} from "../../providers/vega/movieBoxWeb/meta";
import {
  getStream as ravenGetStream,
} from "../../providers/vega/movieBoxWeb/stream";
import {
  getPosts as ravenGetPosts,
} from "../../providers/vega/movieBoxWeb/posts";

async function ravenResolveLink(
  title: string,
  isSeries: boolean,
  season: number,
  episode: number,
): Promise<string | null> {
  for (let page = 1; page <= 3; page++) {
    const posts = await ravenGetPosts({
      filter: isSeries ? "series" : "movie",
      page,
      providerValue: "movieBoxWeb",
      providerContext,
      signal: undefined as unknown as AbortSignal,
    });
    const post = posts.find((p) => matchTitle(p.title, title));
    if (!post) continue;
    let link: string = post.link;
    if (isSeries) {
      const meta = await ravenGetMeta({ link, providerContext });
      const episodesLink =
        meta.linkList?.find((l: any) => /season/i.test(l.title))?.episodesLink ||
        meta.linkList?.[0]?.episodesLink;
      if (episodesLink) {
        const playback = JSON.parse(episodesLink);
        playback.season = season;
        playback.episode = episode;
        link = JSON.stringify(playback);
      }
    }
    return link;
  }
  return null;
}

export async function ravenStreams(input: GetStreamInput): Promise<ProviderResult> {
  const { type, signal, season = 1, episode = 1 } = input;
  try {
    const title = (input as any).title || `tmdb-${(input as any).tmdbId}`;
    const link = await ravenResolveLink(title, type === "series", season, episode);
    if (!link) {
      return { provider: "raven", ok: true, streams: [], error: "no moviebox match" };
    }
    const raw = await ravenGetStream({ link, type, signal: signal as AbortSignal, providerContext });
    const streams: ResolvedStream[] = raw.map((s: Stream) => ({
      provider: "raven",
      server: s.server || "Raven",
      link: s.link,
      type: s.type || "mp4",
      quality: s.quality,
      tag: s.tag,
      tags: s.tags,
      subtitles: s.subtitles,
      headers: s.headers,
    }));
    return { provider: "raven", ok: true, streams };
  } catch (err: any) {
    return {
      provider: "raven",
      ok: false,
      streams: [],
      error: err?.message || String(err),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Bellamy — autoEmbed                                                */
/* ------------------------------------------------------------------ */
import {
  getStream as bellamyGetStream,
} from "../../providers/vega/autoEmbed/stream";

export async function bellamyStreams(input: GetStreamInput): Promise<ProviderResult> {
  const { type, signal, season = 1, episode = 1 } = input;
  try {
    const tmdbId = (input as any).tmdbId || "";
    const title = (input as any).title || "";
    const year = (input as any).year || "";
    const payload = {
      tmdbId,
      imdbId: (input as any).imdbId || "",
      season,
      episode,
      type,
      title,
      year,
    };
    const raw = await bellamyGetStream({
      link: JSON.stringify(payload),
      type,
      signal: signal as AbortSignal,
      providerContext,
    });
    const streams: ResolvedStream[] = raw.map((s: Stream) => ({
      provider: "bellamy",
      server: s.server || "Bellamy",
      link: s.link,
      type: s.type || "mp4",
      quality: s.quality,
      tag: s.tag,
      tags: s.tags,
      subtitles: s.subtitles,
      headers: s.headers,
    }));
    return { provider: "bellamy", ok: true, streams };
  } catch (err: any) {
    return {
      provider: "bellamy",
      ok: false,
      streams: [],
      error: err?.message || String(err),
    };
  }
}
