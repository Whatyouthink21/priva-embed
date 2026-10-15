const $ = id => document.getElementById(id);
let type = 'movie';
let currentPath = '/embed/demo';
function mediaPath(prefix) {
  const id = $('tmdb').value.trim();
  return `${prefix}/${type}/${encodeURIComponent(id)}` + (type === 'tv' ? `/${$('season').value}/${$('episode').value}` : '');
}
function updateCode() {
  const url = location.origin + currentPath;
  $('embed-code').textContent = `<iframe\n  src="${url}"\n  style="width:100%;aspect-ratio:16/9;border:0"\n  allow="autoplay; fullscreen; picture-in-picture"\n  allowfullscreen\n></iframe>`;
  $('open-player').href = currentPath;
  $('api-path').textContent = mediaPath('/api/sources');
}
document.querySelectorAll('[data-type]').forEach(button => button.onclick = () => {
  type = button.dataset.type;
  document.querySelectorAll('[data-type]').forEach(b => { b.classList.toggle('active', b === button); b.setAttribute('aria-pressed', String(b === button)); });
  $('episode-fields').hidden = type !== 'tv';
  $('api-path').textContent = mediaPath('/api/sources');
});
$('embed-form').onsubmit = event => {
  event.preventDefault();
  const params = new URLSearchParams();
  if ($('autoplay').checked) params.set('autoplay', '1');
  if ($('muted').checked) params.set('muted', '1');
  currentPath = mediaPath('/embed') + (params.size ? '?' + params : '');
  $('preview').src = currentPath;
  $('preview-label').textContent = type === 'movie' ? 'MOVIE / ' + $('tmdb').value : `TV / ${$('tmdb').value} · S${$('season').value} E${$('episode').value}`;
  updateCode();
};
$('demo').onclick = () => {
  currentPath = '/embed/demo'; $('preview').src = currentPath;
  $('preview-label').textContent = 'LOCAL DEMO'; updateCode();
};
$('copy-embed').onclick = async () => {
  try { await navigator.clipboard.writeText($('embed-code').textContent); $('copy-embed').textContent = 'Copied ✓'; }
  catch { $('copy-embed').textContent = 'Select code to copy'; }
  setTimeout(() => $('copy-embed').textContent = 'Copy iframe ▣', 2000);
};
$('fetch-sources').onclick = async () => {
  if (!$('embed-form').reportValidity()) return;
  const button = $('fetch-sources'); button.disabled = true; button.textContent = 'Resolving…';
  $('api-path').textContent = mediaPath('/api/sources'); $('api-response').textContent = '// Waiting for Consumet providers (up to 90 seconds)…';
  try {
    const response = await fetch(mediaPath('/api/sources'));
    const data = await response.json();
    $('api-response').textContent = `// HTTP ${response.status}\n` + JSON.stringify(data, null, 2);
  } catch { $('api-response').textContent = 'Request failed. Check your network and server logs.'; }
  finally { button.disabled = false; button.textContent = 'Send request ↗'; }
};
fetch('/api/health').then(r => r.json()).then(data => {
  const el = $('health'); el.replaceChildren();
  const dot = document.createElement('span'); dot.className = 'dot'; el.append(dot);
  if (data.status === 'ready') el.append(`Consumet ready (${data.mode === 'api' ? 'hosted API' : 'bundled providers'}). Ready to resolve sources.`);
  else { el.classList.add('warning'); el.append(data.consumet.configured ? (data.mode === 'api' ? 'Consumet API is configured but not reachable. Check CONSUMET_API_URL.' : 'Consumet is configured but TMDB is not reachable. Check TMDB_API_KEY and network access.') : 'Resolver setup required — add your TMDB API key to enable extraction. The local playback demo is ready.'); }
}).catch(() => { $('health').textContent = 'Unable to check the resolver connection.'; $('health').classList.add('warning'); });
updateCode();
