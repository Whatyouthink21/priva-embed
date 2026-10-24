import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import jsdom from "jsdom";

const { JSDOM, ResourceLoader, VirtualConsole } = jsdom;
import { createApp } from "../src/app.js";

/* Boot the real player markup + player.js inside jsdom so the client logic can be
   exercised without a browser. Media playback is stubbed: Hls fakes a successful
   manifest parse and the <video> element fakes metadata/play events. */

/* jsdom has no MediaSource, so the real hls.js marks itself unsupported. Strip the
   vendor <script> from the markup and keep a stub on the window instead. */
function stripVendorHls(html) {
  return html.replace(/<script[^>]*\/vendor\/hls\.min\.js[^>]*>\s*<\/script>/i, "");
}

async function withServer(fn) {
  const app = createApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function stubMedia(window) {
  const proto = window.HTMLMediaElement.prototype;
  let playing = false;
  proto.load = function load() {};
  proto.play = function play() {
    playing = true;
    this.dispatchEvent(new window.Event("play"));
    this.dispatchEvent(new window.Event("playing"));
    return Promise.resolve();
  };
  proto.pause = function pause() {
    playing = false;
    this.dispatchEvent(new window.Event("pause"));
  };
  Object.defineProperty(proto, "paused", { get() { return !playing; }, configurable: true });
  Object.defineProperty(proto, "duration", { get() { return 7200; }, configurable: true });
  Object.defineProperty(proto, "currentTime", {
    get() { return this.__time || 0; },
    set(value) { this.__time = value; },
    configurable: true,
  });
  Object.defineProperty(proto, "buffered", {
    get() { return { length: 0, start: () => 0, end: () => 0 }; },
    configurable: true,
  });
  proto.canPlayType = () => "";
  // jsdom cannot decode media; swallow the synthetic error events it fires.
  window.addEventListener(
    "error",
    (event) => {
      if (event.target && event.target.tagName === "VIDEO") event.stopPropagation();
    },
    true,
  );
}

function stubHls(window, { failFatal = false } = {}) {
  const instances = [];
  class Hls {
    static isSupported() {
      return true;
    }
    static Events = {
      MANIFEST_PARSED: "hlsManifestParsed",
      ERROR: "hlsError",
      LEVEL_SWITCHED: "hlsLevelSwitched",
    };
    static ErrorTypes = {
      NETWORK_ERROR: "networkError",
      MEDIA_ERROR: "mediaError",
      OTHER_ERROR: "otherError",
    };
    constructor(config) {
      this.config = config;
      this.levels = [{ height: 1080 }, { height: 720 }];
      this.handlers = {};
      this.currentLevel = 0;
      instances.push(this);
    }
    loadSource(url) {
      this.url = url;
    }
    attachMedia(media) {
      this.media = media;
      setTimeout(() => {
        if (failFatal) {
          const onError = this.handlers[Hls.Events.ERROR];
          if (onError) onError(Hls.Events.ERROR, { fatal: true, type: "otherError" });
          return;
        }
        const handler = this.handlers[Hls.Events.MANIFEST_PARSED];
        if (handler) handler(Hls.Events.MANIFEST_PARSED, { levels: this.levels });
      }, 0);
    }
    on(event, handler) {
      this.handlers[event] = handler;
    }
    startLoad() {}
    recoverMediaError() {}
    destroy() {
      this.destroyed = true;
    }
  }
  window.Hls = Hls;
  window.__hlsInstances = instances;
}

async function loadPlayer(url, options = {}) {
  const html = stripVendorHls(await (await fetch(url)).text());
  const dom = new JSDOM(html, {
    url,
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      stubMedia(window);
      stubHls(window, options);
      window.fetch = (input, init) => fetch(new URL(String(input), url).toString(), init);
      window.matchMedia = () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      });
      window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
      window.cancelAnimationFrame = (id) => clearTimeout(id);
      window.HTMLCanvasElement.prototype.getContext = () => null;
    },
  });

  await new Promise((resolve) => {
    if (dom.window.document.readyState === "complete") resolve();
    else {
      dom.window.addEventListener("load", resolve, { once: true });
      setTimeout(resolve, 3000);
    }
  });

  // Wait for the source requests, provider selection and playback attach to settle.
  const { window } = dom;
  for (let i = 0; i < 60; i += 1) {
    const doc = window.document;
    if (window.__hlsInstances?.length && doc.getElementById("splash")?.hidden) break;
    const errored = doc.body.dataset.state === "error" || doc.body.classList.contains("state-error");
    if (errored && i > 6) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return dom;
}

test("demo movie player boots, picks a provider and attaches playback", async () => {
  await withServer(async (base) => {
    const dom = await loadPlayer(`${base}/player/550?demo=1`);
    const { document } = dom.window;

    assert.equal(dom.window.__hlsInstances.length > 0, true, "an hls instance was created");
    const hls = dom.window.__hlsInstances[0];
    assert.match(hls.url, /m3u8/, "hls fed a manifest url");
    assert.equal(hls.media, document.getElementById("video"), "hls attached to the <video>");

    assert.ok(
      ["playing", "paused"].includes(document.body.dataset.state),
      `player left the loading state (was ${document.body.dataset.state})`,
    );
    assert.notEqual(document.body.dataset.state, "error");

    const names = [...document.querySelectorAll("#providerList .menu-item__title")].map((el) =>
      el.textContent.trim(),
    );
    assert.deepEqual(names, ["Clarke", "Bellamy", "Raven"], "provider codenames only");

    assert.equal(document.getElementById("providerBtnLabel").textContent, "Clarke");
    assert.match(document.querySelector(".topbar__title").textContent, /Fight Club/);

    const html = document.documentElement.outerHTML;
    assert.ok(!/castletv|autoembed|moviebox/i.test(html), "no real provider names leak into the DOM");

    dom.window.close();
  });
});

test("provider menu switches sources without a reload", async () => {
  await withServer(async (base) => {
    const dom = await loadPlayer(`${base}/player/550?demo=1`);
    const { document } = dom.window;
    const buttons = [...document.querySelectorAll("#providerList button")];
    assert.equal(buttons.length, 3);

    const before = dom.window.__hlsInstances.length;
    buttons[2].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 40 && dom.window.__hlsInstances.length === before; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(document.getElementById("providerBtnLabel").textContent, "Raven");
    assert.ok(dom.window.__hlsInstances.length > before, "a new hls instance started");
    assert.equal(dom.window.__hlsInstances[before - 1].destroyed, true, "old hls torn down");

    dom.window.close();
  });
});

test("tv player renders episode chrome and drawer", async () => {
  await withServer(async (base) => {
    const dom = await loadPlayer(`${base}/player/1396/2/3?demo=1`);
    const { document } = dom.window;

    assert.match(document.getElementById("episodePillLabel").textContent, /S2 E3/);
    assert.equal(document.getElementById("episodesBtn").hidden, false);

    document.getElementById("episodesBtn").dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(document.getElementById("episodeDrawer").hidden, false, "drawer opens");
    assert.ok(
      document.querySelectorAll("#episodeList .episode, #episodeList [data-episode]").length > 0,
      "episodes listed",
    );

    dom.window.close();
  });
});

test("query options are honoured (theme, provider)", async () => {
  await withServer(async (base) => {
    const dom = await loadPlayer(`${base}/player/550?demo=1&provider=raven&theme=ff5c7a`);
    const { document, getComputedStyle } = dom.window;

    assert.equal(document.getElementById("providerBtnLabel").textContent, "Raven");
    const primary = document.documentElement.style.getPropertyValue("--primary");
    assert.equal(primary.trim(), "#ff5c7a");
    assert.ok(getComputedStyle(document.documentElement).length >= 0);

    dom.window.close();
  });
});

test("fatal playback errors fall through every source and stop", async () => {
  await withServer(async (base) => {
    const dom = await loadPlayer(`${base}/player/550?demo=1`, { failFatal: true });
    for (let i = 0; i < 80 && dom.window.document.body.dataset.state !== "error"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const { document } = dom.window;
    assert.equal(document.body.dataset.state, "error", "gives up instead of looping forever");
    assert.match(document.getElementById("statusTitle").textContent, /Playback failed/);
    assert.ok(dom.window.__hlsInstances.length <= 6, "bounded retries");

    dom.window.close();
  });
});

test("docs configurator rewrites the preview url", async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/embed`)).text();
    const dom = new JSDOM(html, {
      url: `${base}/embed`,
      runScripts: "dangerously",
      resources: "usable",
      virtualConsole: new VirtualConsole(),
      beforeParse(window) {
        window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
      },
    });
    await new Promise((resolve) => {
      if (dom.window.document.readyState === "complete") resolve();
      else dom.window.addEventListener("load", resolve, { once: true });
      setTimeout(resolve, 2000);
    });

    const { document } = dom.window;
    assert.match(
      document.getElementById("previewFrame").getAttribute("src"),
      /^(?:https?:\/\/[^/]+)?\/player\/550\?demo=1$/,
    );

    const tmdb = document.getElementById("tmdbInput");
    tmdb.value = "1396";
    tmdb.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    const tvButton = document.querySelector('#typeToggle button[data-type="tv"]');
    tvButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 700));

    const src = document.getElementById("previewFrame").getAttribute("src");
    assert.match(src, /\/player\/1396\/1\/1\?demo=1$/);
    assert.match(document.getElementById("previewUrl").textContent, /^\/player\/1396/);

    dom.window.close();
  });
});
