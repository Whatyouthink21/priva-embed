const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Server rendered player shell. Everything visual lives in /assets/player.css
 * and /assets/player.js so the UI can hydrate instantly.
 */
export function renderPlayer({ meta, type, season, episode, config }) {
  const isTv = type === "tv";
  const title = config.displayTitle || meta.title || "Untitled";
  const subtitleParts = [];
  if (isTv) subtitleParts.push(`S${season} · E${episode}`);
  else if (meta.year) subtitleParts.push(meta.year);
  if (meta.rating) subtitleParts.push(`★ ${Number(meta.rating).toFixed(1)}`);
  if (meta.runtime) subtitleParts.push(isTv ? `${meta.runtime}m` : `${meta.runtime} min`);

  const backdrop = config.poster || meta.backdropLarge || meta.backdrop || meta.poster || "";
  const poster = config.poster || meta.poster || meta.backdrop || "";

  const payload = {
    tmdbId: meta.id,
    type,
    season,
    episode,
    title,
    year: meta.year || "",
    rating: meta.rating || 0,
    imdbId: meta.imdbId || "",
    genres: meta.genres || [],
    overview: meta.overview || "",
    seasons: meta.seasons || [],
    totalSeasons: meta.totalSeasons || 0,
    theme: config.theme,
    autoplay: config.autoplay,
    autoNext: config.autoNext,
    provider: config.provider,
    lang: config.lang,
    muted: config.muted,
    start: config.start,
    poster,
    backdrop,
    demo: Boolean(config.demo),
    embed: config.embed,
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${escapeHtml(title)} — Priva</title>
<meta name="theme-color" content="#05060a" />
<meta name="robots" content="noindex" />
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="/assets/player.css" />
<style>:root{--primary:${escapeHtml(config.theme)};}</style>
</head>
<body class="loading" data-state="loading">
  <div class="app" id="app">
    <div class="backdrop" id="backdrop">
      ${backdrop ? `<div class="backdrop__image" style="background-image:url('${escapeHtml(backdrop)}')"></div>` : ""}
      <div class="backdrop__vignette"></div>
      <div class="backdrop__grain"></div>
    </div>

    <main class="stage" id="stage">
      <video id="video" class="video" playsinline preload="none" poster="${escapeHtml(poster)}"></video>
      <div class="stage__shade" id="stageShade"></div>

      <div class="spinner-buffer" id="bufferSpinner" aria-hidden="true"><span></span></div>

      <div class="splash" id="splash">
        <div class="splash__inner">
          <div class="brand brand--splash">
            <span class="brand__mark" aria-hidden="true">P</span>
            <span class="brand__name">PRIVA</span>
            <span class="brand__tag">${isTv ? "Series" : "Film"}</span>
          </div>
          <h1 class="splash__title">${escapeHtml(title)}</h1>
          <div class="splash__meta">${escapeHtml(subtitleParts.join("  ·  "))}</div>
          <div class="splash__status" id="splashStatus">
            <span class="pulse-dot"></span>
            <div class="splash__status-copy">
              <strong id="statusTitle">Finding sources</strong>
              <span id="statusHint">This usually takes a few seconds</span>
            </div>
          </div>
          <div class="splash__actions" id="splashActions" hidden>
            <button class="btn btn--primary" id="retryBtn" type="button">Try again</button>
            <button class="btn btn--ghost" id="splashCloseBtn" type="button">Close</button>
          </div>
        </div>
      </div>

      <button class="bigplay" id="bigPlay" type="button" aria-label="Play">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.7-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14z"/></svg>
      </button>

      <div class="skip-intro" id="skipIntro" hidden>
        <button type="button" id="skipIntroBtn">
          <span id="skipIntroLabel">Skip intro</span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14l9-7-9-7zm11 0h2.5v14H16z"/></svg>
        </button>
      </div>

      <div class="next-card" id="nextCard" hidden>
        <div class="next-card__label">Up next</div>
        <div class="next-card__title" id="nextTitle"></div>
        <div class="next-card__actions">
          <button class="btn btn--primary btn--sm" id="nextNow" type="button">Play now</button>
          <button class="btn btn--ghost btn--sm" id="nextCancel" type="button">Cancel</button>
        </div>
      </div>

      <header class="topbar" id="topbar">
        <div class="topbar__left">
          <button class="icon-btn icon-btn--glass" id="backBtn" type="button" aria-label="Back" title="Back">
            <svg viewBox="0 0 24 24"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg>
          </button>
          <div class="topbar__identity">
            <div class="brand brand--bar">
              <span class="brand__mark" aria-hidden="true">P</span>
              <span class="brand__name">PRIVA</span>
            </div>
            <div class="topbar__text">
              <h1 class="topbar__title" title="${escapeHtml(title)}">${escapeHtml(title)}</h1>
              <div class="topbar__meta">
                ${isTv ? `<span class="meta-chip meta-chip--accent">S${season} · E${episode}</span>` : ""}
                ${meta.year && !isTv ? `<span>${escapeHtml(meta.year)}</span>` : ""}
                ${meta.rating ? `<span>★ ${Number(meta.rating).toFixed(1)}</span>` : ""}
                ${!isTv && meta.runtime ? `<span>${meta.runtime} min</span>` : ""}
                <span class="topbar__provider" id="topbarProvider">—</span>
              </div>
            </div>
          </div>
        </div>

        <div class="topbar__right">
          ${isTv ? `<div class="pill pill--episodes" id="episodePill">
            <button type="button" class="pill__nav" id="prevEp" aria-label="Previous episode">
              <svg viewBox="0 0 24 24"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg>
            </button>
            <button type="button" class="pill__label" id="episodesBtn">
              <svg viewBox="0 0 24 24" class="pill__icon"><path d="M4 5h16v2H4zm0 6h16v2H4zm0 6h10v2H4z"/></svg>
              <span id="episodePillLabel">S${season} E${episode}</span>
            </button>
            <button type="button" class="pill__nav" id="nextEp" aria-label="Next episode">
              <svg viewBox="0 0 24 24"><path d="M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z"/></svg>
            </button>
          </div>` : ""}

          <div class="menu-anchor">
            <button class="pill" id="providerBtn" type="button" aria-haspopup="menu" aria-expanded="false">
              <span class="pill__dot"></span>
              <span id="providerBtnLabel">Sources</span>
              <svg viewBox="0 0 24 24" class="pill__chevron"><path d="m6.5 9.5 5.5 5.5 5.5-5.5L19 11l-6.5 6.5L6 11z"/></svg>
            </button>
            <div class="menu menu--providers" id="providerMenu" role="menu" hidden>
              <div class="menu__header">
                <span>Select source</span>
                <span class="menu__hint" id="providerCount"></span>
              </div>
              <div class="menu__body" id="providerList"></div>
            </div>
          </div>

          <div class="menu-anchor">
            <button class="pill" id="qualityBtn" type="button" aria-haspopup="menu" aria-expanded="false">
              <svg viewBox="0 0 24 24" class="pill__icon"><path d="M3 17h3v3H3zm5-6h3v9H8zm5-5h3v14h-3zm5-3h3v17h-3z"/></svg>
              <span id="qualityBtnLabel">Auto</span>
              <svg viewBox="0 0 24 24" class="pill__chevron"><path d="m6.5 9.5 5.5 5.5 5.5-5.5L19 11l-6.5 6.5L6 11z"/></svg>
            </button>
            <div class="menu menu--quality" id="qualityMenu" role="menu" hidden>
              <div class="menu__header"><span>Quality</span><span class="menu__hint" id="qualityCount"></span></div>
              <div class="menu__body" id="qualityList"></div>
            </div>
          </div>
        </div>
      </header>

      <footer class="bottombar" id="bottombar">
        <div class="scrubber" id="scrubber" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
          <div class="scrubber__tooltip" id="scrubTooltip" hidden>0:00</div>
          <div class="scrubber__rail">
            <div class="scrubber__buffer" id="scrubBuffer"></div>
            <div class="scrubber__hover" id="scrubHover"></div>
            <div class="scrubber__played" id="scrubPlayed"></div>
          </div>
          <div class="scrubber__handle" id="scrubHandle"></div>
        </div>

        <div class="controls">
          <div class="controls__group">
            <button class="icon-btn" id="playBtn" type="button" aria-label="Play">
              <svg viewBox="0 0 24 24" id="playIcon"><path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.7-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14z"/></svg>
            </button>
            <button class="icon-btn" id="back10" type="button" aria-label="Rewind 10 seconds">
              <svg viewBox="0 0 24 24"><path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>
            </button>
            <button class="icon-btn" id="fwd10" type="button" aria-label="Forward 10 seconds">
              <svg viewBox="0 0 24 24"><path d="M12 5V2l5 4-5 4V7a5 5 0 1 0 5 5h2a7 7 0 1 1-7-7z"/></svg>
            </button>
            <div class="volume" id="volume">
              <button class="icon-btn" id="muteBtn" type="button" aria-label="Mute">
                <svg viewBox="0 0 24 24" id="volumeIcon"><path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>
              </button>
              <input class="volume__slider" id="volumeSlider" type="range" min="0" max="1" step="0.02" value="1" aria-label="Volume" />
            </div>
            <div class="time"><span id="timeNow">0:00</span><span class="time__sep">/</span><span id="timeTotal">0:00</span></div>
          </div>

          <div class="controls__group controls__group--right">
            <button class="icon-btn" id="subtitlesBtn" type="button" aria-label="Subtitles" title="Subtitles">
              <svg viewBox="0 0 24 24"><path d="M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm2 10h6v2H5zm8 0h6v2h-6zM5 9h14v4H5z"/></svg>
            </button>
            <div class="menu-anchor">
              <button class="icon-btn" id="settingsBtn" type="button" aria-label="Settings" title="Settings">
                <svg viewBox="0 0 24 24"><path d="M19.4 13a7.6 7.6 0 0 0 .06-1 7.6 7.6 0 0 0-.06-1l2.1-1.6-2-3.5-2.5 1a7.5 7.5 0 0 0-1.7-1L15 3h-4l-.4 2.7a7.5 7.5 0 0 0-1.7 1l-2.5-1-2 3.5L6.5 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1L11 21h4l.4-2.7c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5-2.2-1.8zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"/></svg>
              </button>
              <div class="menu menu--settings" id="settingsMenu" role="menu" hidden>
                <div class="menu__header"><span>Playback</span><span class="menu__hint">Speed</span></div>
                <div class="menu__body" id="speedList"></div>
                <div class="menu__header menu__header--sep"><span>Subtitles</span><span class="menu__hint" id="subtitleCount"></span></div>
                <div class="menu__body" id="subtitleList"></div>
              </div>
            </div>
            <button class="icon-btn" id="pipBtn" type="button" aria-label="Picture in picture" title="Picture in picture">
              <svg viewBox="0 0 24 24"><path d="M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm11 6v5h6v-5z"/></svg>
            </button>
            <button class="icon-btn" id="fullscreenBtn" type="button" aria-label="Fullscreen" title="Fullscreen">
              <svg viewBox="0 0 24 24" id="fullscreenIcon"><path d="M4 9V4h5v2H6v3H4zm16 0V4h-5v2h3v3h2zm-16 6v5h5v-2H6v-3H4zm16 0v5h-5v-2h3v-3h2z"/></svg>
            </button>
          </div>
        </div>
      </footer>

      <div class="pulse" id="pulse" aria-hidden="true"></div>
      <div class="toast" id="toast" role="status" aria-live="polite"></div>

      <aside class="drawer" id="episodeDrawer" hidden>
        <div class="drawer__head">
          <div>
            <div class="drawer__eyebrow">Episodes</div>
            <div class="drawer__title" id="drawerTitle">${escapeHtml(title)}</div>
          </div>
          <button class="icon-btn icon-btn--glass" id="drawerClose" type="button" aria-label="Close">
            <svg viewBox="0 0 24 24"><path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z"/></svg>
          </button>
        </div>
        <div class="drawer__seasons" id="seasonTabs"></div>
        <div class="drawer__list" id="episodeList"></div>
      </aside>
      <div class="scrim" id="scrim" hidden></div>
    </div>
  </div>

  <script id="priva-config" type="application/json">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>
  <script src="/vendor/hls.min.js"></script>
  <script src="/assets/player.js"></script>
</body>
</html>`;
}
