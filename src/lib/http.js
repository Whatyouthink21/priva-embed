const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const DESKTOP_UA = UA;

export class HttpError extends Error {
  constructor(message, status, url) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

/**
 * Per-request abort signals layered on top of the caller's.
 *
 * Engines fan out (Nova fires nine upstream calls on one provider signal), so this
 * must not register a listener per request: Node warns past ten listeners and the
 * peak concurrency alone crosses that. AbortSignal.any composes natively; the
 * listener fallback below detaches itself when the request settles.
 */
export function combineSignals(signal, timeoutMs) {
  if (typeof AbortSignal.timeout === "function") {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (!signal) return { signal: timeout, done: () => {} };
    if (typeof AbortSignal.any === "function") {
      return { signal: AbortSignal.any([signal, timeout]), done: () => {} };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  let detach = null;

  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      const onAbort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      detach = () => signal.removeEventListener("abort", onAbort);
    }
  }

  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      detach?.();
    },
  };
}

/**
 * Fetch with a hard timeout, browser-ish defaults and optional retries.
 */
export async function request(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    timeout = 14000,
    signal,
    retries = 0,
    redirect = "follow",
    responseType = "auto",
  } = options;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const { signal: abortSignal, done } = combineSignals(signal, timeout);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "User-Agent": UA,
          "Accept-Language": "en-US,en;q=0.9",
          ...headers,
        },
        body,
        redirect,
        signal: abortSignal,
      });

      if (!response.ok) {
        throw new HttpError(`HTTP ${response.status} ${response.statusText}`, response.status, url);
      }

      if (responseType === "response") return response;
      if (responseType === "buffer") return Buffer.from(await response.arrayBuffer());
      if (responseType === "text") return await response.text();

      // Some upstreams (castle/clarke) label raw ciphertext as application/json.
      // axios falls back to the raw string in that case, so do the same instead
      // of letting response.json() throw and take the whole provider down.
      const contentType = response.headers.get("content-type") || "";
      const text = await response.text();
      if (contentType.includes("json") || /^[\s]*[[{]/.test(text)) {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
      return text;
    } catch (error) {
      lastError = error;
      if (error?.name === "AbortError" || abortSignal.aborted) break;
      if (error instanceof HttpError && error.status < 500) break;
      if (attempt < retries) await sleep(350 * (attempt + 1));
    } finally {
      done();
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export const getJson = (url, options = {}) => request(url, { ...options, responseType: "auto" });
export const getText = (url, options = {}) => request(url, { ...options, responseType: "text" });
export const getBuffer = (url, options = {}) => request(url, { ...options, responseType: "buffer" });

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(typeof fallback === "function" ? fallback() : fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
