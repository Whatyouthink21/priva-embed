/**
 * Viduki session handshake (the encrypted half of the 1flex engine).
 *
 * Ported from Zenda-Cross/vega-providers (providers/1flex/crypto.ts). The
 * algorithms live inside the sealed WASM module in ./blobs.js, so this file only
 * does the marshalling: Altcha proof-of-work, then a WASM-sealed envelope per
 * backend.
 *
 * Differences from the original are deliberate and small:
 *   - SHA-256 comes from node:crypto instead of a hand-rolled implementation.
 *   - base64/hex helpers use Buffer.
 *   - HTTP is injected (`getJson(url, { headers, timeout, signal })`).
 */

import crypto from "node:crypto";
import { getJson } from "../../lib/http.js";
import { VIDUKI_WASM_B64 } from "./blobs.js";

/* --------------------------------- helpers -------------------------------- */

export function base64ToBytes(b64) {
  return new Uint8Array(Buffer.from(String(b64), "base64"));
}

export function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

export function hexToBytes(hex) {
  return new Uint8Array(Buffer.from(String(hex), "hex"));
}

export function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

/**
 * Solve an Altcha proof-of-work challenge: find the number whose
 * sha256(salt + n) equals the challenge, then return the base64 payload the API
 * expects in the X-Altcha header.
 */
export function solveAltcha(challengeData) {
  const { algorithm, challenge, maxnumber, salt, signature } = challengeData || {};
  if (!challenge || salt === undefined) return null;
  const max = Number(maxnumber) || 100000;
  const started = Date.now();
  for (let i = 0; i <= max; i += 1) {
    if (sha256Hex(salt + i) === challenge) {
      return bytesToBase64(
        Buffer.from(
          JSON.stringify({
            algorithm,
            challenge,
            number: i,
            salt,
            signature,
            took: Date.now() - started,
          }),
        ),
      );
    }
  }
  return null;
}

/* ------------------------------ viduki module ----------------------------- */

/** Export names inside the Viduki WASM build (they change between releases). */
export const VIDUKI_EXPORTS = {
  alloc: "_efec",
  reset: "_0ZB8",
  writeByte: "_Zcyc",
  readByte: "_bZwV",
  decryptPepper: "_qViy",
  decryptEnvelope: "_G3J7",
};

let vidukiInstance = null;
let vidukiLoading = null;

async function getVidukiWasm() {
  if (vidukiInstance) return vidukiInstance;
  if (!vidukiLoading) {
    vidukiLoading = (async () => {
      try {
        const bytes = base64ToBytes(VIDUKI_WASM_B64);
        const { instance } = await WebAssembly.instantiate(bytes, {
          env: {
            abort: () => {
              throw new Error("viduki wasm abort");
            },
          },
        });
        const exports = instance.exports;
        // Guard: a rebuilt module with renamed exports must fail loudly, not
        // silently return an empty source list forever.
        for (const name of Object.values(VIDUKI_EXPORTS)) {
          if (typeof exports[name] !== "function") {
            throw new Error(`viduki wasm is missing export ${name}`);
          }
        }
        vidukiInstance = exports;
        return exports;
      } catch {
        return null;
      } finally {
        vidukiLoading = null;
      }
    })();
  }
  return vidukiLoading;
}

const VIDUKI_HEADERS = {
  Referer: "https://www.viduki.net/",
  Origin: "https://www.viduki.net",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

let cachedNonce = null;
let pepperLoadedAt = 0;
let inFlightSession = null;

const SESSION_TTL_MS = 240 * 1000;

function writeBytes(wasm, bytes) {
  const ptr = wasm[VIDUKI_EXPORTS.alloc](bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    wasm[VIDUKI_EXPORTS.writeByte](ptr, i, bytes[i]);
  }
  return ptr;
}

function readBytes(wasm, ptr, len) {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) out[i] = wasm[VIDUKI_EXPORTS.readByte](ptr, i);
  return out;
}

/**
 * Altcha challenge -> bootstrap nonce -> second challenge -> pepper key, then
 * decrypt the pepper in WASM to derive the session nonce used on stream calls.
 */
export async function ensureVidukiSession(wasm, { signal } = {}) {
  const now = Date.now();
  if (cachedNonce && now - pepperLoadedAt < SESSION_TTL_MS) return cachedNonce;
  if (inFlightSession) return inFlightSession;

  inFlightSession = (async () => {
    try {
      const challenge1 = await getJson("https://api.viduki.net/altcha-challenge", {
        headers: VIDUKI_HEADERS,
        timeout: 4000,
        signal,
      });
      const altcha1 = solveAltcha(challenge1);
      if (!altcha1) return null;

      const bootstrap = await getJson("https://api.viduki.net/bootstrap", {
        headers: { ...VIDUKI_HEADERS, "X-Altcha": altcha1 },
        timeout: 4000,
        signal,
      });
      const nonce = bootstrap?.n;
      if (!nonce) return null;

      const challenge2 = await getJson("https://api.viduki.net/altcha-challenge", {
        headers: VIDUKI_HEADERS,
        timeout: 4000,
        signal,
      });
      const altcha2 = solveAltcha(challenge2);
      if (!altcha2) return null;

      const pepper = await getJson("https://api.viduki.net/pepper-key", {
        headers: { ...VIDUKI_HEADERS, Accept: "application/json", "X-Nonce": nonce, "X-Altcha": altcha2 },
        timeout: 4000,
        signal,
      });
      if (!pepper || !pepper.bucket) return null;

      wasm[VIDUKI_EXPORTS.reset]();

      const nonceBuf = new Uint8Array(8);
      new DataView(nonceBuf.buffer).setBigInt64(0, BigInt(pepper.bucket), false);

      wasm[VIDUKI_EXPORTS.decryptPepper](
        writeBytes(wasm, hexToBytes(nonce)),
        hexToBytes(nonce).length,
        writeBytes(wasm, nonceBuf),
        8,
        writeBytes(wasm, hexToBytes(pepper.iv)),
        hexToBytes(pepper.iv).length,
        writeBytes(wasm, hexToBytes(pepper.ct)),
        hexToBytes(pepper.ct).length,
        writeBytes(wasm, hexToBytes(pepper.tag)),
        hexToBytes(pepper.tag).length,
      );

      cachedNonce = nonce;
      pepperLoadedAt = Date.now();
      return nonce;
    } catch {
      return null;
    } finally {
      inFlightSession = null;
    }
  })();

  return inFlightSession;
}

export function resetVidukiSession() {
  cachedNonce = null;
  pepperLoadedAt = 0;
}

function streamTypeOf(url) {
  return String(url || "").includes(".m3u8") ? "hls" : "mp4";
}

/** Viduki exposes four backends; Sherry is the 720p direct one. */
export const VIDUKI_SERVERS = ["Sherry", "Jill", "Ada", "Ethan"];

export async function extractVidukiStreams({
  tmdbId,
  season = 1,
  episode = 1,
  isMovie,
  signal,
  timeout = 6000,
}) {
  const wasm = await getVidukiWasm();
  if (!wasm) return [];

  const nonce = await ensureVidukiSession(wasm, { signal });
  if (!nonce) return [];

  const endpointFor = (srv) =>
    isMovie
      ? `https://api.viduki.net/main/movie/${tmdbId}?srv=${srv}`
      : `https://api.viduki.net/main/tv/${tmdbId}/${season}/${episode}?srv=${srv}`;

  const envelopes = await Promise.all(
    VIDUKI_SERVERS.map(async (srv) => {
      try {
        const clientNonce = randomHex(16);
        const requestId = randomHex(16);
        const env = await getJson(endpointFor(srv), {
          headers: {
            ...VIDUKI_HEADERS,
            Accept: "application/json",
            "X-Nonce": nonce,
            "X-Client-Nonce": clientNonce,
            "X-Request-Id": requestId,
          },
          timeout,
          signal,
        });
        return { srv, clientNonce, requestId, env };
      } catch {
        return null;
      }
    }),
  );

  const streams = [];

  // WASM decryption is sequential: the module keeps one shared scratch buffer.
  for (const item of envelopes) {
    if (!item?.env?.ct) continue;
    const { srv, clientNonce, requestId, env } = item;
    try {
      const cNonce = hexToBytes(clientNonce);
      const sNonce = hexToBytes(env.sn);
      const tbBuf = new Uint8Array(8);
      new DataView(tbBuf.buffer).setBigInt64(0, BigInt(env.tb), false);
      const rId = hexToBytes(requestId);
      const iv2 = hexToBytes(env.iv2);
      const wk = hexToBytes(env.wk);
      const tag2 = hexToBytes(env.tag2);
      const iv1 = hexToBytes(env.iv1);
      const ct = hexToBytes(env.ct);
      const tag1 = hexToBytes(env.tag1);

      const outPtr = wasm[VIDUKI_EXPORTS.alloc](ct.length);
      const length = wasm[VIDUKI_EXPORTS.decryptEnvelope](
        writeBytes(wasm, cNonce),
        cNonce.length,
        writeBytes(wasm, sNonce),
        sNonce.length,
        writeBytes(wasm, tbBuf),
        8,
        writeBytes(wasm, rId),
        rId.length,
        writeBytes(wasm, iv2),
        iv2.length,
        writeBytes(wasm, wk),
        wk.length,
        writeBytes(wasm, tag2),
        tag2.length,
        writeBytes(wasm, iv1),
        iv1.length,
        writeBytes(wasm, ct),
        ct.length,
        writeBytes(wasm, tag1),
        tag1.length,
        outPtr,
      );

      if (!(length > 0)) continue;
      const json = JSON.parse(new TextDecoder().decode(readBytes(wasm, outPtr, length)));
      const url = json?.stream?.url;
      if (!url) continue;

      streams.push({
        server: srv,
        label: `${srv === "Sherry" ? 720 : 1080}p`,
        url,
        type: streamTypeOf(url),
        quality: srv === "Sherry" ? "720" : "1080",
        headers: VIDUKI_HEADERS,
      });
    } catch {
      /* one bad envelope must not lose the others */
    }
  }

  return streams;
}
