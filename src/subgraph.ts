import fetch from 'node-fetch'
import { cacheGet, cacheSet, TTL } from './cache'
import { getTokenMeta } from './lux-tokens'
import { ACTIVE } from './networks'
import { upstreamPrices } from './upstream'

// Data source is the NATIVE Lux graph engine (luxfi/graph) embedded in the
// explorer — NOT a hosted The-Graph node and NOT Uniswap's gateway. This module
// queries ONLY the uniswap-v2/v3-compatible `amm` schema (pools, pairs, swaps,
// tokens, factories) — the native-CLOB markets/orders/fills are served from the
// D-Chain read surface (dchain.ts), split by dexRouting.isDexQuery. Both V2/V3 helpers point at the one
// `amm` subgraph; V4 swaps surface as both pools and pairs there. Override
// per-environment via SUBGRAPH_URL (same knob graphql.ts reads for AMM_GRAPH).
// Three sources, three knobs — they are NOT the same schema, so one URL cannot
// serve all three:
//   SUBGRAPH_URL     the AMM graph the FE's raw /v1/graphql queries proxy to
//                    (graphql.ts). The FE sends the v3 schema.
//   SUBGRAPH_V2_URL  the v2-shaped helpers (pairs/uniswapFactories/reserveUSD).
//   SUBGRAPH_V3_URL  the v3-shaped helpers (pools/factories/bundle.ethPriceUSD).
// Each defaults to SUBGRAPH_URL so a single-graph deployment stays a single knob.
const AMM_GRAPH = process.env.SUBGRAPH_URL || ACTIVE.subgraphUrl
const SUBGRAPH_V2_URL = process.env.SUBGRAPH_V2_URL || AMM_GRAPH
const SUBGRAPH_V3_URL = process.env.SUBGRAPH_V3_URL || AMM_GRAPH

// Query a subgraph endpoint
async function querySubgraphUrl(url: string, query: string, variables?: Record<string, any>): Promise<any> {
  const cacheKey = `subgraph:${url}:${query}:${JSON.stringify(variables || {})}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10000),
    })
    const data = await res.json()
    if ((data as any).data) {
      cacheSet(cacheKey, (data as any).data, TTL.SHORT)
      return (data as any).data
    }
    return null
  } catch (e) {
    console.error('Subgraph query failed:', e)
    return null
  }
}

// Query the v2 subgraph
export async function querySubgraph(query: string, variables?: Record<string, any>): Promise<any> {
  return querySubgraphUrl(SUBGRAPH_V2_URL, query, variables)
}

// Query the v3 subgraph
export async function querySubgraphV3(query: string, variables?: Record<string, any>): Promise<any> {
  return querySubgraphUrl(SUBGRAPH_V3_URL, query, variables)
}

// Get factory stats from subgraph
export async function getFactoryStats(): Promise<any> {
  return querySubgraph(`{
    uniswapFactories(first: 1) {
      pairCount
      totalVolumeUSD
      totalLiquidityUSD
      txCount
    }
  }`)
}

// Get pairs from subgraph
export async function getSubgraphPairs(first: number = 50): Promise<any[]> {
  const data = await querySubgraph(`{
    pairs(first: ${first}, orderBy: reserveUSD, orderDirection: desc) {
      id
      token0 { id symbol name decimals derivedETH }
      token1 { id symbol name decimals derivedETH }
      reserve0
      reserve1
      reserveUSD
      volumeUSD
      token0Price
      token1Price
      txCount
    }
  }`)
  return data?.pairs || []
}

// Get bundle (ETH/LUX price) from subgraph
export async function getBundle(): Promise<{ ethPrice: string } | null> {
  const data = await querySubgraph(`{ bundle(id: "1") { ethPrice } }`)
  return data?.bundle || null
}

// Get tokens from subgraph
export async function getSubgraphTokens(first: number = 100): Promise<any[]> {
  const data = await querySubgraph(`{
    tokens(first: ${first}, orderBy: tradeVolumeUSD, orderDirection: desc) {
      id
      symbol
      name
      decimals
      derivedETH
      tradeVolumeUSD
      totalLiquidity
      txCount
    }
  }`)
  return data?.tokens || []
}

// Get swaps from v2 subgraph
export async function getSubgraphSwaps(first: number = 50): Promise<any[]> {
  const data = await querySubgraph(`{
    swaps(first: ${first}, orderBy: timestamp, orderDirection: desc) {
      id
      timestamp
      pair { token0 { symbol } token1 { symbol } }
      amount0In
      amount0Out
      amount1In
      amount1Out
      amountUSD
      sender
      to
    }
  }`)
  return data?.swaps || []
}

// V3 Subgraph queries

// Get V3 pools
export async function getSubgraphV3Pools(first: number = 50): Promise<any[]> {
  const data = await querySubgraphV3(`{
    pools(first: ${first}, orderBy: totalValueLockedUSD, orderDirection: desc) {
      id
      token0 { id symbol name decimals derivedETH }
      token1 { id symbol name decimals derivedETH }
      feeTier
      liquidity
      sqrtPrice
      tick
      totalValueLockedToken0
      totalValueLockedToken1
      totalValueLockedUSD
      volumeUSD
      txCount
    }
  }`)
  return data?.pools || []
}

// Get V3 tokens
export async function getSubgraphV3Tokens(first: number = 100): Promise<any[]> {
  const data = await querySubgraphV3(`{
    tokens(first: ${first}, orderBy: volumeUSD, orderDirection: desc) {
      id
      symbol
      name
      decimals
      derivedETH
      volumeUSD
      totalValueLockedUSD
      txCount
    }
  }`)
  return data?.tokens || []
}

// Get V3 bundle (ETH/LUX price)
export async function getV3Bundle(): Promise<{ ethPriceUSD: string } | null> {
  const data = await querySubgraphV3(`{ bundle(id: "1") { ethPriceUSD } }`)
  return data?.bundle || null
}

// Protocol-level day series from the V3 subgraph (uniswapDayDatas). One row per
// UTC day the protocol saw activity: cumulative TVL at end of day + that day's
// volume. This is the ONLY source for the explore page's TVL / 1D-volume tiles
// and the protocol charts — pool and token entities carry lifetime totals, not a
// series.
export interface ProtocolDay {
  date: number // unix seconds, start of the UTC day
  tvlUSD: number
  volumeUSD: number
  txCount: number
}

export async function getV3ProtocolDays(days: number = 1000): Promise<ProtocolDay[]> {
  const data = await querySubgraphV3(`{
    uniswapDayDatas(first: ${days}, orderBy: date, orderDirection: desc) {
      date
      tvlUSD
      volumeUSD
      txCount
    }
  }`)
  const rows: any[] = data?.uniswapDayDatas || []
  // Ascending by date, overflow-capped exactly like the token/pool numbers: a
  // tiny pool can produce a 1e30 "volume" the FE would render as the headline.
  return rows
    .map((r) => ({
      date: Number(r.date),
      tvlUSD: capUsd(r.tvlUSD),
      volumeUSD: capUsd(r.volumeUSD),
      txCount: parseInt(r.txCount || '0', 10) || 0,
    }))
    .filter((r) => Number.isFinite(r.date) && r.date > 0)
    .sort((a, b) => a.date - b.date)
}

// Get V3 swaps
export async function getSubgraphV3Swaps(first: number = 50): Promise<any[]> {
  const data = await querySubgraphV3(`{
    swaps(first: ${first}, orderBy: timestamp, orderDirection: desc) {
      id
      timestamp
      pool { token0 { symbol } token1 { symbol } }
      amount0
      amount1
      amountUSD
      sender
      origin
    }
  }`)
  return data?.swaps || []
}

// ─────────────────────────────────────────────────────────────────────────────
// getRankedTokens — the swappable, enriched, USD-priced, volume-ranked token set
// ─────────────────────────────────────────────────────────────────────────────
//
// Single source of truth for "the tradeable Lux tokens with stats". Both the
// GraphQL topTokens shaper (graphql.ts) and the Connect-RPC TokenRankings shaper
// (explore.ts) project FROM this list — neither re-derives price/volume/tvl. The
// derivation (stablecoin pin to $1, decimal-overflow caps) and the swappable
// filter (token must be token0/token1 of a real pool, excluding LP/position/vault
// tokens) live here, once.

export interface RankedToken {
  address: string // lowercase 0x… on-chain address; native LUX uses the zero sentinel
  symbol: string
  name: string
  decimals: number
  priceUSD: number
  volumeUSD: number
  tvlUSD: number
  logoUrl: string | null
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const STABLECOINS = new Set(['USDT', 'USDC', 'LUSD', 'DAI', 'BUSD'])
const OVERFLOW_CAP = 1e12 // decimal-overflow artifacts from tiny pools → drop to 0

// Parse a subgraph USD string, dropping decimal-overflow artifacts to 0. One
// definition, used by both the token derivation and the protocol day series.
export function capUsd(v: string | number | undefined | null): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '0'))
  if (!Number.isFinite(n) || n < 0 || n > OVERFLOW_CAP) return 0
  return n
}

/**
 * What one token is worth, and where that number comes from.
 *
 * Three sources, in the order they are trusted:
 *
 *   an upstream asset — ETH, BTC, a dollar — priced by the world, because a
 *   pool here is not a second opinion on ether;
 *   a dollar this chain issues, which is a peg we assert rather than observe;
 *   otherwise the pools, which for a token that only trades here are the true
 *   and only answer.
 *
 * `upstreamUsd` carries the first, resolved once per batch by the caller.
 */
export function deriveUsd(opts: {
  symbol: string
  address?: string
  derivedETH?: string
  volumeUSD?: string
  tvlUSD?: string
  ethPrice: number
  upstreamUsd?: Map<string, number>
}): { priceUSD: number; volumeUSD: number; tvlUSD: number } {
  const derivedETH = parseFloat(opts.derivedETH || '0')
  const upstream = opts.address ? getTokenMeta(opts.address)?.upstream : undefined
  const quoted = upstream ? opts.upstreamUsd?.get(upstream) : undefined

  let priceUSD = quoted ?? (STABLECOINS.has(opts.symbol.toUpperCase()) ? 1.0 : derivedETH * opts.ethPrice)
  if (priceUSD > OVERFLOW_CAP) priceUSD = 0
  let volumeUSD = parseFloat(opts.volumeUSD || '0')
  if (volumeUSD > OVERFLOW_CAP) volumeUSD = 0
  let tvlUSD = parseFloat(opts.tvlUSD || '0')
  if (tvlUSD > OVERFLOW_CAP) tvlUSD = 0
  return { priceUSD, volumeUSD, tvlUSD }
}

export async function getRankedTokens(): Promise<RankedToken[]> {
  const cacheKey = 'ranked:tokens'
  const cached = cacheGet(cacheKey) as RankedToken[] | null
  if (cached) return cached

  const [v3Bundle, v2Bundle] = await Promise.all([getV3Bundle(), getBundle()])
  const ethPrice = v3Bundle
    ? parseFloat(v3Bundle.ethPriceUSD)
    : v2Bundle
      ? parseFloat(v2Bundle.ethPrice)
      : 0

  const [v2Tokens, v3Tokens, v2Pairs, v3Pools, upstreamUsd] = await Promise.all([
    getSubgraphTokens(100),
    getSubgraphV3Tokens(100),
    getSubgraphPairs(200),
    getSubgraphV3Pools(200),
    // One request covers every asset with an upstream, so the whole ranked
    // list is priced from one snapshot and no two rows disagree about ether.
    upstreamPrices(ACTIVE.tokens.map((t) => t.upstream).filter((id): id is string => !!id)),
  ])

  // Swappable iff token is token0/token1 of a real pair/pool. Excludes the LP/pair
  // tokens, the V3 positions NFT, and vault tokens (the indexer records those as
  // ERC20 "tokens" too, but they must never appear in a swap selector).
  const tradeable = new Set<string>()
  for (const p of [...v2Pairs, ...v3Pools]) {
    if (p.token0?.id) tradeable.add(p.token0.id.toLowerCase())
    if (p.token1?.id) tradeable.add(p.token1.id.toLowerCase())
  }

  // Merge by address; V3 data wins when it carries the higher volume.
  const tokenMap = new Map<string, any>()
  for (const t of v2Tokens) tokenMap.set(t.id.toLowerCase(), { ...t, source: 'v2' })
  for (const t of v3Tokens) {
    const existing = tokenMap.get(t.id.toLowerCase())
    const tv = parseFloat(t.volumeUSD || '0')
    const ev = parseFloat(existing?.tradeVolumeUSD || existing?.volumeUSD || '0')
    if (!existing || tv > ev) tokenMap.set(t.id.toLowerCase(), { ...t, source: 'v3' })
  }

  // Keep only swappable tokens. Skip the filter entirely when no pools resolved, so
  // a subgraph hiccup degrades to "show all", never "show none".
  const merged = Array.from(tokenMap.values()).filter(
    (t) =>
      // Real-asset gate: surface a token ONLY if it is in the curated lux-tokens list.
      // The subgraph records junk/test tokens (e.g. fake USDC/USDT) as pool token0/token1;
      // without this gate they leak into TokenRankings / ExploreStats / topTokens — every
      // surface that projects from this list. The curated list is the single source of
      // truth for "real Lux token". Native LUX is added separately below.
      !!getTokenMeta(t.id) && (tradeable.size === 0 || tradeable.has(t.id.toLowerCase())),
  )

  let ranked: RankedToken[]
  if (merged.length > 0) {
    ranked = merged.map((t) => {
      const meta = getTokenMeta(t.id)
      const symbol = meta?.symbol || t.symbol || 'UNKNOWN'
      const volume = t.source === 'v3' ? t.volumeUSD : t.tradeVolumeUSD
      const tvl = t.source === 'v3' ? t.totalValueLockedUSD : t.totalLiquidity
      const usd = deriveUsd({ symbol, address: t.id, derivedETH: t.derivedETH, volumeUSD: volume, tvlUSD: tvl, ethPrice, upstreamUsd })
      return {
        address: String(t.id).toLowerCase(),
        symbol,
        name: meta?.name || t.name || 'Unknown Token',
        decimals: meta?.decimals ?? parseInt(t.decimals, 10),
        ...usd,
        logoUrl: meta?.logoUrl ?? null,
      }
    })
  } else {
    // Native graph has not indexed tokens yet: fall back to THIS network's
    // curated list, unpriced (the native graph is the only volume/price source).
    // It read LUX_TOKENS unconditionally, so zoo.exchange — whose graph is empty
    // until its AMM lands — listed Lux's WLUX, LETH, LBTC and seventeen more as
    // ZOO-chain tokens at $0 each. A network with nothing curated yet lists
    // nothing, which is the true answer.
    ranked = ACTIVE.tokens.filter((t) => t.address !== ZERO_ADDRESS).map((t) => ({
      address: t.address.toLowerCase(),
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      priceUSD: STABLECOINS.has(t.symbol.toUpperCase()) ? 1.0 : 0,
      volumeUSD: 0,
      tvlUSD: 0,
      logoUrl: t.logoUrl,
    }))
  }

  // Drop tokens with unresolvable decimals (unusable), then native LUX on top,
  // rest by volume desc.
  ranked = ranked.filter((t) => Number.isFinite(t.decimals))
  ranked.sort((a, b) => b.volumeUSD - a.volumeUSD)

  // The chain's own coin leads the list. Its identity comes from the NETWORK,
  // not from position 0 of the curated Lux list — reading that labelled the
  // native row "LUX" on every deployment, so zoo.exchange opened its token list
  // with a coin called LUX on chain ZOO. Address and decimals are the same
  // everywhere: the zero sentinel, 18.
  const result: RankedToken[] = [
    {
      address: ZERO_ADDRESS,
      symbol: ACTIVE.coin.symbol,
      name: ACTIVE.coin.name,
      decimals: 18,
      priceUSD: 0,
      volumeUSD: 0,
      tvlUSD: 0,
      logoUrl: ACTIVE.coin.logoUrl,
    },
    ...ranked.filter((t) => t.address !== ZERO_ADDRESS),
  ]

  // Never cache an empty/degraded set: a transient subgraph hiccup would otherwise
  // pin a native-only list for the whole TTL. Cache only when the graph produced
  // real tokens (more than just native LUX).
  if (result.length > 1) cacheSet(cacheKey, result, TTL.SHORT)
  return result
}
