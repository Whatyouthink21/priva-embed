/** base64url helpers used to carry stream URLs + headers through the proxy routes. */
export function b64url(value) {
  return Buffer.from(String(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function unb64url(value) {
  if (!value) return "";
  const padded = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padding = padded.length % 4 ? "=".repeat(4 - (padded.length % 4)) : "";
  return Buffer.from(padded + padding, "base64").toString("utf8");
}

/** Turn provider headers into a compact, URL-safe blob. */
export function encodeHeaders(headers) {
  const clean = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined || value === null || value === "") continue;
    clean[key] = String(value);
  }
  return Object.keys(clean).length ? b64url(JSON.stringify(clean)) : "";
}

export function decodeHeaders(token) {
  if (!token) return {};
  try {
    const parsed = JSON.parse(unb64url(token));
    if (!parsed || typeof parsed !== "object") return {};
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (/^[a-zA-Z0-9-_]+$/.test(key)) out[key] = String(value);
    }
    return out;
  } catch {
    return {};
  }
}
