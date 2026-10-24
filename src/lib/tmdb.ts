import axios from "axios";

const http = axios.create({
  timeout: 15000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/json",
  },
});

export interface TmdbMeta {
  tmdbId: string;
  imdbId?: string;
  title: string;
  synopsis: string;
  year?: string;
  poster?: string; // https://image.tmdb.org/t/p/w500/...
  backdrop?: string;
  type: "movie" | "series";
}

/*
 * Resolve a TMDB id into display metadata.
 *
 * Priva Embed works from TMDB ids only (the embed URLs carry {tmdb_id}).
 * The vega extractors (autoEmbed / Bellamy) resolve TMDB ids through the
 * public mirrors below, so we use the same source of truth here for the
 * movie/TV title, poster and year shown in the player.
 */
export async function resolveTmdbMeta(
  tmdbId: string,
  type: "movie" | "series" = "movie",
): Promise<TmdbMeta> {
  const fallback: TmdbMeta = {
    tmdbId,
    title: type === "series" ? `TV Show ${tmdbId}` : `Movie ${tmdbId}`,
    synopsis: "",
    type,
  };

  try {
    const base =
      process.env.TMDB_MIRROR_BASE || "https://db.wecollege.net/3";
    const kind = type === "series" ? "tv" : "movie";
    const { data } = await http.get(`${base}/${kind}/${tmdbId}`, {
      params: { append_to_response: "external_ids" },
    });

    const imdbId =
      data?.external_ids?.imdb_id ||
      data?.imdb_id ||
      (typeof data?.imdbId === "string" ? data.imdbId : undefined);
    const release = data?.release_date || data?.first_air_date || "";
    const posterPath = data?.poster_path;
    const backdropPath = data?.backdrop_path;

    return {
      tmdbId,
      imdbId: imdbId || undefined,
      title: data?.title || data?.name || fallback.title,
      synopsis: data?.overview || data?.synopsis || "",
      year: release.slice(0, 4) || undefined,
      poster: posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : undefined,
      backdrop: backdropPath
        ? `https://image.tmdb.org/t/p/w780${backdropPath}`
        : undefined,
      type,
    };
  } catch (err) {
    console.warn("[priva] tmdb resolution failed:", err);
    return fallback;
  }
}
