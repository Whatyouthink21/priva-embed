import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";

import { deriveKey, decryptCBC, castleSafeParse } from "../src/providers/clarke.js";
import { opensslDecrypt } from "../src/extractors/vidstuck.js";
import { srtToVtt, rewritePlaylist } from "../src/routes/proxy.js";
import { b64url, unb64url, encodeHeaders, decodeHeaders } from "../src/lib/tokens.js";
import { titleScore, pickBest } from "../src/lib/match.js";

/* --------------------------------- clarke --------------------------------- */

test("clarke derives the same AES key as the mobile client", () => {
  const key = deriveKey("ZkpBVG0qa2dmSg==");
  assert.equal(key.length, 16);
  assert.equal(key.toString("hex"), "664a41546d2a6b67664a542142674a42");
});

test("clarke decrypts an AES-128-CBC envelope", () => {
  const key = deriveKey("ZkpBVG0qa2dmSg==");
  const plain = JSON.stringify({ code: 200, msg: "OK", data: { rows: [{ id: 1, title: "Fight Club" }] } });
  const cipher = crypto.createCipheriv("aes-128-cbc", key, key);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
  const decrypted = decryptCBC(encrypted, key);
  const parsed = castleSafeParse(decrypted);
  assert.equal(parsed.code, 200);
  assert.equal(parsed.data.rows[0].title, "Fight Club");
  assert.equal(parsed.data.rows[0].id, "1");
});

test("castleSafeParse keeps 16+ digit ids exact", () => {
  const parsed = castleSafeParse('{"id":7292504997497856,"movieId":6150388343775232}');
  assert.equal(parsed.id, "7292504997497856");
  assert.equal(parsed.movieId, "6150388343775232");
});

/* -------------------------------- vidstuck -------------------------------- */

test("vidstuck openssl helper round-trips a salted payload", () => {
  const passphrase = "7f4c9e2a81d63b05c4f7a9e8126d3b50e1a8c7f23d9465ab0c6e9f1d4a7b832c";
  const salt = Buffer.from("0011223344556677", "hex");
  const derived = [];
  let previous = Buffer.alloc(0);
  while (derived.length < 48) {
    previous = crypto.createHash("md5").update(Buffer.concat([previous, Buffer.from(passphrase), salt])).digest();
    derived.push(previous);
  }
  const keyIv = Buffer.concat(derived);
  const key = keyIv.subarray(0, 32);
  const iv = keyIv.subarray(32, 48);
  const secret = "/stream/abc/index.m3u8?token=xyz";
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const payload = Buffer.concat([
    Buffer.from("Salted__", "latin1"),
    salt,
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]).toString("base64");

  assert.equal(opensslDecrypt(payload, passphrase), secret);
  assert.equal(opensslDecrypt("bm90LWEtcGF5bG9hZA==", passphrase), "");
});

/* --------------------------------- proxy ---------------------------------- */

test("srt is converted to vtt", () => {
  const srt = "1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nWorld\r\n";
  const vtt = srtToVtt(srt);
  assert.ok(vtt.startsWith("WEBVTT"));
  assert.ok(vtt.includes("00:00:01.000 --> 00:00:02.500"));
  assert.ok(!vtt.includes(","));
});

test("playlist rewriting proxies every child resource", () => {
  const playlist = [
    "#EXTM3U",
    "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"",
    "#EXT-X-STREAM-INF:BANDWIDTH=800000",
    "720/index.m3u8",
    "#EXTINF:6.0,",
    "https://cdn.example.com/seg/1.ts",
  ].join("\n");

  const output = rewritePlaylist(playlist, "https://host.example.com/path/master.m3u8", {
    Referer: "https://host.example.com/",
  });

  assert.ok(output.startsWith("#EXTM3U"));
  const proxied = [...output.matchAll(/\/api\/stream\?u=([^"&\s]+)/g)].map((match) => unb64url(match[1]));
  assert.deepEqual(proxied, [
    "https://host.example.com/path/key.bin",
    "https://host.example.com/path/720/index.m3u8",
    "https://cdn.example.com/seg/1.ts",
  ]);
  assert.ok(output.includes('URI="/api/stream?u='));
});

/* --------------------------------- tokens --------------------------------- */

test("url tokens survive awkward characters", () => {
  const value = "https://cdn.example.com/a/b?c=d&e=ü#frag";
  assert.equal(unb64url(b64url(value)), value);
});

test("header tokens round-trip and drop junk", () => {
  const token = encodeHeaders({ Referer: "https://x.test/", Origin: "https://x.test", Bad: undefined });
  assert.deepEqual(decodeHeaders(token), { Referer: "https://x.test/", Origin: "https://x.test" });
  assert.deepEqual(decodeHeaders("garbage!!"), {});
});

/* --------------------------------- match ---------------------------------- */

test("title scoring prefers exact matches", () => {
  assert.equal(titleScore("Fight Club", "Fight Club"), 100);
  assert.ok(titleScore("Fight Club (1999)", "Fight Club") > 60);
  assert.ok(titleScore("The Office US", "The Office") > 50);
});

test("pickBest respects type and year", () => {
  const candidates = [
    { id: 1, title: "Fight Club", year: 1999, kind: "movie" },
    { id: 2, title: "Fight Club", year: 2023, kind: "movie" },
    { id: 3, title: "Fight Club", year: 2021, kind: "tv" },
  ];
  const best = pickBest(candidates, "Fight Club", {
    type: "movie",
    year: 1999,
    typeOf: (item) => item.kind,
  });
  assert.equal(best.id, 1);
});

test("request() survives an upstream that mislabels ciphertext as JSON", async (t) => {
  const upstream = http.createServer((_req, res) => {
    // castle/clarke answers with raw base64 while claiming application/json
    res.writeHead(200, { "content-type": "application/json;charset=UTF-8" });
    res.end("QUKnJlY6U+abc123==");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  t.after(() => upstream.close());

  const { getJson } = await import("../src/lib/http.js");
  const body = await getJson(base);

  assert.equal(typeof body, "string", "raw ciphertext comes back as a string");
  assert.equal(body, "QUKnJlY6U+abc123==");

  // and it must still decrypt rather than throw
  const { decryptCBC, deriveKey } = await import("../src/providers/clarke.js");
  const key = deriveKey("ZkpBVG0qa2dmSg==");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, key);
  const sealed = Buffer.concat([
    cipher.update(JSON.stringify({ code: 200, data: { rows: [] } })),
    cipher.final(),
  ]).toString("base64");
  assert.equal(JSON.parse(decryptCBC(sealed, key)).code, 200);
});
