import fetch from 'node-fetch'
import { cacheGet, cacheSet, TTL } from './cache'

const BLOCKSCOUT_API = process.env.BLOCKSCOUT_API || 'https://api-explore.lux.network'

// Data source is the NATIVE Lux graph engine (luxfi/graph) embedded in the
// explorer — NOT a hosted The-Graph node and NOT Uniswap's gateway. This module
// queries ONLY the uniswap-v2/v3-compatible `amm` schema (pools, pairs, swaps,
// tokens, factories) — the native-CLOB `dex` schema (markets/fills) is routed
// separately by graphql.ts's graphEndpointFor. Both V2/V3 helpers point at the one
// `amm` subgraph; V4 swaps surface as both pools and pairs there. Override
// per-environment via SUBGRAPH_URL (same knob graphql.ts reads for AMM_GRAPH).
const AMM_GRAPH = process.env.SUBGRAPH_URL ||
  'http://explorer.lux-mainnet.svc:8090/v1/graph/cchain/amm/graphql'
const SUBGRAPH_V2_URL = AMM_GRAPH
const SUBGRAPH_V3_URL = process.env.SUBGRAPH_V3_URL || AMM_GRAPH

export interface BlockscoutToken {
  address_hash: string
  name: string
  symbol: string
  decimals: string
  exchange_rate: string | null
  holders_count: number
  total_supply: string
  volume_24h: string | null
  icon_url: string | null
  type: string
}

export async function getBlockscoutTokens(): Promise<BlockscoutToken[]> {
  const cacheKey = 'blockscout:tokens'
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  try {
    const res = await fetch(`${BLOCKSCOUT_API}/api/v2/tokens?type=ERC-20`, {
      signal: AbortSignal.timeout(5000),
    })
    const data = await res.json() as any
    const tokens = (data.items || []) as BlockscoutToken[]
    cacheSet(cacheKey, tokens, TTL.MEDIUM)
    return tokens
  } catch (e) {
    console.error('Blockscout tokens fetch failed:', e)
    return []
  }
}

export async function getBlockscoutToken(address: string): Promise<BlockscoutToken | null> {
  const tokens = await getBlockscoutTokens()
  return tokens.find(t => t.address_hash?.toLowerCase() === address.toLowerCase()) || null
}

export async function getBlockscoutStats(): Promise<any> {
  const cacheKey = 'blockscout:stats'
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  try {
    const res = await fetch(`${BLOCKSCOUT_API}/api/v2/stats`, {
      signal: AbortSignal.timeout(5000),
    })
    const data = await res.json()
    cacheSet(cacheKey, data, TTL.SHORT)
    return data
  } catch (e) {
    console.error('Blockscout stats fetch failed:', e)
    return null
  }
}

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
