// What an asset is worth off this chain.
//
// A token that represents something traded elsewhere — ETH, BTC, SOL, a dollar
// — has a price the world already agrees on, and this chain's pools are not a
// second opinion on it. Several of them were seeded at round token ratios and
// never traded: the LETH/LUSD pool quotes 0.75 and the LBTC/LUSD pool 1.5, so
// the token pages read $0.75 for ether and $1.50 for bitcoin. A pool with no
// liquidity still sets a price, and the price it sets is whatever it was
// seeded at.
//
// So the assets that stand for an upstream one declare which one (see
// `upstream` in lux-tokens.ts) and take its price from here. Everything else —
// LUX, LZOO, and anything that only trades here — is priced by its pools,
// which for those is the true and only answer.

import { cacheGet, cacheSet, TTL } from './cache'

const FEED = 'https://api.coingecko.com/api/v3/simple/price'
const CACHE_KEY = 'upstream:prices'

/**
 * USD prices for the given upstream ids, keyed by id.
 *
 * One request for all of them, cached for TTL.SHORT. A feed that is down, slow
 * or rate-limiting yields an empty map rather than an error, and the caller
 * falls back to the pool price — a stale number beats a blank page, and this
 * is a display price, not a settlement one.
 */
export async function upstreamPrices(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) {
    return new Map()
  }

  const cached = cacheGet(CACHE_KEY) as Record<string, number> | null
  if (cached) {
    return new Map(Object.entries(cached))
  }

  const url = `${FEED}?ids=${encodeURIComponent([...new Set(ids)].sort().join(','))}&vs_currencies=usd`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) {
      throw new Error(`upstream prices ${res.status}`)
    }
    const body = (await res.json()) as Record<string, { usd?: number }>
    const prices: Record<string, number> = {}
    for (const [id, quote] of Object.entries(body)) {
      if (typeof quote?.usd === 'number' && quote.usd > 0) {
        prices[id] = quote.usd
      }
    }
    cacheSet(CACHE_KEY, prices, TTL.SHORT)
    return new Map(Object.entries(prices))
  } catch (e) {
    console.error('upstream prices unavailable, falling back to pool prices:', e)
    return new Map()
  }
}
