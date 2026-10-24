import express from "express";
import { Readable } from "node:stream";
import { unb64url, b64url, encodeHeaders, decodeHeaders } from "../lib/tokens.js";
import { asyncRoute } from "../lib/express.js";

const router = express.Router();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const FORWARD_REQUEST_HEADERS = ["range", "if-range", "if-none-match", "if-modified-since"];

function absolute(base, relative) {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

function proxyUrl(url, headers) {
  const token = encodeHeaders(headers);
  return `/api/stream?u=${b64url(url)}${token ? `&h=${token}` : ""}`;
}

export function rewritePlaylist(text, playlistUrl, headers) {
  const lines = text.split(/\r?\n/);
  const output = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith("#")) {
      // Rewrite URI="..." attributes (keys, maps, media renditions, parts).
      return line.replace(/URI="([^"]+)"/g, (_match, uri) => {
        const resolved = absolute(playlistUrl, uri);
        return `URI="${proxyUrl(resolved, headers)}"`;
      });
    }

    const resolved = absolute(playlistUrl, trimmed);
    return proxyUrl(resolved, headers);
  });
  return output.join("\n");
}

export function srtToVtt(text) {
  if (/^\uFEFF?WEBVTT/.test(text)) return text;
  const body = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^\uFEFF/, "")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .replace(/(\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return `WEBVTT\n\n${body}`;
}

router.options("/stream", (_req, res) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "Range,Content-Type",
  });
  res.sendStatus(204);
});

router.get("/stream", asyncRoute(async (req, res) => {
  const target = unb64url(req.query.u);
  if (!/^https?:\/\//i.test(target)) {
    return res.status(400).json({ error: "invalid_stream_url" });
  }
  const headers = decodeHeaders(req.query.h);

  const controller = new AbortController();
  req.on("close", () => controller.abort(new Error("client closed")));

  const requestHeaders = {
    "User-Agent": headers["User-Agent"] || UA,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    ...headers,
  };
  for (const name of FORWARD_REQUEST_HEADERS) {
    if (req.headers[name]) requestHeaders[name] = req.headers[name];
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: requestHeaders,
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) return;
    return res.status(502).json({ error: "upstream_unreachable", message: error?.message });
  }

  if (!upstream.ok && upstream.status !== 206) {
    const status = upstream.status === 404 ? 404 : 502;
    return res.status(status).json({ error: "upstream_error", status: upstream.status });
  }

  const contentType = upstream.headers.get("content-type") || "";
  const finalUrl = upstream.url || target;
  const looksPlaylist =
    /mpegurl/i.test(contentType) ||
    /\.m3u8(\?|$)/i.test(finalUrl) ||
    /\.m3u8(\?|$)/i.test(target);

  const baseHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": looksPlaylist ? "no-store" : "public, max-age=300",
  };

  if (looksPlaylist) {
    try {
      const text = await upstream.text();
      if (!text.includes("#EXTM3U")) {
        return res.status(502).json({ error: "not_a_playlist" });
      }
      res.set({
        ...baseHeaders,
        "Content-Type": "application/vnd.apple.mpegurl",
      });
      return res.send(rewritePlaylist(text, finalUrl, headers));
    } catch (error) {
      if (controller.signal.aborted) return;
      return res.status(502).json({ error: "playlist_read_failed", message: error?.message });
    }
  }

  const passthrough = {
    ...baseHeaders,
    "Content-Type": contentType || "application/octet-stream",
  };
  for (const name of ["content-length", "content-range", "accept-ranges", "etag"]) {
    const value = upstream.headers.get(name);
    if (value) passthrough[name] = value;
  }

  res.status(upstream.status);
  res.set(passthrough);

  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body)
    .on("error", () => {
      if (!res.headersSent) res.status(502);
      res.end();
    })
    .pipe(res);
}));

router.get("/subtitle", asyncRoute(async (req, res) => {
  const target = unb64url(req.query.u);
  if (!/^https?:\/\//i.test(target)) {
    return res.status(400).json({ error: "invalid_subtitle_url" });
  }

  try {
    const upstream = await fetch(target, {
      headers: { "User-Agent": UA, Accept: "*/*" },
      redirect: "follow",
    });
    if (!upstream.ok) return res.status(502).end();

    const raw = await upstream.text();
    const vtt = srtToVtt(raw);
    res.set({
      "Content-Type": "text/vtt; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    });
    res.send(vtt);
  } catch {
    res.status(502).end();
  }
}));

export default router;
