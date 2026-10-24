/**
 * Demo mode (?demo=1) — renders the real player UI with sample metadata and
 * public test streams. Useful for design review and for environments where the
 * source engines are not reachable.
 */

const MOVIE = {
  id: 550,
  type: "movie",
  title: "Fight Club",
  originalTitle: "Fight Club",
  year: "1999",
  releaseDate: "1999-10-15",
  overview:
    "A disillusioned office worker finds an outlet for his pent-up feelings when he and mysterious new pal Tyler Durden start a violent underground society.",
  tagline: "Mischief. Mayhem. Soap.",
  rating: 8.4,
  votes: 2900000,
  runtime: 139,
  genres: ["Drama", "Thriller"],
  backdrop: "https://image.tmdb.org/t/p/w1280/hZkgoQYus5vegHoetLkCJzb17zJ.jpg",
  backdropLarge: "https://image.tmdb.org/t/p/original/hZkgoQYus5vegHoetLkCJzb17zJ.jpg",
  poster: "https://image.tmdb.org/t/p/w500/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg",
  imdbId: "tt0137523",
  status: "Released",
  seasons: [],
  totalEpisodes: 0,
  totalSeasons: 0,
};

const TV = {
  id: 1396,
  type: "tv",
  title: "Breaking Bad",
  originalTitle: "Breaking Bad",
  year: "2008",
  releaseDate: "2008-01-20",
  overview:
    "A terminally ill chemistry teacher teams with a former student to manufacture crystal meth to secure his family's future.",
  tagline: "Change the equation.",
  rating: 9.2,
  votes: 1500000,
  runtime: 48,
  genres: ["Drama", "Crime", "Thriller"],
  backdrop: "https://image.tmdb.org/t/p/w1280/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg",
  backdropLarge: "https://image.tmdb.org/t/p/original/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg",
  poster: "https://image.tmdb.org/t/p/w500/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg",
  imdbId: "tt0903747",
  status: "Ended",
  seasons: [
    { season: 1, name: "Season 1", episodes: 7, airDate: "2008-01-20", poster: "" },
    { season: 2, name: "Season 2", episodes: 13, airDate: "2009-03-08", poster: "" },
    { season: 3, name: "Season 3", episodes: 13, airDate: "2010-03-21", poster: "" },
  ],
  totalEpisodes: 62,
  totalSeasons: 5,
};

const SAMPLE_HLS = [
  "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
  "https://test-streams.mux.dev/pts_shift/master.m3u8",
  "https://test-streams.mux.dev/tos_ismc/main.m3u8",
];

const SAMPLE_VTT =
  "data:text/vtt;charset=utf-8," +
  encodeURIComponent(`WEBVTT

00:00:02.000 --> 00:00:08.000
Priva Embed — sample subtitle track.

00:00:10.000 --> 00:00:16.000
Switch sources with the pill in the top bar.
`);

export function demoMeta(type) {
  return type === "tv" ? { ...TV } : { ...MOVIE };
}

export function demoSeason(seasonNumber) {
  const season = TV.seasons.find((entry) => entry.season === Number(seasonNumber)) || TV.seasons[0];
  const episodes = Array.from({ length: season.episodes }, (_, index) => {
    const episode = index + 1;
    return {
      episode,
      season: season.season,
      name: `${TV.title} S${season.season}E${String(episode).padStart(2, "0")}`,
      overview: "Sample episode data for the Priva demo player.",
      still: TV.backdrop,
      airDate: season.airDate,
      runtime: 47,
      rating: 8.6,
    };
  });
  return { season: season.season, name: season.name, episodes };
}

export function demoSources({ type, season, episode }) {
  const providers = [
    { id: "clarke", name: "Clarke", offset: 0 },
    { id: "bellamy", name: "Bellamy", offset: 1 },
    { id: "raven", name: "Raven", offset: 2 },
  ];

  return {
    tmdbId: type === "tv" ? TV.id : MOVIE.id,
    type,
    season,
    episode,
    demo: true,
    skip: type === "tv" ? [{ title: "Intro", from: 4, to: 18 }] : [],
    providers: providers.map((provider, index) => ({
      id: provider.id,
      name: provider.name,
      status: "ok",
      ms: 420 + index * 260,
      streams: [
        {
          id: `${provider.id}-0`,
          server: provider.name,
          label: `Mirror A · 1080p`,
          type: "hls",
          quality: "1080",
          language: "",
          url: SAMPLE_HLS[(index + provider.offset) % SAMPLE_HLS.length],
          subtitles: [
            {
              title: "English",
              language: "en",
              url: SAMPLE_VTT,
            },
          ],
        },
        {
          id: `${provider.id}-1`,
          server: provider.name,
          label: "Mirror B · 720p",
          type: "hls",
          quality: "720",
          language: "",
          url: SAMPLE_HLS[(index + 1) % SAMPLE_HLS.length],
          subtitles: [],
        },
      ],
    })),
  };
}
