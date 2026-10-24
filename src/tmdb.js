import { getJson } from "./lib/http.js";
import { cached } from "./lib/cache.js";

/**
 * TMDB powers metadata only (title, artwork, seasons, IMDb id).
 * Every stream is resolved by our own provider engines.
 */
const FALLBACK_KEY = "cfe422613b250f702980a3bbf9e90716";
const KEY = () => process.env.TMDB_API_KEY || FALLBACK_KEY;
const BASE = "https://api.themoviedb.org/3";
const IMAGE = "https://image.tmdb.org/t/p";

const META_TTL = 6 * 60 * 60 * 1000;
const SEASON_TTL = 6 * 60 * 60 * 1000;

function img(path, size = "w1280") {
  return path ? `${IMAGE}/${size}${path}` : "";
}

function mediaType(type) {
  return String(type).toLowerCase() === "tv" || String(type).toLowerCase() === "series" ? "tv" : "movie";
}

function episodeFrom(raw) {
  return {
    episode: Number(raw.episode_number) || 0,
    season: Number(raw.season_number) || 0,
    name: raw.name || `Episode ${raw.episode_number}`,
    overview: raw.overview || "",
    still: img(raw.still_path, "w300"),
    airDate: raw.air_date || "",
    runtime: Number(raw.runtime) || null,
    rating: Number(raw.vote_average) || null,
  };
}

export async function getMeta(type, tmdbId) {
  const kind = mediaType(type);
  const id = String(tmdbId || "").replace(/[^0-9]/g, "");
  if (!id) throw new Error("A numeric TMDB id is required");

  return cached(`tmdb:${kind}:${id}`, META_TTL, async () => {
    const data = await getJson(`${BASE}/${kind}/${id}?api_key=${KEY()}&append_to_response=external_ids`, {
      timeout: 10000,
      retries: 1,
    });
    if (!data || data.success === false) throw new Error("TMDB returned no metadata");

    const isTv = kind === "tv";
    const title = data.title || data.name || "Untitled";
    const date = data.release_date || data.first_air_date || "";
    const seasons = isTv
      ? (data.seasons || [])
          .filter((season) => season && season.season_number > 0)
          .map((season) => ({
            season: Number(season.season_number),
            name: season.name || `Season ${season.season_number}`,
            episodes: Number(season.episode_count) || 0,
            airDate: season.air_date || "",
            poster: img(season.poster_path, "w500"),
          }))
      : [];

    return {
      id: Number(id),
      type: isTv ? "tv" : "movie",
      title: String(title),
      originalTitle: String(data.original_title || data.original_name || title),
      year: date ? date.slice(0, 4) : "",
      releaseDate: date,
      overview: data.overview || "",
      tagline: data.tagline || "",
      rating: Number(data.vote_average) || 0,
      votes: Number(data.vote_count) || 0,
      runtime: Number(data.runtime) || (Array.isArray(data.episode_run_time) ? data.episode_run_time[0] : 0) || 0,
      genres: (data.genres || []).map((genre) => genre.name).filter(Boolean),
      backdrop: img(data.backdrop_path, "w1280"),
      backdropLarge: img(data.backdrop_path, "original"),
      poster: img(data.poster_path, "w500"),
      imdbId: data.external_ids?.imdb_id || data.imdb_id || "",
      status: data.status || "",
      seasons,
      totalEpisodes: isTv ? Number(data.number_of_episodes) || 0 : 0,
      totalSeasons: isTv ? Number(data.number_of_seasons) || 0 : 0,
    };
  });
}

export async function getSeason(tmdbId, seasonNumber) {
  const id = String(tmdbId || "").replace(/[^0-9]/g, "");
  const season = Math.max(0, Number(seasonNumber) || 1);
  return cached(`tmdb:season:${id}:${season}`, SEASON_TTL, async () => {
    const data = await getJson(`${BASE}/tv/${id}/season/${season}?api_key=${KEY()}`, {
      timeout: 10000,
      retries: 1,
    });
    return {
      season,
      name: data.name || `Season ${season}`,
      episodes: (data.episodes || []).map(episodeFrom),
    };
  });
}

/** Minimal metadata fallback so the UI still renders when TMDB is unreachable. */
export function fallbackMeta(type, tmdbId, hint = {}) {
  const kind = mediaType(type) === "tv" ? "tv" : "movie";
  return {
    id: Number(tmdbId) || 0,
    type: kind,
    title: hint.title || `TMDB ${tmdbId}`,
    originalTitle: hint.title || "",
    year: hint.year || "",
    releaseDate: "",
    overview: "",
    tagline: "",
    rating: 0,
    votes: 0,
    runtime: 0,
    genres: [],
    backdrop: hint.poster || "",
    backdropLarge: hint.poster || "",
    poster: hint.poster || "",
    imdbId: hint.imdbId || "",
    status: "",
    seasons: [],
    totalEpisodes: 0,
    totalSeasons: 0,
  };
}
