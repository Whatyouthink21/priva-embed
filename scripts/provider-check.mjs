#!/usr/bin/env node
/**
 * Live provider smoke test.
 *
 * Boots the real app on an ephemeral port and resolves a handful of well known
 * titles through every engine, then pulls the first bytes of each stream through
 * the same-origin proxy the player uses. Run it where outbound network is
 * available (CI, Render shell, your laptop):
 *
 *   node scripts/provider-check.mjs [tmdbId[:type[:season:episode]] ...]
 */

import { once } from "node:events";
import { createApp } from "../src/app.js";

const DEFAULT_TARGETS = [
  { label: "Fight Club", type: "movie", tmdbId: "550" },
  { label: "Inception", type: "movie", tmdbId: "27205" },
  { label: "Breaking Bad S1E1", type: "tv", tmdbId: "1396", season: 1, episode: 1 },
  { label: "Game of Thrones S1E1", type: "tv", tmdbId: "1399", season: 1, episode: 1 },
];

const PROVIDERS = ["clarke", "bellamy", "raven"];

/** /api/stream?u=<base64url> -> the upstream URL */
function decodeTarget(proxyPath) {
  try {
    const u = new URL(proxyPath, "http://x").searchParams.get("u");
    return u ? Buffer.from(u.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "";
  } catch {
    return "";
  }
}

function parseTargets(argv) {
  if (!argv.length) return DEFAULT_TARGETS;
  return argv.map((raw) => {
    const [tmdbId, type = "movie", season = "1", episode = "1"] = raw.split(":");
    return {
      label: `${type} ${tmdbId}`,
      tmdbId,
      type: type === "tv" ? "tv" : "movie",
      season: Number(season) || 1,
      episode: Number(episode) || 1,
    };
  });
}

/**
 * When the proxy fails, ask the upstream directly with a few header sets so we
 * can see which one the CDN actually accepts (some return 426 to browsers but
 * serve a plain client, and vice versa).
 */
async function headerMatrix(url, streamHeaders = {}) {
  const baseUrl = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return "";
    }
  })();
  const variants = [
    ["vega-headers", { ...streamHeaders }],
    ["none", {}],
    [
      "referer-only",
      { Referer: `${baseUrl}/`, "User-Agent": streamHeaders["User-Agent"] || "okhttp/4.9.0" },
    ],
    [
      "okhttp",
      { "User-Agent": "okhttp/4.9.0", Referer: `${baseUrl}/` },
    ],
    [
      "no-origin",
      {
        Referer: streamHeaders.Referer || `${baseUrl}/`,
        "User-Agent": streamHeaders["User-Agent"] || "okhttp/4.9.0",
      },
    ],
    [
      "range",
      { ...streamHeaders, Range: "bytes=0-1023" },
    ],
  ];

  const results = [];
  for (const [label, headers] of variants) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      const buf = await response.arrayBuffer();
      results.push({
        label,
        status: response.status,
        bytes: buf.byteLength,
        type: response.headers.get("content-type") || "",
      });
      if (response.ok) break;
    } catch (error) {
      results.push({ label, status: "err", error: error?.message });
    } finally {
      clearTimeout(timer);
    }
  }
  return results;
}

async function probeStream(base, stream) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${base}${stream.url}`, { signal: controller.signal });
    const contentType = response.headers.get("content-type") || "";
    const body = await response.text();
    const isPlaylist = /mpegurl|m3u8/i.test(contentType) || body.startsWith("#EXTM3U");
    const playable = response.ok && body.length > 0 && (stream.type !== "hls" || isPlaylist);
    return {
      ok: playable,
      status: response.status,
      bytes: body.length,
      playlist: isPlaylist,
      firstLine: body.split("\n")[0].slice(0, 80),
    };
  } catch (error) {
    return { ok: false, error: error?.message || "probe failed" };
  } finally {
    clearTimeout(timer);
  }
}

async function resolve(base, target, provider) {
  const params = new URLSearchParams({
    type: target.type,
    tmdb: target.tmdbId,
    season: String(target.season || 1),
    episode: String(target.episode || 1),
    provider,
    refresh: "1",
  });
  const started = Date.now();
  try {
    const response = await fetch(`${base}/api/sources?${params}`);
    const payload = await response.json();
    const entry = (payload.providers || []).find((item) => item.id === provider) || {};
    const streams = entry.streams || [];
    return {
      provider,
      status: entry.status || (response.ok ? "empty" : `http_${response.status}`),
      ms: Date.now() - started,
      title: payload.title || "",
      streams: streams.length,
      kinds: [...new Set(streams.map((stream) => `${stream.type}/${stream.quality || "?"}`))],
      first: streams[0] || null,
      error: entry.message || payload.message || "",
    };
  } catch (error) {
    return { provider, status: "request_failed", ms: Date.now() - started, streams: 0, error: error?.message };
  }
}

const targets = parseTargets(process.argv.slice(2));
const app = createApp();
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

const rows = [];
let playableTitles = 0;

for (const target of targets) {
  const label = `${target.label}${target.type === "tv" ? ` S${target.season}E${target.episode}` : ""}`;
  console.log(`\n=== ${label} (tmdb ${target.tmdbId}) ===`);

  const results = await Promise.all(PROVIDERS.map((provider) => resolve(base, target, provider)));
  let titlePlayable = false;

  for (const result of results) {
    let probe = null;
    if (result.first) probe = await probeStream(base, result.first);
    const ok = Boolean(probe?.ok);
    if (ok) titlePlayable = true;

    // The API only exposes proxy paths; recover the real upstream for diagnosis.
    let matrix = null;
    if (result.first && !ok && [426, 403, 401, 451].includes(Number(probe?.status))) {
      const upstream = decodeTarget(result.first.url);
      if (upstream) matrix = await headerMatrix(upstream, result.first.headers || {});
    }

    rows.push({ label, provider: result.provider, ...result, probe, matrix });
    console.log(
      `RESULT ${JSON.stringify({
        title: label,
        provider: result.provider,
        status: result.status,
        ms: result.ms,
        streams: result.streams,
        kinds: result.kinds,
        probe,
        matrix,
        error: result.error,
        matchedTitle: result.title,
      })}`,
    );
  }

  if (titlePlayable) playableTitles += 1;
}

console.log("\n=== summary ===");
for (const row of rows) {
  console.log(
    [
      row.label.padEnd(28),
      row.provider.padEnd(8),
      row.status.padEnd(12),
      `${String(row.streams).padStart(2)} links`.padEnd(9),
      row.probe?.ok ? "PLAYS" : "no",
      row.error ? `(${row.error})` : "",
    ].join(" "),
  );
}
console.log(`\nplayable titles: ${playableTitles}/${targets.length}`);

server.closeAllConnections?.();
server.close();
process.exit(playableTitles > 0 ? 0 : 1);
