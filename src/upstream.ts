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
import { ACTIVE, NETWORKS } from './networks'

const FEED = 'https://api.coingecko.com/api/v3/simple/price'
const WORLD_KEY = 'upstream:world'
const ZERO = '0x0000000000000000000000000000000000000000'

/**
 * The assets we issue, and the chain each one calls home.
 *
 * Named here rather than inferred from the network list, because an asset and a
 * network are not the same thing and only coincidentally share a word: 'zoo'
 * happens to be both, 'lux' is an asset whose home network is called 'mainnet'.
 * Testing for a network silently answered no for LUX, so LUX and ZLUX went on
 * disagreeing while ZOO converged.
 *
 * Home is where the asset's supply is declared — its coin's row on its own
 * chain — which is what makes 2 trillion the answer on both chains rather than
 * whatever slice happens to be bridged to the one you are looking at.
 */
const ASSETS: Record<string, { home: string }> = {
  lux: { home: 'mainnet' },
  zoo: { home: 'zoo' },
}

/**
 * Every CHAIN that prices this asset — one vote each.
 *
 * A chain, not a token. Its coin and that coin's wrapper are the same asset at
 * the same price in the same pools, so listing both gave the home chain two
 * votes: ZOO weighed Zoo at $277,290 + $138,438 against Lux's $58,451, when the
 * second figure is the wrapper's share of the first.
 *
 * The wrapper is the entity that carries the price and the liquidity — a coin
 * has no pool of its own, it trades wrapped — so that row is the chain's vote
 * and the coin rides on it.
 */
function venues(asset: string): Array<{ network: string; address: string }> {
  const byNetwork = new Map<string, string>()
  for (const [network, cfg] of Object.entries(NETWORKS)) {
    // localnet is this machine's loopback. From anywhere else it is a refused
    // connection per token per poll, and it never priced anything for anyone.
    if (network === 'localnet' && cfg !== ACTIVE) {
      continue
    }
    for (const t of cfg.tokens) {
      if (t.upstream !== asset) {
        continue
      }
      const address = t.address.toLowerCase()
      // The coin defers to its wrapper; anything else is that chain's own row.
      if (address === ZERO) {
        const wrapped = cfg.contracts.WLUX?.toLowerCase()
        if (wrapped && wrapped !== ZERO && !byNetwork.has(network)) {
          byNetwork.set(network, wrapped)
        }
        continue
      }
      byNetwork.set(network, address)
    }
  }
  return [...byNetwork].map(([network, address]) => ({ network, address }))
}

/** An asset we price ourselves is one we issue. */
const isOurs = (asset: string): boolean => asset in ASSETS

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

/**
 * One chain's opinion: what it says the asset is worth, and how much of THAT
 * ASSET's liquidity stands behind the answer.
 *
 * The weight is the asset's own value locked, not the chain's. Weighing a coin
 * by its factory total counted every unrelated pool on that chain as evidence
 * about this one token.
 */
async function quote(v: { network: string; address: string }): Promise<{ usd: number; weight: number } | undefined> {
  const query = `{ bundle(id: "1") { ethPriceUSD } tokens(first: 1, where: { id: "${v.address}" }) { derivedETH totalValueLockedUSD } }`
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
    const usd = parseFloat(data?.tokens?.[0]?.derivedETH ?? '') * coin
    if (!Number.isFinite(usd) || usd <= 0) {
      return undefined
    }
    const held = parseFloat(data?.tokens?.[0]?.totalValueLockedUSD ?? '')
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

/**
 * What an asset we issue has minted, and how much of it is loose — from the
 * chain that declares it.
 *
 * A bridged slice is not a supply. LZOO's row on Lux holds the 10.86 billion
 * bridged there, so its page valued that as if it were the whole asset and
 * reported a fully diluted value of $221K against ZOO's $19.7M — the same token,
 * two answers, and neither the truth on its own. The asset's supply is declared
 * once, on its home chain's coin, and is 2 trillion whichever side you look from.
 */
export async function upstreamSupply(
  asset: string,
): Promise<{ totalSupply: number; circulating: number } | undefined> {
  const home = ASSETS[asset]?.home
  if (!home || !NETWORKS[home]) {
    return undefined
  }
  const key = `upstream:supply:${asset}`
  const cached = cacheGet(key) as { totalSupply: number; circulating: number } | null
  if (cached) {
    return cached
  }
  // The coin has no contract, so its figures ride on the wrapped native's row —
  // the one entity a token page opens for the chain's own coin.
  const wrapped = NETWORKS[home].contracts.WLUX?.toLowerCase()
  if (!wrapped || wrapped === ZERO) {
    return undefined
  }
  try {
    const res = await fetch(NETWORKS[home].subgraphUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ tokens(first: 1, where: { id: "${wrapped}" }) { totalSupply staked } }`,
      }),
      signal: AbortSignal.timeout(4000),
    })
    const row = ((await res.json()) as any)?.data?.tokens?.[0]
    const total = parseFloat(row?.totalSupply ?? '')
    if (!Number.isFinite(total) || total <= 0) {
      return undefined
    }
    const staked = parseFloat(row?.staked ?? '')
    const locked = Number.isFinite(staked) && staked > 0 ? Math.min(staked, total) : 0
    const out = { totalSupply: total, circulating: total - locked }
    cacheSet(key, out, TTL.SHORT)
    return out
  } catch (e) {
    console.error(`upstream supply ${asset} unavailable:`, e)
    return undefined
  }
}
