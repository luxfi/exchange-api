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

// Periodic cleanup
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of store) {
    if (now > entry.expires) store.delete(key)
  }
}, 60_000)
