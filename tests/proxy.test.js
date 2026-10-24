import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

import { createApp } from "../src/app.js";
import { b64url, encodeHeaders } from "../src/lib/tokens.js";

const SEGMENT = Buffer.from("fake-ts-segment-bytes");

async function startUpstream() {
  const seen = {};
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/hls/master.m3u8") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(
        [
          "#EXTM3U",
          '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
          "#EXTINF:6.0,",
          "seg1.ts",
          "#EXT-X-STREAM-INF:BANDWIDTH=900000",
          "/hls/720/index.m3u8",
        ].join("\n"),
      );
      return;
    }
    if (url.pathname === "/hls/seg1.ts") {
      res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": SEGMENT.length });
      res.end(SEGMENT);
      return;
    }
    if (url.pathname === "/subs.srt") {
      seen.subtitleReferer = req.headers.referer;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("1\n00:00:01,000 --> 00:00:02,000\nHello\n");
      return;
    }
    res.writeHead(404).end("nope");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, seen, port: server.address().port };
}

test("stream proxy rewrites manifests, streams segments and converts subtitles", async (t) => {
  const { server: upstream, seen, port } = await startUpstream();
  const app = createApp();
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const base = `http://127.0.0.1:${listener.address().port}`;

  t.after(() => {
    listener.close();
    upstream.close();
  });

  // 1. manifest
  const manifestUrl = `http://127.0.0.1:${port}/hls/master.m3u8`;
  const manifestResponse = await fetch(`${base}/api/stream?u=${b64url(manifestUrl)}`);
  assert.equal(manifestResponse.status, 200);
  assert.match(manifestResponse.headers.get("content-type"), /mpegurl/);
  const manifest = await manifestResponse.text();
  assert.ok(manifest.includes("#EXTM3U"));
  assert.ok(!manifest.includes("seg1.ts\"") && !manifest.split("\n").includes("seg1.ts"));
  assert.ok(manifest.includes("/api/stream?u="));
  assert.ok(manifest.includes('URI="/api/stream?u='));

  // 2. segment passthrough
  const segmentUrl = `http://127.0.0.1:${port}/hls/seg1.ts`;
  const segmentResponse = await fetch(`${base}/api/stream?u=${b64url(segmentUrl)}`);
  assert.equal(segmentResponse.status, 200);
  const body = Buffer.from(await segmentResponse.arrayBuffer());
  assert.deepEqual(body, SEGMENT);
  assert.equal(segmentResponse.headers.get("access-control-allow-origin"), "*");

  // 3. srt -> vtt
  const subtitleUrl = `http://127.0.0.1:${port}/subs.srt`;
  const subtitleResponse = await fetch(`${base}/api/subtitle?u=${b64url(subtitleUrl)}`);
  assert.equal(subtitleResponse.status, 200);
  const vtt = await subtitleResponse.text();
  assert.ok(vtt.startsWith("WEBVTT"));
  assert.ok(vtt.includes("00:00:01.000 --> 00:00:02.000"));

  // 4. subtitles carry the provider's headers (Nova's CDN 403s without Referer)
  const token = encodeHeaders({ Referer: "https://player.example/", Origin: "https://player.example" });
  const withHeaders = await fetch(`${base}/api/subtitle?u=${b64url(subtitleUrl)}&h=${token}`);
  assert.equal(withHeaders.status, 200);
  assert.ok((await withHeaders.text()).startsWith("WEBVTT"));
  assert.equal(seen.subtitleReferer, "https://player.example/", "Referer reached the upstream");
});

test("player, docs and api endpoints render", async (t) => {
  const app = createApp();
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const base = `http://127.0.0.1:${listener.address().port}`;
  t.after(() => listener.close());

  const docs = await fetch(`${base}/embed`);
  assert.equal(docs.status, 200);
  const docsHtml = await docs.text();
  assert.ok(docsHtml.includes("Embed <span class=\"grad\">Priva</span>"));
  assert.ok(docsHtml.includes("/player/{tmdb_id}"));

  const player = await fetch(`${base}/player/550?demo=1&theme=ff5c7a`);
  assert.equal(player.status, 200);
  const playerHtml = await player.text();
  assert.ok(playerHtml.includes("Fight Club"));
  assert.ok(playerHtml.includes("--primary:#ff5c7a"));
  assert.ok(playerHtml.includes('id="priva-config"'));

  const tvPlayer = await fetch(`${base}/player/1396/2/3?demo=1`);
  assert.equal(tvPlayer.status, 200);
  const tvHtml = await tvPlayer.text();
  assert.ok(tvHtml.includes("Breaking Bad"));
  assert.ok(tvHtml.includes("S2 · E3"));

  const sources = await fetch(`${base}/api/sources?demo=1&type=movie&tmdb=550`);
  const payload = await sources.json();
  assert.equal(payload.demo, true);
  assert.equal(payload.providers.length, 3);
  assert.deepEqual(
    payload.providers.map((provider) => provider.name),
    ["Clarke", "Bellamy", "Nova"],
  );

  const oneEngine = await fetch(`${base}/api/sources?demo=1&type=movie&tmdb=550&provider=nova`);
  assert.deepEqual(
    (await oneEngine.json()).providers.map((provider) => provider.id),
    ["nova"],
    "demo mode honours ?provider=",
  );

  const health = await fetch(`${base}/api/health`);
  assert.equal((await health.json()).ok, true);
});
