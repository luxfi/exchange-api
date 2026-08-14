// What an asset is worth, when this chain is not the only place that decides.
//
// A price belongs to the ASSET, not to the chain you happen to look at it from.
// So a token declares what asset it IS, and every token that names the same
// asset gets the same number. One question — "what asset is this?" — asked once
// and answered from everywhere that asset trades.
//
// Two kinds of asset, because there are two kinds of market:
//
//   'ethereum'   the world prices it. Bridged ether is ether, and one thin pool
//                here is not a second opinion. Every local route to a dollar
//                disagreed anyway — ether came out at $2,777 through WLUX and
//                $3,600 through LUSD, and LUX itself read $0.00061 against LUSD
//                and $0.00012 against USDT, both of which claim to be a dollar.
//
//   'zoo'        WE price it, on more than one chain. ZOO trades as the coin on
//                Zoo and as LZOO on Lux; LUX trades as the coin on Lux and as
//                ZLUX on Zoo. Each chain was answering from its own pools, so
//                the same token read $0.00000987 and $0.00002037 — twice apart,
//                and LUX/ZLUX 2.3x apart. Neither venue is right on its own: the
//                asset's price is what all of its liquidity says together.
//
// Ours is a liquidity-weighted mean across the venues, so the deep pool sets the
// price and a thin one nudges it, rather than a coin flip over which chain to
// believe. Anything declaring nothing is priced by its own pools, which for a
// token that only trades here is the true and only answer.

import { cacheGet, cacheSet, TTL } from './cache'
import { NETWORKS } from './networks'

const FEED = 'https://api.coingecko.com/api/v3/simple/price'
const WORLD_KEY = 'upstream:world'
const ZERO = '0x0000000000000000000000000000000000000000'

/** Every place we price this asset: the tokens across our chains that claim it. */
function venues(asset: string): Array<{ network: string; address: string }> {
  const out: Array<{ network: string; address: string }> = []
  for (const [network, cfg] of Object.entries(NETWORKS)) {
    for (const t of cfg.tokens) {
      if (t.upstream === asset) {
        out.push({ network, address: t.address.toLowerCase() })
      }
    }
  }
  return out
}

/** An asset we price ourselves is one at least one of our chains claims. */
const isOurs = (asset: string): boolean => venues(asset).length > 0 && !asset.includes('-') && asset === asset.toLowerCase() && !!NETWORKS[asset]

/**
 * USD prices for the assets named, keyed by the name given.
 *
 * One request to the world for the world's assets; one per venue for ours, run
 * together. An unreachable source contributes nothing rather than raising, and
 * the caller falls back to the local pool price — a stale number beats a blank
 * page, and this is a display price, not a settlement one.
 */
export async function upstreamPrices(ids: string[]): Promise<Map<string, number>> {
  const wanted = [...new Set(ids)].filter(Boolean)
  if (wanted.length === 0) {
    return new Map()
  }
  const mine = wanted.filter(isOurs)
  const theirs = wanted.filter((id) => !isOurs(id))

  const [world, ours] = await Promise.all([
    worldPrices(theirs),
    Promise.all(mine.map(async (id) => [id, await ourPrice(id)] as const)),
  ])
  for (const [id, price] of ours) {
    if (price !== undefined) {
      world.set(id, price)
    }
  }
  return world
}

/** What the world pays, for the assets the world knows. */
async function worldPrices(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) {
    return new Map()
  }
  const cached = cacheGet(WORLD_KEY) as Record<string, number> | null
  if (cached) {
    return new Map(Object.entries(cached))
  }
  const url = `${FEED}?ids=${encodeURIComponent(ids.sort().join(','))}&vs_currencies=usd`
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
    cacheSet(WORLD_KEY, prices, TTL.SHORT)
    return new Map(Object.entries(prices))
  } catch (e) {
    console.error('upstream prices unavailable, falling back to pool prices:', e)
    return new Map()
  }
}

/** One venue's opinion: what it says the asset is worth, and how much backs it. */
async function quote(v: { network: string; address: string }): Promise<{ usd: number; weight: number } | undefined> {
  const isCoin = v.address === ZERO
  const query = isCoin
    ? `{ bundle(id: "1") { ethPriceUSD } factories(first: 1) { totalValueLockedUSD } }`
    : `{ bundle(id: "1") { ethPriceUSD } tokens(first: 1, where: { id: "${v.address}" }) { derivedETH totalValueLockedUSD } }`
  try {
    const res = await fetch(NETWORKS[v.network].subgraphUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(4000),
    })
    const data = ((await res.json()) as any)?.data
    const coin = parseFloat(data?.bundle?.ethPriceUSD ?? '')
    if (!Number.isFinite(coin) || coin <= 0) {
      return undefined
    }
    const usd = isCoin ? coin : parseFloat(data?.tokens?.[0]?.derivedETH ?? '') * coin
    if (!Number.isFinite(usd) || usd <= 0) {
      return undefined
    }
    const held = parseFloat(
      (isCoin ? data?.factories?.[0]?.totalValueLockedUSD : data?.tokens?.[0]?.totalValueLockedUSD) ?? '',
    )
    // A venue with no value locked still has an opinion, just the quietest one.
    return { usd, weight: Number.isFinite(held) && held > 0 ? held : 1 }
  } catch (e) {
    console.error(`upstream ${v.network}:${v.address} unavailable:`, e)
    return undefined
  }
}

/**
 * What our own chains say an asset is worth, weighted by the liquidity behind
 * each answer.
 *
 * A single venue is not the asset's price — ZOO reads twice as much on Lux as on
 * Zoo — and an unweighted mean would let a pool holding a few dollars move the
 * number as much as one holding a quarter of a million. Weighting by value
 * locked makes the deep market decide and the thin one nudge.
 */
async function ourPrice(asset: string): Promise<number | undefined> {
  const key = `upstream:${asset}`
  const cached = cacheGet(key) as number | null
  if (cached !== null) {
    return cached
  }
  const quotes = (await Promise.all(venues(asset).map(quote))).filter(
    (q): q is { usd: number; weight: number } => !!q,
  )
  if (quotes.length === 0) {
    return undefined
  }
  const weight = quotes.reduce((s, q) => s + q.weight, 0)
  const price = quotes.reduce((s, q) => s + q.usd * q.weight, 0) / weight
  if (!Number.isFinite(price) || price <= 0) {
    return undefined
  }
  cacheSet(key, price, TTL.SHORT)
  return price
}
