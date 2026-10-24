/* ==========================================================================
   Priva Embed — player
   ========================================================================== */
(() => {
  "use strict";

  const config = JSON.parse(document.getElementById("priva-config").textContent || "{}");
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const video = $("video");

  const ICONS = {
    play: '<path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.7-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14z"/>',
    pause: '<path d="M7 5h4v14H7zm6 0h4v14h-4z"/>',
    volume: '<path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/>',
    mute: '<path d="M4 9v6h4l5 4V5L8 9H4zm13.6 1.1-1.4-1.4L14 11l-2.2-2.3-1.4 1.4L12.6 12l-2.2 2.2 1.4 1.4L14 13.4l2.2 2.2 1.4-1.4L15.4 12z"/>',
    fullscreen: '<path d="M4 9V4h5v2H6v3H4zm16 0V4h-5v2h3v3h2zm-16 6v5h5v-2H6v-3H4zm16 0v5h-5v-2h3v-3h2z"/>',
    exitFullscreen: '<path d="M9 4v5H4v-2h3V4zm6 0h2v3h3v2h-5V4zM4 15h5v5H7v-3H4zm11 0h5v2h-3v3h-2z"/>',
    check: '<path d="m9.5 16.2-4-4L7 10.8l2.5 2.5 7-7L18 7.7z"/>',
  };

  const state = {
    providers: [],
    provider: null,
    streams: [],
    streamIndex: 0,
    hls: null,
    subtitles: [],
    activeSubtitle: -1,
    skip: [],
    skipHidden: new Set(),
    started: false,
    duration: 0,
    lastVolume: 1,
    seasons: Array.isArray(config.seasons) ? config.seasons : [],
    currentSeason: Number(config.season) || 1,
    seasonCache: new Map(),
    nextTimer: null,
    hideTimer: null,
    dragging: false,
    controlsOpen: true,
  };

  const isTv = config.type === "tv";
  const messages = {
    loadingTitle: "Finding sources",
    loadingHint: "This usually takes a few seconds",
  };

  /* ------------------------------- helpers -------------------------------- */

  const fmt = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const esc = (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const setState = (next) => {
    body.dataset.state = next;
    // `loading` used to be a permanent class on <body>; make sure no stale
    // class-based rule can keep the chrome hidden once we leave that state.
    if (next !== "loading") body.classList.remove("loading");
    else body.classList.add("loading");
  };

  let toastTimer;
  const toast = (message) => {
    const node = $("toast");
    node.textContent = message;
    body.classList.add("toast-open");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => body.classList.remove("toast-open"), 2400);
  };

  const pulse = (label) => {
    const node = $("pulse");
    node.textContent = label;
    node.classList.remove("show");
    void node.offsetWidth;
    node.classList.add("show");
  };

  const post = (event, payload) => {
    try {
      window.parent?.postMessage({ source: "priva-embed", event, payload }, "*");
    } catch {
      /* ignore */
    }
  };

  const episodeUrl = (season, episode) => {
    const url = new URL(window.location.href);
    url.pathname = `/player/${config.tmdbId}/${season}/${episode}`;
    return url.toString();
  };

  /* ------------------------------- progress -------------------------------- */

  const progressKey = () =>
    `priva:pos:${config.type}:${config.tmdbId}:${config.season || 0}:${config.episode || 0}`;

  const saveProgress = () => {
    if (!state.duration) return;
    try {
      localStorage.setItem(
        progressKey(),
        JSON.stringify({ t: video.currentTime, d: state.duration, at: Date.now() }),
      );
    } catch {
      /* storage may be disabled */
    }
  };

  const readProgress = () => {
    try {
      const raw = localStorage.getItem(progressKey());
      if (!raw) return 0;
      const data = JSON.parse(raw);
      if (!data || !data.t || !data.d) return 0;
      if (data.t > data.d - 45) return 0;
      if (Date.now() - (data.at || 0) > 1000 * 60 * 60 * 24 * 30) return 0;
      return data.t;
    } catch {
      return 0;
    }
  };

  /* --------------------------------- hls ----------------------------------- */

  let hlsLoading = null;
  const ensureHls = () => {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (hlsLoading) return hlsLoading;
    hlsLoading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js";
      script.onload = () => resolve(window.Hls);
      script.onerror = () => reject(new Error("hls.js unavailable"));
      document.head.appendChild(script);
    });
    return hlsLoading;
  };

  function destroyPlayback() {
    if (state.hls) {
      try {
        state.hls.destroy();
      } catch {
        /* noop */
      }
      state.hls = null;
    }
    video.removeAttribute("src");
    video.load();
  }

  async function attach(stream, { autoplay = false, start = 0 } = {}) {
    destroyPlayback();
    setState("paused");
    updatePlayIcon();
    openControls();

    const source = stream.url;
    const wantsHls = stream.type === "hls";

    if (wantsHls) {
      try {
        const Hls = await ensureHls();
        if (Hls && Hls.isSupported()) {
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            maxBufferLength: 40,
            backBufferLength: 30,
            manifestLoadingTimeOut: 20000,
            manifestLoadingMaxRetry: 3,
            fragLoadingTimeOut: 30000,
          });
          state.hls = hls;
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (!data?.fatal) return;
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              try {
                hls.startLoad();
                return;
              } catch {
                /* fall through */
              }
            }
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              try {
                hls.recoverMediaError();
                return;
              } catch {
                /* fall through */
              }
            }
            handlePlaybackFailure();
          });
          hls.loadSource(source);
          hls.attachMedia(video);
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = source;
        } else {
          handlePlaybackFailure();
          return;
        }
      } catch {
        handlePlaybackFailure();
        return;
      }
    } else {
      video.src = source;
    }

    if (start > 0) {
      const seek = () => {
        try {
          video.currentTime = start;
        } catch {
          /* noop */
        }
        video.removeEventListener("loadedmetadata", seek);
      };
      video.addEventListener("loadedmetadata", seek);
    }

    if (autoplay) {
      video.play().catch(() => {
        setState("paused");
        updatePlayIcon();
      });
    } else {
      setState("paused");
    }
    updatePlayIcon();
  }

  /* -------------------------------- sources -------------------------------- */

  const PROVIDER_NAMES = { clarke: "Clarke", bellamy: "Bellamy", raven: "Raven" };
  const PROVIDER_ORDER = ["clarke", "bellamy", "raven"];
  let sourceRequest = null;
  let selectionMade = false;

  function mergeProvider(provider) {
    if (!provider?.id) return;
    const index = state.providers.findIndex((entry) => entry.id === provider.id);
    if (index >= 0) state.providers[index] = provider;
    else state.providers.push(provider);
  }

  function considerProvider(provider, providerId) {
    if (!provider?.streams?.length) return;
    const explicit =
      config.provider && config.provider !== "auto" ? config.provider : null;
    if (explicit && explicit !== providerId) return;
    if (!selectionMade) {
      selectProvider(provider.id, { autoplay: config.autoplay, silent: true });
      selectionMade = true;
      return;
    }
    if (explicit === providerId && state.provider?.id !== providerId) {
      selectProvider(providerId, { autoplay: config.autoplay, silent: true });
    }
  }

  async function loadSources({ refresh = false, provider = "auto" } = {}) {
    if (sourceRequest) sourceRequest.abort();
    const controller = new AbortController();
    sourceRequest = controller;
    selectionMade = false;

    setState("loading");
    $("splash").hidden = false;
    $("splashActions").hidden = true;
    $("statusTitle").textContent = messages.loadingTitle;
    $("statusHint").textContent = messages.loadingHint;

    const targets =
      provider && provider !== "auto" && PROVIDER_NAMES[provider] ? [provider] : PROVIDER_ORDER;

    triedStreams.clear();
    state.providers = targets.map((id) => ({
      id,
      name: PROVIDER_NAMES[id],
      status: "loading",
      streams: [],
      ms: 0,
    }));
    state.provider = null;
    state.streams = [];
    renderProviderMenu();

    const requestProvider = async (providerId) => {
      const params = new URLSearchParams({
        type: config.type,
        tmdb: String(config.tmdbId),
        season: String(config.season || 1),
        episode: String(config.episode || 1),
        provider: providerId,
        title: config.title || "",
        year: config.year || "",
        imdb: config.imdbId || "",
      });
      if (config.demo) params.set("demo", "1");
      if (refresh) params.set("refresh", "1");

      try {
        const response = await fetch(`/api/sources?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`sources ${response.status}`);
        const payload = await response.json();
        const list = Array.isArray(payload.providers) ? payload.providers : [];
        let own = null;
        for (const entry of list) {
          mergeProvider(entry);
          if (entry.id === providerId) own = entry;
        }
        if (!own) {
          mergeProvider({
            id: providerId,
            name: PROVIDER_NAMES[providerId],
            status: "error",
            ms: 0,
            streams: [],
          });
        }
        if (Array.isArray(payload.skip) && payload.skip.length) state.skip = payload.skip;
        renderProviderMenu();
        considerProvider(own, providerId);
        return own;
      } catch (error) {
        if (error?.name === "AbortError") return null;
        mergeProvider({
          id: providerId,
          name: PROVIDER_NAMES[providerId],
          status: "error",
          ms: 0,
          streams: [],
        });
        renderProviderMenu();
        return null;
      }
    };

    await Promise.all(targets.map(requestProvider));
    if (controller.signal.aborted) return;

    const total = state.providers.reduce((sum, entry) => sum + entry.streams.length, 0);
    if (!total) {
      showError(
        "No sources available",
        "Every source is empty for this title right now. Try again in a moment.",
      );
      post("error", { message: "no_sources" });
      return;
    }

    post("sources", {
      provider: state.provider?.id,
      count: state.providers.reduce((sum, entry) => sum + entry.streams.length, 0),
    });
  }

  function showError(title, hint) {
    setState("error");
    $("splash").hidden = false;
    $("statusTitle").textContent = title;
    $("statusHint").textContent = hint;
    $("splashActions").hidden = false;
  }

  function renderProviderMenu() {
    const list = $("providerList");
    list.innerHTML = "";
    const total = state.providers.reduce((sum, provider) => sum + provider.streams.length, 0);
    $("providerCount").textContent = total ? `${total} links` : "";

    for (const provider of state.providers) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "menu-item";
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-selected", String(state.provider?.id === provider.id));

      const dotClass =
        provider.streams.length > 0
          ? "menu-item__dot"
          : provider.status === "error"
          ? "menu-item__dot menu-item__dot--error"
          : "menu-item__dot menu-item__dot--idle";

      const statusText =
        provider.streams.length > 0
          ? `${provider.streams.length} link${provider.streams.length > 1 ? "s" : ""} · ${(
              provider.ms / 1000
            ).toFixed(1)}s`
          : provider.status === "error"
          ? "unavailable"
          : "no links";

      button.innerHTML = `
        <span class="${dotClass}"></span>
        <span class="menu-item__body">
          <span class="menu-item__title">${esc(provider.name)}</span>
          <span class="menu-item__sub">${statusText}</span>
        </span>
        ${state.provider?.id === provider.id ? `<svg class="menu-item__check" viewBox="0 0 24 24">${ICONS.check}</svg>` : ""}
      `;
      button.addEventListener("click", () => {
        closeMenus();
        if (!provider.streams.length) {
          toast(`${provider.name} has no links right now`);
          return;
        }
        selectProvider(provider.id, { autoplay: true });
      });
      list.appendChild(button);
    }
  }

  function selectProvider(providerId, { autoplay = false, silent = false } = {}) {
    const provider = state.providers.find((entry) => entry.id === providerId);
    if (!provider) return;
    state.provider = provider;
    state.streams = provider.streams.filter((stream) => stream.type !== "dash");
    failureCount = 0;
    state.streamIndex = 0;

    $("providerBtnLabel").textContent = provider.name;
    $("topbarProvider").textContent = provider.name;
    renderProviderMenu();
    renderQualityMenu();
    renderSubtitleMenu();

    if (!state.streams.length) {
      const fallback = state.providers.find(
        (entry) => entry.streams.length && entry.id !== provider.id,
      );
      if (fallback) {
        if (!silent) toast(`${provider.name} is empty — switching to ${fallback.name}`);
        selectProvider(fallback.id, { autoplay, silent: true });
      } else {
        showError("No playable links", "This source returned no playable stream.");
      }
      return;
    }

    post("provider", { provider: provider.id });
    selectStream(0, { autoplay, silent });
  }

  function renderQualityMenu() {
    const list = $("qualityList");
    list.innerHTML = "";
    const playable = state.streams;
    $("qualityCount").textContent = playable.length ? `${playable.length}` : "";

    if (!playable.length) {
      list.innerHTML = '<div class="menu-empty">No links from this source</div>';
      return;
    }

    playable.forEach((stream, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "menu-item";
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-selected", String(index === state.streamIndex));
      button.innerHTML = `
        <span class="menu-item__body">
          <span class="menu-item__title">${esc(stream.label || stream.quality + "p" || "Auto")}</span>
          <span class="menu-item__sub">${stream.type.toUpperCase()}${stream.quality ? ` · ${stream.quality}p` : ""}${
            stream.subtitles?.length ? ` · ${stream.subtitles.length} subtitle${stream.subtitles.length > 1 ? "s" : ""}` : ""
          }</span>
        </span>
        <span class="menu-item__badge${index === 0 ? " menu-item__badge--live" : ""}">${index === 0 ? "AUTO" : "HD"}</span>
      `;
      button.addEventListener("click", () => {
        closeMenus();
        selectStream(index, { autoplay: true });
      });
      list.appendChild(button);
    });
  }

  function selectStream(index, { autoplay = false, silent = false } = {}) {
    const stream = state.streams[index];
    if (!stream) return;
    state.streamIndex = index;
    triedStreams.add(streamKey(state.provider?.id, stream));
    state.subtitles = stream.subtitles || [];
    state.activeSubtitle = -1;
    state.skipHidden = new Set();

    $("qualityBtnLabel").textContent = stream.quality ? `${stream.quality}p` : "Auto";
    renderQualityMenu();
    renderSubtitleMenu();

    const resume = readProgress();
    const start = resume > 0 ? resume : Number(config.start) || 0;
    if (resume > 0 && !silent) toast(`Resuming from ${fmt(resume)}`);

    if (config.muted) {
      video.muted = true;
      updateVolumeIcon();
    }

    attach(stream, { autoplay, start });
    state.started = true;

    const subIndex = pickSubtitleIndex(state.subtitles);
    if (subIndex >= 0) setTimeout(() => setSubtitle(subIndex), 500);
  }

  function pickSubtitleIndex(subtitles) {
    if (!subtitles?.length) return -1;
    const preferred = (config.lang || "").slice(0, 2).toLowerCase();
    if (preferred) {
      const index = subtitles.findIndex((sub) => (sub.language || "").startsWith(preferred));
      if (index >= 0) return index;
    }
    return subtitles.findIndex((sub) => /^en/i.test(sub.language || ""));
  }

  /* ------------------------------- subtitles -------------------------------- */

  function renderSubtitleMenu() {
    const list = $("subtitleList");
    if (!list) return;
    list.innerHTML = "";
    $("subtitleCount").textContent = state.subtitles.length ? `${state.subtitles.length}` : "";

    const items = [{ title: "Off", language: "off", url: "" }, ...state.subtitles];
    items.forEach((subtitle, index) => {
      const active = index === 0 ? state.activeSubtitle === -1 : state.activeSubtitle === index - 1;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "menu-item";
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-selected", String(active));
      button.innerHTML = `
        <span class="menu-item__body">
          <span class="menu-item__title">${esc(subtitle.title || subtitle.language)}</span>
          <span class="menu-item__sub">${index === 0 ? "Captions disabled" : (subtitle.language || "").toUpperCase()}</span>
        </span>
        ${active ? `<svg class="menu-item__check" viewBox="0 0 24 24">${ICONS.check}</svg>` : ""}
      `;
      button.addEventListener("click", () => {
        closeMenus();
        setSubtitle(index - 1);
      });
      list.appendChild(button);
    });

    if (!state.subtitles.length) {
      list.innerHTML += '<div class="menu-empty">No subtitles found for this link</div>';
    }
  }

  function setSubtitle(index) {
    state.activeSubtitle = index;
    [...video.querySelectorAll("track")].forEach((track) => track.remove());

    if (index >= 0 && state.subtitles[index]) {
      const track = document.createElement("track");
      track.kind = "subtitles";
      track.label = state.subtitles[index].title || state.subtitles[index].language;
      track.srclang = (state.subtitles[index].language || "en").slice(0, 2);
      track.src = state.subtitles[index].url;
      track.default = true;
      video.appendChild(track);
      setTimeout(() => {
        for (const textTrack of video.textTracks) textTrack.mode = "showing";
      }, 120);
      toast(`Subtitles: ${track.label}`);
    } else {
      for (const textTrack of video.textTracks) textTrack.mode = "hidden";
      if (index === -1) toast("Subtitles off");
    }
    renderSubtitleMenu();
  }

  /* -------------------------------- episodes -------------------------------- */

  function seasonInfo(season) {
    return state.seasons.find((entry) => Number(entry.season) === Number(season));
  }

  function episodeCount(season) {
    return Number(seasonInfo(season)?.episodes) || 0;
  }

  async function loadSeason(season) {
    if (state.seasonCache.has(season)) return state.seasonCache.get(season);
    const suffix = config.demo ? "?demo=1" : "";
    const promise = fetch(`/api/season/${config.tmdbId}/${season}${suffix}`)
      .then((response) => (response.ok ? response.json() : { episodes: [] }))
      .catch(() => ({ episodes: [] }));
    state.seasonCache.set(season, promise);
    return promise;
  }

  async function openDrawer() {
    if (!isTv) return;
    $("episodeDrawer").hidden = false;
    $("scrim").hidden = false;
    state.controlsOpen = true;
    updateControls();
    renderSeasonTabs();
    await renderEpisodeList(state.currentSeason);
  }

  function closeDrawer() {
    $("episodeDrawer").hidden = true;
    $("scrim").hidden = true;
  }

  function renderSeasonTabs() {
    const tabs = $("seasonTabs");
    tabs.innerHTML = "";
    const seasons = state.seasons.length
      ? state.seasons.map((entry) => Number(entry.season))
      : [Number(config.season) || 1];

    for (const season of seasons) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "season-tab";
      button.textContent = season === 0 ? "Specials" : `Season ${season}`;
      button.setAttribute("aria-selected", String(Number(state.currentSeason) === Number(season)));
      button.addEventListener("click", async () => {
        state.currentSeason = season;
        renderSeasonTabs();
        await renderEpisodeList(season);
      });
      tabs.appendChild(button);
    }
  }

  async function renderEpisodeList(season) {
    const list = $("episodeList");
    list.innerHTML = '<div class="menu-empty">Loading episodes…</div>';
    const data = await loadSeason(season);
    const episodes = Array.isArray(data.episodes) ? data.episodes : [];
    const total = episodes.length || episodeCount(season);

    list.innerHTML = "";
    if (!total) {
      list.innerHTML = '<div class="menu-empty">No episode data for this season</div>';
      return;
    }

    const render = (episodeNumber) => {
      const info = episodes.find((entry) => Number(entry.episode) === Number(episodeNumber)) || {};
      const button = document.createElement("button");
      button.type = "button";
      button.className = "episode";
      button.setAttribute(
        "aria-current",
        String(Number(season) === Number(config.season) && episodeNumber === Number(config.episode)),
      );
      const current = Number(season) === Number(config.season) && episodeNumber === Number(config.episode);
      button.innerHTML = `
        <span class="episode__thumb">
          ${info.still ? `<img src="${esc(info.still)}" alt="" loading="lazy" />` : ""}
          <span class="episode__num">E${episodeNumber}</span>
        </span>
        <span class="episode__body">
          <span class="episode__title">${esc(info.name || `Episode ${episodeNumber}`)}</span>
          <span class="episode__sub">${current ? '<span class="episode__now">NOW PLAYING</span>' : (info.airDate || (info.runtime ? `${info.runtime} min` : ""))}</span>
        </span>
      `;
      button.addEventListener("click", () => {
        if (current) {
          closeDrawer();
          return;
        }
        window.location.href = episodeUrl(season, episodeNumber);
      });
      list.appendChild(button);
    };

    if (episodes.length) {
      episodes.forEach((entry) => render(Number(entry.episode)));
    } else {
      for (let i = 1; i <= total; i += 1) render(i);
    }
  }

  function goToEpisode(season, episode) {
    if (!episode || episode < 1) return;
    window.location.href = episodeUrl(season, episode);
  }

  function nextEpisodeTarget() {
    if (!isTv) return null;
    const season = Number(config.season) || 1;
    const episode = Number(config.episode) || 1;
    const count = episodeCount(season);
    if (count && episode < count) return { season, episode: episode + 1 };
    const seasons = state.seasons.map((entry) => Number(entry.season)).sort((a, b) => a - b);
    const nextSeason = seasons.find((entry) => entry > season);
    if (nextSeason) return { season: nextSeason, episode: 1 };
    return null;
  }

  function updateEpisodeChrome() {
    if (!isTv) return;
    const season = Number(config.season) || 1;
    const episode = Number(config.episode) || 1;
    $("episodePillLabel").textContent = `S${season} E${episode}`;
    const count = episodeCount(season);
    $("prevEp").disabled = season === 1 && episode === 1;
    $("nextEp").disabled = count ? episode >= count : false;
    $("nextEp").onclick = () => {
      const target = nextEpisodeTarget();
      if (target) goToEpisode(target.season, target.episode);
    };
    $("prevEp").onclick = () => {
      if (episode > 1) goToEpisode(season, episode - 1);
      else {
        const seasons = state.seasons.map((entry) => Number(entry.season)).sort((a, b) => b - a);
        const previous = seasons.find((entry) => entry < season);
        if (previous) goToEpisode(previous, episodeCount(previous) || 1);
      }
    };
  }

  /* ---------------------------------- skip --------------------------------- */

  function updateSkipButton() {
    const node = $("skipIntro");
    if (!state.skip.length || !video.duration) {
      node.hidden = true;
      return;
    }
    const now = video.currentTime;
    const active = state.skip.find(
      (interval) =>
        !state.skipHidden.has(interval.title) &&
        now >= interval.from - 1 &&
        now < interval.to - 2,
    );
    if (!active) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    $("skipIntroLabel").textContent = `Skip ${intervalLabel(active.title)}`;
    $("skipIntroBtn").onclick = () => {
      video.currentTime = Math.min(active.to + 0.2, video.duration - 0.5);
      state.skipHidden.add(active.title);
      node.hidden = true;
      pulse(`Skipped ${intervalLabel(active.title).toLowerCase()}`);
    };
  }

  const intervalLabel = (title) => {
    const normalized = String(title || "").toLowerCase();
    if (normalized.includes("recap")) return "recap";
    if (normalized.includes("credit")) return "credits";
    return "intro";
  };

  /* ---------------------------------- next --------------------------------- */

  function maybeShowNext() {
    if (!isTv || !config.autoNext) return;
    const target = nextEpisodeTarget();
    if (!target) return;
    const remaining = video.duration - video.currentTime;
    if (!video.duration || remaining > 40 || remaining < 0) return;

    const seasonData = state.seasonCache.get(target.season);
    const label = `S${target.season} E${target.episode}`;
    $("nextTitle").textContent = label;
    $("nextCard").hidden = false;
    $("nextNow").onclick = () => goToEpisode(target.season, target.episode);
    $("nextCancel").onclick = () => {
      $("nextCard").hidden = true;
      clearInterval(state.nextTimer);
      state.nextTimer = null;
    };

    clearInterval(state.nextTimer);
    let countdown = 8;
    state.nextTimer = setInterval(() => {
      countdown -= 1;
      if (countdown <= 0) {
        clearInterval(state.nextTimer);
        goToEpisode(target.season, target.episode);
      }
    }, 1000);
    void seasonData;
  }

  /* -------------------------------- controls ------------------------------- */

  function updateControls() {
    const playbackState = body.dataset.state;
    const interactive = playbackState !== "loading" && playbackState !== "error";
    if (!interactive) {
      body.classList.add("controls-open");
      body.classList.remove("controls-hidden");
      return;
    }
    // While paused the chrome stays pinned; it only auto-hides during playback.
    if (playbackState !== "playing") state.controlsOpen = true;
    if (state.controlsOpen) body.classList.add("controls-open");
    else body.classList.remove("controls-open");
    body.classList.toggle("controls-hidden", !state.controlsOpen && playbackState === "playing");
  }

  function openControls() {
    state.controlsOpen = true;
    updateControls();
    clearTimeout(state.hideTimer);
    if (body.dataset.state === "playing") {
      state.hideTimer = setTimeout(() => {
        if (body.dataset.state === "playing" && !state.dragging) {
          state.controlsOpen = false;
          updateControls();
        }
      }, 3200);
    }
  }

  const isMenuOpen = () =>
    ["providerMenu", "qualityMenu", "settingsMenu"].some((id) => !$(id).hidden);

  function closeMenus() {
    for (const id of ["providerMenu", "qualityMenu", "settingsMenu"]) {
      $(id).hidden = true;
    }
    for (const id of ["providerBtn", "qualityBtn", "settingsBtn"]) {
      $(id).setAttribute("aria-expanded", "false");
    }
  }

  function toggleMenu(menuId, buttonId) {
    const menu = $(menuId);
    const willOpen = menu.hidden;
    closeMenus();
    menu.hidden = !willOpen;
    $(buttonId).setAttribute("aria-expanded", String(willOpen));
    if (willOpen) openControls();
  }

  function togglePlay() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  function skip(seconds) {
    if (!video.duration) return;
    video.currentTime = clamp(video.currentTime + seconds, 0, video.duration - 0.25);
    pulse(seconds > 0 ? `+${seconds}s` : `${seconds}s`);
  }

  function updateVolumeIcon() {
    const icon = $("volumeIcon");
    const muted = video.muted || video.volume === 0;
    icon.innerHTML = muted ? ICONS.mute : ICONS.volume;
    $("muteBtn").setAttribute("aria-label", muted ? "Unmute" : "Mute");
    $("volumeSlider").value = muted ? 0 : video.volume;
  }

  function updatePlayIcon() {
    $("playIcon").innerHTML = video.paused ? ICONS.play : ICONS.pause;
    $("playBtn").setAttribute("aria-label", video.paused ? "Play" : "Pause");
    $("bigPlay").hidden = !video.paused;
  }

  function updateProgress() {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    state.duration = duration;
    const played = duration ? video.currentTime / duration : 0;
    $("scrubPlayed").style.width = `${clamp(played * 100, 0, 100)}%`;
    $("scrubHandle").style.left = `${clamp(played * 100, 0, 100)}%`;
    $("timeNow").textContent = fmt(video.currentTime);
    $("timeTotal").textContent = fmt(duration);
    $("scrubber").setAttribute("aria-valuenow", String(Math.round(video.currentTime)));
    $("scrubber").setAttribute("aria-valuemax", String(Math.round(duration)));

    try {
      const buffered = video.buffered;
      if (buffered.length && duration) {
        const end = buffered.end(buffered.length - 1);
        $("scrubBuffer").style.width = `${clamp((end / duration) * 100, 0, 100)}%`;
      }
    } catch {
      /* noop */
    }
  }

  /* --------------------------------- events -------------------------------- */

  video.addEventListener("loadedmetadata", () => {
    updateProgress();
    if (state.duration && video.currentTime === 0) {
      const resume = readProgress();
      if (resume > 0) video.currentTime = resume;
    }
  });

  video.addEventListener("play", () => {
    setState("playing");
    updatePlayIcon();
    openControls();
    post("play", { currentTime: video.currentTime, duration: video.duration || 0 });
  });

  video.addEventListener("pause", () => {
    if (body.dataset.state === "ended") return;
    setState("paused");
    updatePlayIcon();
    state.controlsOpen = true;
    updateControls();
    saveProgress();
    post("pause", { currentTime: video.currentTime, duration: video.duration || 0 });
  });

  video.addEventListener("waiting", () => body.classList.add("is-buffering"));
  video.addEventListener("playing", () => {
    body.classList.remove("is-buffering");
    failureCount = 0;
  });
  video.addEventListener("canplay", () => body.classList.remove("is-buffering"));

  video.addEventListener("timeupdate", () => {
    updateProgress();
    updateSkipButton();
    if (Math.floor(video.currentTime) % 5 === 0) saveProgress();
  });

  video.addEventListener("durationchange", updateProgress);
  video.addEventListener("progress", updateProgress);

  video.addEventListener("ended", () => {
    setState("ended");
    updatePlayIcon();
    state.controlsOpen = true;
    updateControls();
    $("nextCard").hidden = true;
    maybeShowNext();
    post("ended", { currentTime: video.currentTime, duration: video.duration || 0 });
  });

  video.addEventListener("error", () => {
    if (body.dataset.state === "loading") return;
    handlePlaybackFailure();
  });

  let failureCount = 0;
  const triedStreams = new Set();
  const streamKey = (provider, stream) => `${provider}:${stream?.id ?? stream?.url ?? "?"}`;
  function handlePlaybackFailure() {
    failureCount += 1;
    if (failureCount > 8) {
      showError("Playback failed", "All links refused to play. Try reloading the embed.");
      post("error", { message: "playback_failed" });
      return;
    }

    const nextIndex = state.streams.findIndex(
      (stream, index) =>
        index !== state.streamIndex &&
        !triedStreams.has(streamKey(state.provider?.id, stream)),
    );
    if (nextIndex >= 0) {
      toast("This link failed — trying another");
      selectStream(nextIndex, { autoplay: true, silent: true });
      return;
    }

    const nextProvider = state.providers.find(
      (provider) =>
        provider.id !== state.provider?.id &&
        provider.streams.some(
          (stream) => stream.type !== "dash" && !triedStreams.has(streamKey(provider.id, stream)),
        ),
    );
    if (nextProvider) {
      toast(`Switching to ${nextProvider.name}`);
      selectProvider(nextProvider.id, { autoplay: true, silent: true });
      return;
    }

    showError("Playback failed", "All links refused to play. Try reloading the embed.");
    post("error", { message: "playback_failed" });
  }

  /* ---------------------------------- ui ----------------------------------- */

  function bind() {
    $("playBtn").addEventListener("click", togglePlay);
    $("bigPlay").addEventListener("click", togglePlay);
    video.addEventListener("click", togglePlay);
    video.addEventListener("dblclick", () => toggleFullscreen());

    $("back10").addEventListener("click", () => skip(-10));
    $("fwd10").addEventListener("click", () => skip(10));

    $("muteBtn").addEventListener("click", () => {
      video.muted = !video.muted;
      if (!video.muted && video.volume === 0) video.volume = 0.6;
      updateVolumeIcon();
    });

    $("volumeSlider").addEventListener("input", (event) => {
      const value = Number(event.target.value);
      video.volume = value;
      video.muted = value === 0;
      updateVolumeIcon();
    });

    $("providerBtn").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMenu("providerMenu", "providerBtn");
    });
    $("qualityBtn").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMenu("qualityMenu", "qualityBtn");
    });
    $("settingsBtn").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMenu("settingsMenu", "settingsBtn");
      renderSpeedMenu();
      renderSubtitleMenu();
    });
    $("subtitlesBtn").addEventListener("click", (event) => {
      event.stopPropagation();
      $("settingsMenu").hidden = false;
      $("settingsBtn").setAttribute("aria-expanded", "true");
      renderSpeedMenu();
      renderSubtitleMenu();
      openControls();
    });

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".menu-anchor") && !event.target.closest(".menu")) closeMenus();
    });

    $("episodesBtn")?.addEventListener("click", () => {
      if ($("episodeDrawer").hidden) openDrawer();
      else closeDrawer();
    });
    $("drawerClose").addEventListener("click", closeDrawer);
    $("scrim").addEventListener("click", () => {
      closeDrawer();
      closeMenus();
    });

    $("fullscreenBtn").addEventListener("click", toggleFullscreen);
    $("pipBtn").addEventListener("click", async () => {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await video.requestPictureInPicture();
      } catch {
        toast("Picture in picture is not available");
      }
    });

    $("retryBtn").addEventListener("click", () => {
      failureCount = 0;
      loadSources({ refresh: true });
    });
    $("splashCloseBtn").addEventListener("click", () => {
      post("close", {});
      if (window.parent === window) window.history.back();
    });

    $("backBtn").addEventListener("click", () => {
      post("close", {});
      if (window.parent === window) {
        if (document.referrer) window.history.back();
      }
    });

    // scrubber
    const scrubber = $("scrubber");
    const scrubTooltip = $("scrubTooltip");

    const seekToEvent = (event) => {
      const rect = scrubber.getBoundingClientRect();
      const clientX = "touches" in event ? event.touches[0].clientX : event.clientX;
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      return ratio;
    };

    const preview = (ratio) => {
      if (!state.duration) return;
      const time = ratio * state.duration;
      scrubTooltip.hidden = false;
      scrubTooltip.textContent = fmt(time);
      scrubTooltip.style.left = `${clamp(ratio * 100, 4, 96)}%`;
      $("scrubHover").style.width = `${ratio * 100}%`;
    };

    scrubber.addEventListener("pointerdown", (event) => {
      if (!state.duration) return;
      state.dragging = true;
      scrubber.classList.add("is-dragging");
      scrubber.setPointerCapture?.(event.pointerId);
      const ratio = seekToEvent(event);
      preview(ratio);
      video.currentTime = ratio * state.duration;
    });

    scrubber.addEventListener("pointermove", (event) => {
      if (!state.duration) return;
      const ratio = seekToEvent(event);
      preview(ratio);
      if (state.dragging) video.currentTime = ratio * state.duration;
    });

    const endDrag = () => {
      if (!state.dragging) return;
      state.dragging = false;
      scrubber.classList.remove("is-dragging");
      scrubTooltip.hidden = true;
      $("scrubHover").style.width = "0";
      saveProgress();
    };

    scrubber.addEventListener("pointerup", endDrag);
    scrubber.addEventListener("pointercancel", endDrag);
    scrubber.addEventListener("pointerleave", () => {
      if (!state.dragging) {
        scrubTooltip.hidden = true;
        $("scrubHover").style.width = "0";
      }
    });

    document.addEventListener("mousemove", () => openControls());
    document.addEventListener("touchstart", () => openControls(), { passive: true });

    document.addEventListener("keydown", (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement) return;
      switch (event.key.toLowerCase()) {
        case " ":
        case "k":
          event.preventDefault();
          togglePlay();
          break;
        case "arrowright":
          if (event.shiftKey) skip(60);
          else skip(10);
          break;
        case "arrowleft":
          if (event.shiftKey) skip(-60);
          else skip(-10);
          break;
        case "arrowup":
          event.preventDefault();
          video.volume = clamp(video.volume + 0.1, 0, 1);
          updateVolumeIcon();
          pulse(`Volume ${Math.round(video.volume * 100)}%`);
          break;
        case "arrowdown":
          event.preventDefault();
          video.volume = clamp(video.volume - 0.1, 0, 1);
          updateVolumeIcon();
          pulse(`Volume ${Math.round(video.volume * 100)}%`);
          break;
        case "m":
          video.muted = !video.muted;
          updateVolumeIcon();
          break;
        case "f":
          toggleFullscreen();
          break;
        case "c":
          setSubtitle(state.activeSubtitle >= 0 ? -1 : pickSubtitleIndex(state.subtitles));
          break;
        case "escape":
          closeMenus();
          closeDrawer();
          if (document.fullscreenElement) document.exitFullscreen();
          break;
        case "n":
          if (isTv) {
            const target = nextEpisodeTarget();
            if (target) goToEpisode(target.season, target.episode);
          }
          break;
        default:
          break;
      }
    });

    window.addEventListener("resize", () => updateControls());
    window.addEventListener("beforeunload", saveProgress);

    document.addEventListener("fullscreenchange", () => {
      $("fullscreenIcon").innerHTML = document.fullscreenElement
        ? ICONS.exitFullscreen
        : ICONS.fullscreen;
    });

    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || data.source !== "priva-parent") return;
      switch (String(data.command || "")) {
        case "play":
          video.play().catch(() => {});
          break;
        case "pause":
          video.pause();
          break;
        case "toggle":
          togglePlay();
          break;
        case "seek":
          if (Number.isFinite(Number(data.value)) && state.duration) {
            video.currentTime = clamp(Number(data.value), 0, state.duration - 0.25);
          }
          break;
        case "mute":
          video.muted = true;
          updateVolumeIcon();
          break;
        case "unmute":
          video.muted = false;
          updateVolumeIcon();
          break;
        case "setProvider": {
          const provider = state.providers.find((entry) => entry.id === data.value);
          if (provider?.streams.length) selectProvider(provider.id, { autoplay: true });
          break;
        }
        case "setVolume":
          video.volume = clamp(Number(data.value) || 0, 0, 1);
          updateVolumeIcon();
          break;
        default:
          break;
      }
    });
  }

  function renderSpeedMenu() {
    const list = $("speedList");
    list.innerHTML = "";
    for (const speed of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "menu-item";
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-selected", String(Math.abs(video.playbackRate - speed) < 0.01));
      button.innerHTML = `
        <span class="menu-item__body">
          <span class="menu-item__title">${speed === 1 ? "Normal" : `${speed}×`}</span>
          <span class="menu-item__sub">Playback speed</span>
        </span>
        ${Math.abs(video.playbackRate - speed) < 0.01 ? `<svg class="menu-item__check" viewBox="0 0 24 24">${ICONS.check}</svg>` : ""}
      `;
      button.addEventListener("click", () => {
        video.playbackRate = speed;
        renderSpeedMenu();
        toast(`Speed ${speed}×`);
      });
      list.appendChild(button);
    }
  }

  function toggleFullscreen() {
    const root = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
  }

  /* ---------------------------------- boot --------------------------------- */

  function boot() {
    bind();
    updatePlayIcon();
    updateVolumeIcon();
    updateEpisodeChrome();
    renderSpeedMenu();
    renderSubtitleMenu();
    setState("loading");
    body.classList.add("controls-open");
    post("ready", { tmdbId: config.tmdbId, type: config.type, title: config.title });

    if (config.theme) {
      document.documentElement.style.setProperty("--primary", config.theme);
    }

    loadSources({ provider: config.provider || "auto" });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
