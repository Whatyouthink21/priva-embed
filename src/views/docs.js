import { providerList } from "../providers/index.js";

export function renderDocs({ baseUrl }) {
  // NOTE: __ORIGIN__ placeholders are replaced at the end of this function.
  const origin = baseUrl || "https://your-priva-app.onrender.com";
  const providers = providerList();

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Priva Embed — API Embed for movies & TV</title>
<meta name="description" content="Drop an iframe into any page and stream movies and TV shows. No API key, no signup." />
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="/assets/docs.css" />
</head>
<body data-server-origin="__ORIGIN__">
<div class="glow glow--one"></div>
<div class="glow glow--two"></div>

<nav class="nav">
  <a class="nav__brand" href="/embed">
    <span class="nav__mark">P</span>
    <span class="nav__word">PRIVA</span>
    <span class="nav__badge">EMBED</span>
  </a>
  <div class="nav__links">
    <a href="#preview">Preview</a>
    <a href="#params">Parameters</a>
    <a href="#events">Events</a>
    <a href="#postmessage">API</a>
  </div>
  <a class="nav__cta" href="#preview">Get the snippet</a>
</nav>

<main>
  <header class="hero">
    <div class="hero__badge"><span class="dot"></span> Free · No API key required</div>
    <h1>Embed <span class="grad">Priva</span> in your website</h1>
    <p>
      Drop an iframe into any webpage and stream movies &amp; TV shows instantly.
      No signup, no API key, no cost. Three source engines · ${providers.map((provider) => provider.name).join(" · ")}.
    </p>
    <div class="hero__anchors">
      <a href="#implementation">Implementation</a>
      <a href="#params">Parameters</a>
      <a href="#events">Events</a>
      <a href="#postmessage">PostMessage API</a>
    </div>
  </header>

  <section class="preview" id="preview">
    <div class="preview__head">
      <div>
        <div class="eyebrow">Live preview</div>
        <h2>Try it now</h2>
        <p>Configure the player and see it in real time.</p>
      </div>
      <div class="segmented" id="typeToggle" role="tablist">
        <button type="button" class="is-active" data-type="movie" role="tab">Movie</button>
        <button type="button" data-type="tv" role="tab">TV Show</button>
      </div>
    </div>

    <div class="preview__grid">
      <div class="preview__frame">
        <div class="frame">
          <iframe id="previewFrame" src="/player/550" allowfullscreen allow="encrypted-media; autoplay; picture-in-picture; fullscreen" loading="lazy"></iframe>
        </div>
        <div class="preview__url">
          <code id="previewUrl">${origin}/player/550?demo=1</code>
          <button class="copy" id="copyUrl" type="button">Copy</button>
        </div>
      </div>

      <form class="preview__options" id="previewForm">
        <div class="field-row">
          <label class="field">
            <span>TMDB ID</span>
            <input id="tmdbInput" value="550" inputmode="numeric" autocomplete="off" />
          </label>
          <div class="field field--tv" hidden id="tvFields">
            <span>Season / Episode</span>
            <div class="field__pair">
              <input id="seasonInput" value="1" inputmode="numeric" />
              <input id="episodeInput" value="1" inputmode="numeric" />
            </div>
          </div>
        </div>

        <div class="options__label">Options</div>

        <label class="switch-row">
          <span>autoplay</span>
          <input type="checkbox" id="optAutoplay" />
        </label>
        <label class="switch-row">
          <span>title</span>
          <input type="text" id="optTitle" placeholder="Override the title" />
        </label>
        <label class="switch-row">
          <span>autoNext</span>
          <input type="checkbox" id="optAutoNext" checked />
        </label>
        <label class="switch-row">
          <span>theme</span>
          <input type="color" id="optTheme" value="#ffffff" />
        </label>
        <label class="switch-row">
          <span>demo stream</span>
          <input type="checkbox" id="optDemo" />
        </label>

        <button class="btn btn--primary" type="button" id="previewBtn">Preview</button>
        <p class="options__hint">Configure and click Preview</p>
      </form>
    </div>
  </section>

  <section class="features">
    <div class="eyebrow">Why Priva</div>
    <h2>Built for developers</h2>
    <div class="features__grid">
      <article><div class="features__icon">⚡</div><h3>Zero Setup</h3><p>No API key or signup. Just paste the iframe and it works.</p></article>
      <article><div class="features__icon">🔄</div><h3>Auto-Updated</h3><p>Links refresh automatically with the best available quality.</p></article>
      <article><div class="features__icon">📱</div><h3>Responsive</h3><p>Works on every device — desktop, mobile, tablet.</p></article>
      <article><div class="features__icon">🔌</div><h3>PostMessage API</h3><p>Control playback and track progress from your own page.</p></article>
    </div>
  </section>

  <section class="docs" id="implementation">
    <div class="eyebrow">Documentation</div>
    <h2>Integration guide</h2>
    <p class="docs__lede">Everything you need to embed and control the Priva player.</p>

    <div class="tabs" id="docTabs">
      <button class="is-active" data-tab="implementation" type="button">Implementation</button>
      <button data-tab="params" type="button">Parameters</button>
      <button data-tab="events" type="button">Events</button>
      <button data-tab="postmessage" type="button">PostMessage API</button>
    </div>

    <div class="panel is-active" data-panel="implementation">
      <h3>Endpoints</h3>
      <div class="endpoint"><span>Movie</span><code>${origin}/player/{tmdb_id}</code><button class="copy" data-copy="${origin}/player/{tmdb_id}" type="button">Copy</button></div>
      <div class="endpoint"><span>TV Show</span><code>${origin}/player/{tmdb_id}/{season}/{episode}</code><button class="copy" data-copy="${origin}/player/{tmdb_id}/{season}/{episode}" type="button">Copy</button></div>

      <h3>Basic</h3>
      <div class="code">
<pre><code>&lt;iframe
  src="${origin}/player/550?theme=ffffff"
  width="100%"
  height="100%"
  frameborder="0"
  allowfullscreen
  allow="encrypted-media; autoplay; picture-in-picture; fullscreen"
&gt;&lt;/iframe&gt;</code></pre>
        <button class="copy copy--code" data-copy="&lt;iframe src=&quot;${origin}/player/550?theme=ffffff&quot; width=&quot;100%&quot; height=&quot;100%&quot; frameborder=&quot;0&quot; allowfullscreen allow=&quot;encrypted-media; autoplay; picture-in-picture; fullscreen&quot;&gt;&lt;/iframe&gt;" type="button">Copy</button>
      </div>

      <h3>Responsive 16:9</h3>
      <div class="code">
<pre><code>&lt;!-- 16:9 aspect ratio container --&gt;
&lt;div style="position:relative;padding-bottom:56.25%;height:0;"&gt;
  &lt;iframe
    src="${origin}/player/550?theme=ffffff"
    style="position:absolute;top:0;left:0;width:100%;height:100%;"
    frameborder="0"
    allowfullscreen
    allow="encrypted-media; autoplay; picture-in-picture; fullscreen"
  &gt;&lt;/iframe&gt;
&lt;/div&gt;</code></pre>
        <button class="copy copy--code" data-copy='&lt;div style="position:relative;padding-bottom:56.25%;height:0;"&gt;&lt;iframe src="${origin}/player/550?theme=ffffff" style="position:absolute;top:0;left:0;width:100%;height:100%;" frameborder="0" allowfullscreen allow="encrypted-media; autoplay; picture-in-picture; fullscreen"&gt;&lt;/iframe&gt;&lt;/div&gt;' type="button">Copy</button>
      </div>

      <h3>Tailwind CSS</h3>
      <div class="code">
<pre><code>&lt;div className="relative w-full pt-[56.25%]"&gt;
  &lt;iframe
    src="${origin}/player/550?theme=ffffff"
    className="absolute top-0 left-0 h-full w-full"
    frameBorder="0"
    allowFullScreen
    allow="encrypted-media; autoplay; picture-in-picture; fullscreen"
  /&gt;
&lt;/div&gt;</code></pre>
        <button class="copy copy--code" data-copy='&lt;div className="relative w-full pt-[56.25%]"&gt;&lt;iframe src="${origin}/player/550?theme=ffffff" className="absolute top-0 left-0 h-full w-full" frameBorder="0" allowFullScreen allow="encrypted-media; autoplay; picture-in-picture; fullscreen" /&gt;&lt;/div&gt;' type="button">Copy</button>
      </div>
    </div>

    <div class="panel" data-panel="params" id="params">
      <table class="table">
        <thead><tr><th>Parameter</th><th>Default</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>theme</code></td><td><code>ffffff</code></td><td>Accent colour as a plain hex value.</td></tr>
          <tr><td><code>autoplay</code></td><td><code>0</code></td><td>Start playback as soon as a source resolves.</td></tr>
          <tr><td><code>autoNext</code></td><td><code>1</code></td><td>Auto-play the next episode when one ends.</td></tr>
          <tr><td><code>title</code></td><td>TMDB title</td><td>Override the title shown in the player.</td></tr>
          <tr><td><code>poster</code></td><td>TMDB artwork</td><td>Override the backdrop image.</td></tr>
          <tr><td><code>provider</code></td><td><code>auto</code></td><td>${providers.map((provider) => `<code>${provider.id}</code>`).join(", ")} or <code>auto</code>.</td></tr>
          <tr><td><code>muted</code></td><td><code>0</code></td><td>Start muted to satisfy browser autoplay rules.</td></tr>
          <tr><td><code>start</code></td><td><code>0</code></td><td>Start offset in seconds.</td></tr>
          <tr><td><code>lang</code></td><td>–</td><td>Preferred subtitle language (ISO-639-1).</td></tr>
        </tbody>
      </table>
    </div>

    <div class="panel" data-panel="events" id="events">
      <h3>Events emitted by the player</h3>
      <p>Every message is posted to the parent window with <code>source: "priva-embed"</code>.</p>
      <div class="code"><pre><code>window.addEventListener("message", (event) =&gt; {
  const data = event.data;
  if (!data || data.source !== "priva-embed") return;

  switch (data.event) {
    case "ready":      console.log("player ready", data.payload); break;
    case "sources":    console.log("links found", data.payload); break;
    case "play":       console.log("playing"); break;
    case "pause":      console.log("paused"); break;
    case "timeupdate": console.log(data.payload.currentTime); break;
    case "ended":      console.log("finished"); break;
    case "error":      console.warn(data.payload.message); break;
  }
});</code></pre></div>
      <h3>Event list</h3>
      <table class="table">
        <thead><tr><th>Event</th><th>Payload</th></tr></thead>
        <tbody>
          <tr><td><code>ready</code></td><td><code>{ tmdbId, type, title }</code></td></tr>
          <tr><td><code>sources</code></td><td><code>{ provider, count }</code></td></tr>
          <tr><td><code>play</code> / <code>pause</code> / <code>timeupdate</code> / <code>ended</code></td><td><code>{ currentTime, duration }</code></td></tr>
          <tr><td><code>provider</code></td><td><code>{ provider }</code></td></tr>
          <tr><td><code>close</code></td><td><code>{}</code></td></tr>
          <tr><td><code>error</code></td><td><code>{ message }</code></td></tr>
        </tbody>
      </table>
    </div>

    <div class="panel" data-panel="postmessage" id="postmessage">
      <h3>Control the player from your page</h3>
      <div class="code"><pre><code>const frame = document.querySelector("iframe");

const send = (command, value) =&gt;
  frame.contentWindow.postMessage({ source: "priva-parent", command, value }, "*");

send("play");
send("pause");
send("seek", 120);        // seconds
send("setProvider", "bellamy");
send("mute");
send("setVolume", 0.6);</code></pre></div>
      <h3>Commands</h3>
      <table class="table">
        <thead><tr><th>Command</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td><code>play</code> / <code>pause</code> / <code>toggle</code></td><td>–</td></tr>
          <tr><td><code>seek</code></td><td>seconds</td></tr>
          <tr><td><code>setProvider</code></td><td>${providers.map((provider) => `<code>${provider.id}</code>`).join(", ")}</td></tr>
          <tr><td><code>mute</code> / <code>unmute</code></td><td>–</td></tr>
          <tr><td><code>setVolume</code></td><td><code>0</code> – <code>1</code></td></tr>
        </tbody>
      </table>
    </div>
  </section>

  <footer class="footer">
    <div>Priva Embed · ${providers.map((provider) => provider.name).join(" · ")}</div>
    <div class="footer__muted">Only embed content you have the rights to distribute.</div>
  </footer>
</main>

<script src="/assets/docs.js"></script>
</body>
</html>`;

  return html.split("__ORIGIN__").join(origin);
}
