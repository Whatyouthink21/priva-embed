/* Priva Embed player UI — CinemaOS style */
(function () {
  const tmdbId = document.body.dataset.tmdbId || "";
  const season = document.body.dataset.season || "";
  const episode = document.body.dataset.episode || "";
  const isSeries = Boolean(season && episode);
  const API = (document.body.dataset.apiBase || "").replace(/\/$/, "");

  const root = document.getElementById("root");
  const posterWrap = document.getElementById("poster-wrap") || createPosterWrap();

  let hls = null;
  let currentStream = null;

  // ---------- DOM ----------

  function createPosterWrap() {
    const el = document.createElement("div");
    el.id = "poster-wrap";
    document.body.insertBefore(el, document.body.firstChild);
    return el;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  function renderHeader(meta) {
    document.title = `${escapeHtml(meta.title)} — Priva Embed`;
    if (meta.backdrop) {
      posterWrap.style.backgroundImage = `url(${escapeHtml(meta.backdrop)})`;
    } else if (meta.poster) {
      posterWrap.style.backgroundImage = `url(${escapeHtml(meta.poster)})`;
    } else {
      posterWrap.style.backgroundImage = "none";
      posterWrap.style.background = "#0a0b10";
    }

    const chips = [];
    if (meta.year) chips.push(`<span class="chip">${escapeHtml(meta.year)}</span>`);
    chips.push(
      `<span class="chip ${isSeries ? "series" : ""}">${isSeries ? "TV Series" : "Movie"}</span>`,
    );

    const headerHtml = `
      <div class="header">
        <div class="logo">Priva <b>EMBED</b></div>
        <div class="meta-wrap">
          <div class="title">${escapeHtml(meta.title)}</div>
          <div class="subtitle">${escapeHtml(meta.synopsis || "").slice(0, 160)}</div>
          <div class="chips">${chips.join("")}</div>
        </div>
      </div>
    `;
    root.insertAdjacentHTML("afterbegin", headerHtml);
  }

  function showFinding() {
    document.getElementById("sources-overlay")?.remove();
    const html = `
      <div id="sources-overlay" class="overlay">
        <div class="overlay-content">
          <div class="spinner"></div>
          <h2>Finding sources</h2>
          <p>This usually takes a few seconds</p>
        </div>
      </div>`;
    root.insertAdjacentHTML("beforeend", html);
  }

  function showNoSources() {
    document.getElementById("sources-overlay")?.remove();
    const html = `
      <div id="sources-overlay" class="overlay">
        <div class="overlay-content">
          <h2>No sources found</h2>
          <p>None of the providers (Clarke, Raven, Bellamy) have a playable link right now.</p>
        </div>
      </div>`;
    root.insertAdjacentHTML("beforeend", html);
  }

  function renderSources(streams, providers) {
    document.getElementById("sources-overlay")?.remove();

    const providerStatus = (providers || [])
      .map((p) => {
        const ok = p.ok ? "" : ` — ${escapeHtml(p.error || "failed")}`;
        return `<span class="chip">${escapeHtml(p.provider)}${ok}</span>`;
      })
      .join("");

    const cards = streams
      .map(
        (s, i) => `
        <div class="source-card">
          <div class="source-head">
            <span class="provider-badge">${escapeHtml(s.provider)}</span>
            ${s.quality ? `<span class="quality-badge">${escapeHtml(s.quality)}</span>` : ""}
          </div>
          <div class="desc">${escapeHtml(s.server || s.provider)} ${
          s.tag ? `• ${escapeHtml(s.tag)}` : ""
        }</div>
          <button class="btn" data-index="${i}">Play</button>
        </div>
      `,
      )
      .join("");

    const html = `
      <div id="sources-overlay" class="overlay sources">
        <div class="sources-grid">
          <div style="display:flex;align-items:center;justify-content:space-between;width:100%;">
            <div>
              <h2 style="margin:0">Sources</h2>
              <div style="font-size:.8rem;color:#8b8ea0;margin-top:4px">${providerStatus}</div>
            </div>
            <div style="font-size:.8rem;color:#8b8ea0">${streams.length} stream(s)</div>
          </div>
          ${cards}
        </div>
      </div>
    `;
    root.insertAdjacentHTML("beforeend", html);

    document.querySelectorAll(".btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const idx = Number(e.currentTarget.dataset.index);
        playStream(streams[idx]);
      });
    });
  }

  // ---------- Playback ----------

  function cleanupHls() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
    const video = document.querySelector("video");
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    document.querySelectorAll("video, source").forEach((el) => el.remove());
    currentStream = null;
    const stage = document.querySelector(".stage");
    if (stage) {
      stage.classList.remove("video-ready");
    } else {
      const s = document.createElement("div");
      s.className = "stage";
      root.appendChild(s);
    }
  }

  function playStream(stream) {
    cleanupHls();
    currentStream = stream;

    const stage = document.querySelector(".stage") || (() => {
      const s = document.createElement("div");
      s.className = "stage";
      root.appendChild(s);
      return s;
    })();
    stage.classList.remove("video-ready");

    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = false;
    video.preload = "metadata";
    video.autoplay = true;
    video.style.width = "100%";
    video.style.height = "100%";
    stage.appendChild(video);
    stage.classList.add("video-ready");

    document.getElementById("sources-overlay")?.classList.add("hidden");

    const type = String(stream.type || "").toLowerCase();
    const isHls = type === "m3u8" || type === "hls" || /\.m3u8/i.test(stream.link);

    if (isHls && typeof Hls !== "undefined" && Hls.isSupported()) {
      hls = new Hls();
      hls.loadSource(stream.link);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
      hls.on(Hls.Events.ERROR, () => {});
    } else {
      video.src = stream.link;
      video.play().catch(() => {});
    }

    video.onplay = () => {
      document.getElementById("sources-overlay")?.classList.add("hidden");
    };
    video.onerror = (ev) => {
      console.warn("playback error", ev);
      const btn = document.querySelector(`button[data-index]`);
      if (btn) btn.disabled = false;
    };
    video.onloadedmetadata = () => {
      document.getElementById("sources-overlay")?.classList.add("hidden");
    };
  }

  // ---------- Boot ----------

  async function boot() {
    showFinding();

    let meta = {
      title: isSeries ? `TV Show ${tmdbId}` : `Movie ${tmdbId}`,
      synopsis: "",
      year: "",
    };

    try {
      const res = await fetch(`${API}/api/meta?tmdb_id=${encodeURIComponent(tmdbId)}&type=${isSeries ? "series" : "movie"}`);
      if (res.ok) meta = await res.json();
    } catch (e) {
      console.warn("meta fetch failed", e);
    }
    renderHeader(meta);

    try {
      const qs = new URLSearchParams({
        tmdb_id: tmdbId,
        type: isSeries ? "series" : "movie",
      });
      if (season) qs.set("season", season);
      if (episode) qs.set("episode", episode);
      const res = await fetch(`${API}/api/streams?${qs}`);
      const data = res.ok ? await res.json() : { streams: [], providers: [] };
      if (data.streams && data.streams.length) {
        renderSources(data.streams, data.providers);
        // Auto-play the best available source
        playStream(data.streams[0]);
      } else {
        showNoSources();
      }
    } catch (e) {
      console.warn("streams fetch failed", e);
      showNoSources();
    }
  }

  boot();
})();
