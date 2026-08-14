// What an asset is worth off this chain.
//
// A token that represents something traded elsewhere — ETH, BTC, SOL, a dollar
// — has a price the world already agrees on, and one thin pool here is not a
// second opinion on it.
//
// These assets trade, heavily: 435,444 swaps across seventeen pools on the Lux
// C-Chain, 145,386 of them in WLUX/LETH alone. But every route to a dollar
// disagrees. Ether prices at $2,777 through WLUX and $3,600 through LUSD; LUX
// itself is $0.00061 against LUSD and $0.00012 against USDT, and both of those
// claim to be a dollar. Pick a path and you have picked a number.
//
// So the assets that stand for an upstream one declare which one (see
// `upstream` in lux-tokens.ts) and take its price from here — one answer,
// independent of which pool a route happened to cross. Everything else — LUX,
// LZOO, anything that only trades here — is priced by its pools, which for
// those is the true and only answer.

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
