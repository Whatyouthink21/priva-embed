const store = new Map();

/**
 * Small TTL cache with in-flight de-duplication.
 * Keeps the embed fast when a user switches servers or seeks around.
 */
export function cached(key, ttlMs, factory) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expires > now) {
    return hit.value;
  }
  if (hit && hit.value && typeof hit.value.then === "function") {
    return hit.value;
  }

  const value = Promise.resolve()
    .then(factory)
    .catch((error) => {
      store.delete(key);
      throw error;
    });

  store.set(key, { value, expires: now + ttlMs });
  if (store.size > 500) {
    // Drop the oldest third to keep memory bounded.
    const keys = [...store.keys()].slice(0, Math.ceil(store.size / 3));
    for (const k of keys) store.delete(k);
  }
  return value;
}

export function cacheGet(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

export function cacheSet(key, value, ttlMs) {
  store.set(key, { value: Promise.resolve(value), expires: Date.now() + ttlMs });
}

export function cacheClear(prefix = "") {
  for (const key of [...store.keys()]) {
    if (!prefix || key.startsWith(prefix)) store.delete(key);
  }
}
