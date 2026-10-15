const $ = id => document.getElementById(id);
const video = $('video');
const query = new URLSearchParams(location.search);
const demo = location.pathname === '/embed/demo';
video.muted = query.get('muted') === '1' || query.get('autoplay') === '1';
let hls, items = [], active = 0, generation = 0, fallbackTimer;
let attempted = new Set();
function overlay(heading, message, action, handler) {
  $('overlay').hidden = false;
  $('player').classList.add('idle');
  $('heading').textContent = heading; $('message').textContent = message;
  $('action').hidden = !action;
  if (action) { $('action').textContent = action; $('action').onclick = handler; }
}
function notice(message) { $('notice').textContent = message; $('notice').hidden = false; }
async function play() {
  try { await video.play(); $('overlay').hidden = true; $('notice').hidden = true; }
  catch { overlay('Ready when you are.', 'Your browser needs a click to begin playback.', 'Play video ▷', play); }
}
function teardown() {
  clearTimeout(fallbackTimer); hls?.destroy(); hls = null;
  video.onloadedmetadata = null; video.onerror = null;
  video.pause(); video.removeAttribute('src'); video.load();
  video.querySelectorAll('track').forEach(track => track.remove());
  $('quality').hidden = true;
}
function failSource() {
  if (demo) {
    clearTimeout(fallbackTimer);
    overlay('Playback unavailable.', 'This browser could not play the local MP4 test clip.', 'Retry playback ↻', load);
    return;
  }
  const next = items.findIndex((_, index) => !attempted.has(index));
  if (next >= 0) { notice('This source failed. Trying the next provider…'); selectSource(next, true); }
  else { clearTimeout(fallbackTimer); $('loading').hidden = true; overlay('No playable source.', 'All returned streams failed. Sources can expire or become unavailable. Reload to try again.', 'Reload sources ↻', load); }
}
function selectSource(index, shouldPlay = false) {
  teardown();
  active = index; attempted.add(index);
  const source = items[index];
  $('source').value = String(index);
  $('notice').hidden = true;
  $('loading').hidden = false;
  overlay('Preparing playback…', 'Connecting to ' + (source.provider?.name || 'the media host') + '.');
  const revision = generation;
  fallbackTimer = setTimeout(() => { if (generation === revision) failSource(); }, 30000);
  const ready = () => {
    clearTimeout(fallbackTimer); $('loading').hidden = true;
    if (shouldPlay || query.get('autoplay') === '1') play();
    else overlay(demo ? 'Your player, ready.' : 'Ready to play.', demo ? 'A local test clip. No API key. No third-party requests.' : 'Choose a source above, or press play to begin.', demo ? 'Play demo ▷' : 'Play video ▷', play);
  };
  video.onloadedmetadata = ready;
  video.onerror = failSource;
  if (source.type === 'hls' && window.Hls?.isSupported()) {
    hls = new Hls({ maxBufferLength: 30, enableWorker: true });
    hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) failSource(); });
    hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
      $('quality').replaceChildren(new Option('Auto quality', '-1'));
      data.levels.forEach((level, i) => $('quality').add(new Option(level.height ? level.height + 'p' : `Level ${i + 1}`, String(i))));
      $('quality').hidden = data.levels.length < 2;
    });
    hls.loadSource(source.url); hls.attachMedia(video);
  } else if (source.type === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl')) {
    failSource(); return;
  } else video.src = source.url;
  (source.subtitles || []).forEach(subtitle => {
    const track = document.createElement('track');
    track.kind = 'subtitles'; track.label = subtitle.label || 'Subtitles'; track.src = subtitle.url;
    video.append(track);
  });
}
async function load() {
  const revision = ++generation;
  teardown(); attempted = new Set(); items = [];
  $('source').hidden = true; $('notice').hidden = true; $('loading').hidden = true;
  if (demo) {
    $('kind').textContent = 'LOCAL PLAYBACK DEMO';
    $('watermark').textContent = 'GENERATED TEST CLIP · NO CINEPRO EXTRACTION';
    items = [{ url: '/demo.mp4', type: 'mp4', provider: { name: 'Local demo' } }];
    selectSource(0); return;
  }
  const parts = location.pathname.split('/').filter(Boolean);
  const isTV = parts[1] === 'tv';
  if (!['movie', 'tv'].includes(parts[1]) || !parts.slice(2).every(n => /^\d+$/.test(n) && Number(n) > 0) || parts.length !== (isTV ? 5 : 3)) {
    overlay('Invalid embed URL.', 'Use /embed/movie/{id} or /embed/tv/{id}/{season}/{episode}.'); return;
  }
  $('kind').textContent = isTV ? `TV EPISODE · ${parts[2]} / S${parts[3]} E${parts[4]}` : `MOVIE · TMDB ${parts[2]}`;
  overlay('Finding your stream.', 'CinePro is checking providers. This can take up to 90 seconds.');
  $('loading').hidden = false;
  try {
    const response = await fetch('/api/sources/' + parts.slice(1).join('/'));
    const data = await response.json();
    if (revision !== generation) return;
    if (!response.ok) throw new Error(data.error?.message || 'Source resolution failed.');
    items = (data.sources || []).map(source => ({ ...source, subtitles: data.subtitles || [] }));
    if (!items.length) throw new Error('No playable sources were returned.');
    $('source').replaceChildren();
    items.forEach((source, i) => $('source').add(new Option(`${source.provider?.name || 'Source ' + (i + 1)} · ${source.quality || source.type}`, String(i))));
    $('source').hidden = false;
    selectSource(0);
  } catch (error) {
    if (revision !== generation) return;
    $('loading').hidden = true;
    overlay('Stream unavailable.', error.message, 'Try again ↻', load);
  }
}
$('reload').onclick = load;
$('source').onchange = () => { attempted = new Set(); selectSource(Number($('source').value), !video.paused); };
$('quality').onchange = () => { if (hls) hls.currentLevel = Number($('quality').value); };
video.addEventListener('play', () => { $('player').classList.remove('idle'); $('overlay').hidden = true; $('watermark').hidden = true; $('player').classList.add('playing'); });
video.addEventListener('pause', () => $('player').classList.remove('playing'));
video.addEventListener('ended', () => { $('player').classList.remove('playing'); overlay('Playback finished.', 'Play this video again.', 'Replay ▷', () => { video.currentTime = 0; play(); }); });
// No cross-origin messaging or storage is needed; playback stays within the iframe.
load();
