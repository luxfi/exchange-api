interface CacheEntry {
  data: any
  expires: number
}

const store = new Map<string, CacheEntry>()

// Default TTLs in seconds
export const TTL = {
  SHORT: 30,      // prices, volumes — 30s
  MEDIUM: 300,    // token lists, pool lists — 5min
  LONG: 3600,     // token metadata, logos — 1hr
  PROXY: 60,      // proxied Uniswap responses — 1min
}

export function cacheGet(key: string): any | null {
  const entry = store.get(key)
  if (!entry) return null
  if (Date.now() > entry.expires) {
    store.delete(key)
    return null
  }
  return entry.data
}

export function cacheSet(key: string, data: any, ttlSeconds: number): void {
  store.set(key, { data, expires: Date.now() + ttlSeconds * 1000 })
}

// Drop what has expired, so a key nothing asks for again is not held forever.
//
// The sweep does not hold the process open: it is housekeeping for a program
// that is running anyway, and nothing is waiting on it. Left counted, node keeps
// the event loop alive for it — a server that will not exit on a signal, and a
// test file that passes every assertion and then hangs until the runner kills it.
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of store) {
    if (now > entry.expires) store.delete(key)
  }
}, 60_000).unref()
