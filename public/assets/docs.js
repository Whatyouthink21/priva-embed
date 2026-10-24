(() => {
  "use strict";

  const origin = window.location.origin;
  const serverOrigin = document.body.dataset.serverOrigin || origin;

  // Snippets are rendered server-side; keep the host honest when the app is
  // viewed through a proxy (a different host than the one baked into the HTML).
  if (serverOrigin !== origin) {
    document.querySelectorAll("[data-copy]").forEach((button) => {
      button.dataset.copy = button.dataset.copy.split(serverOrigin).join(origin);
    });
    document.querySelectorAll("pre code").forEach((block) => {
      block.textContent = block.textContent.split(serverOrigin).join(origin);
    });
  }
  const $ = (selector) => document.querySelector(selector);

  const state = {
    type: "movie",
    tmdb: "550",
    season: "1",
    episode: "1",
    autoplay: false,
    autoNext: true,
    title: "",
    theme: "#ffffff",
    demo: true,
  };

  const fields = {
    tmdb: $("#tmdbInput"),
    season: $("#seasonInput"),
    episode: $("#episodeInput"),
    tv: $("#tvFields"),
  };

  function buildUrl() {
    const path =
      state.type === "tv"
        ? `/player/${state.tmdb}/${state.season}/${state.episode}`
        : `/player/${state.tmdb}`;
    const params = new URLSearchParams();
    if (state.theme && state.theme.toLowerCase() !== "#ffffff") {
      params.set("theme", state.theme.replace("#", ""));
    }
    if (state.autoplay) params.set("autoplay", "1");
    if (!state.autoNext) params.set("autoNext", "0");
    if (state.title.trim()) params.set("title", state.title.trim());
    if (state.demo) params.set("demo", "1");
    const query = params.toString();
    return `${origin}${path}${query ? `?${query}` : ""}`;
  }

  function refresh() {
    const url = buildUrl();
    $("#previewUrl").textContent = url.replace(origin, "");
    $("#previewFrame").src = url;
  }

  let debounce;
  const queueRefresh = () => {
    clearTimeout(debounce);
    debounce = setTimeout(refresh, 450);
  };

  document.querySelectorAll("#typeToggle button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("#typeToggle button").forEach((other) => other.classList.remove("is-active"));
      button.classList.add("is-active");
      state.type = button.dataset.type;
      fields.tv.hidden = state.type !== "tv";
      queueRefresh();
    });
  });

  fields.tmdb?.addEventListener("input", () => {
    state.tmdb = fields.tmdb.value.replace(/[^0-9]/g, "") || "550";
    queueRefresh();
  });
  fields.season?.addEventListener("input", () => {
    state.season = fields.season.value.replace(/[^0-9]/g, "") || "1";
    queueRefresh();
  });
  fields.episode?.addEventListener("input", () => {
    state.episode = fields.episode.value.replace(/[^0-9]/g, "") || "1";
    queueRefresh();
  });

  $("#optAutoplay")?.addEventListener("change", (event) => {
    state.autoplay = event.target.checked;
    queueRefresh();
  });
  $("#optAutoNext")?.addEventListener("change", (event) => {
    state.autoNext = event.target.checked;
    queueRefresh();
  });
  $("#optTitle")?.addEventListener("input", (event) => {
    state.title = event.target.value;
    queueRefresh();
  });
  $("#optTheme")?.addEventListener("input", (event) => {
    state.theme = event.target.value;
    queueRefresh();
  });

  $("#optDemo")?.addEventListener("change", (event) => {
    state.demo = event.target.checked;
    queueRefresh();
  });

  $("#previewBtn")?.addEventListener("click", refresh);

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    }
  };

  document.addEventListener("click", async (event) => {
    const button = event.target.closest(".copy, [data-copy]");
    if (!button) return;
    const text =
      button.dataset.copy ||
      (button.id === "copyUrl" ? buildUrl() : "") ||
      button.parentElement?.querySelector("code")?.textContent ||
      button.parentElement?.querySelector("pre code")?.textContent ||
      "";
    const ok = await copy(text);
    const previous = button.textContent;
    button.textContent = ok ? "Copied" : "Copy failed";
    setTimeout(() => {
      button.textContent = previous;
    }, 1400);
  });

  document.querySelectorAll("#docTabs button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("#docTabs button").forEach((other) => other.classList.remove("is-active"));
      button.classList.add("is-active");
      document.querySelectorAll(".panel").forEach((panel) => {
        panel.classList.toggle("is-active", panel.dataset.panel === button.dataset.tab);
      });
    });
  });

  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener("click", (event) => {
      const id = anchor.getAttribute("href").slice(1);
      if (id === "params" || id === "events" || id === "postmessage") {
        const tab = document.querySelector(`#docTabs button[data-tab="${id}"]`);
        tab?.click();
      }
      if (id === "implementation") {
        document.querySelector('#docTabs button[data-tab="implementation"]')?.click();
      }
      const target = document.getElementById(id);
      if (target) {
        event.preventDefault();
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  refresh();
})();
