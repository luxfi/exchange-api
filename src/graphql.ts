import { Request, Response } from 'express'
import fetch from 'node-fetch'
import { cacheGet, cacheSet, TTL } from './cache'
import { getBlockscoutTokens, getSubgraphTokens, getSubgraphPairs, getBundle, getSubgraphSwaps, getSubgraphV3Pools, getSubgraphV3Tokens, getV3Bundle, getSubgraphV3Swaps } from './blockscout'
import { getTokenMeta, LUX_TOKENS } from './lux-tokens'

// The native Lux graph engine (luxfi/graph in the explorer) is the single
// source of truth. Raw subgraph queries (Trade page: { pools swaps poolDayDatas
// ... }) and any operation we don't special-case are forwarded here verbatim —
// the engine resolves uniswap-v2/v3-shaped fields directly. This REPLACES the
// dead Uniswap hosted gateway, which returned HTML and produced the
// "Upstream API unavailable" markets failure.
const NATIVE_GRAPH = process.env.SUBGRAPH_URL ||
  'http://explorer.lux-mainnet.svc:8090/v1/graph/cchain/amm/graphql'

// Chains we special-case with shaped Token/V2Pair/V3Pool responses. Everything
// else (and raw subgraph queries) is forwarded to the native graph as-is.
const NATIVE_CHAINS = new Set(['LUX', 'ZOO'])

function isNativeChainQuery(body: any): string | null {
  const vars = body.variables || {}
  // Check common variable patterns
  if (vars.chain && NATIVE_CHAINS.has(vars.chain)) return vars.chain
  if (vars.chains && Array.isArray(vars.chains)) {
    const native = vars.chains.find((c: string) => NATIVE_CHAINS.has(c))
    if (native) return native
  }
  return null
}

function extractOperationName(body: any): string {
  if (body.operationName) return body.operationName
  const match = body.query?.match(/(?:query|mutation)\s+(\w+)/)
  return match?.[1] || 'unknown'
}

// Forward a GraphQL body verbatim to the native graph engine. The engine speaks
// the uniswap-v2/v3 schema, so the FE's raw queries resolve unchanged. Only the
// query + variables are forwarded — never client headers — so this cannot be
// turned into an SSRF/open-proxy: the target URL is fixed server-side config.
async function proxyToNativeGraph(body: any): Promise<any> {
  const cacheKey = `native:${JSON.stringify(body)}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  try {
    const res = await fetch(NATIVE_GRAPH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: body?.query, variables: body?.variables }),
      signal: AbortSignal.timeout(15000),
    })
    const data = await res.json()
    cacheSet(cacheKey, data, TTL.PROXY)
    return data
  } catch (e) {
    console.error('Native graph query failed:', e)
    // Fail typed-empty, never with a dead-upstream error string. The FE renders
    // an empty market list rather than an error toast.
    return { data: null }
  }
}

// Build a Uniswap-schema Token response from our data
function buildTokenResponse(address: string, chain: string, opts: {
  symbol?: string
  name?: string
  decimals?: number
  derivedETH?: string
  volumeUSD?: string
  totalLiquidity?: string
  logoUrl?: string | null
  ethPrice?: number
} = {}): any {
  const id = `${chain}_${address}`
  const ethPrice = opts.ethPrice || 0
  const derivedETH = parseFloat(opts.derivedETH || '0')

  // Force stablecoins to $1 (subgraph prices them through wrong pool paths)
  const sym = (opts.symbol || '').toUpperCase()
  const isStablecoin = ['USDT', 'USDC', 'LUSD', 'DAI', 'BUSD'].includes(sym)
  let priceUSD = isStablecoin ? 1.0 : derivedETH * ethPrice
  // Cap insane prices (decimal overflow artifacts from small pools)
  if (priceUSD > 1e12) priceUSD = 0
  let volumeUSD = parseFloat(opts.volumeUSD || '0')
  // Cap insane volumes (subgraph decimal overflow artifacts)
  if (volumeUSD > 1e12) volumeUSD = 0
  // totalLiquidity from subgraph is already in USD (totalValueLockedUSD)
  let tvlUSD = parseFloat(opts.totalLiquidity || '0')
  if (tvlUSD > 1e12) tvlUSD = 0

  return {
    __typename: 'Token',
    id,
    address: address === '0x0000000000000000000000000000000000000000' ? null : address,
    chain,
    symbol: opts.symbol || 'UNKNOWN',
    name: opts.name || 'Unknown Token',
    decimals: opts.decimals || 18,
    standard: 'ERC20',
    market: {
      __typename: 'TokenMarket',
      id: `${id}_market`,
      totalValueLocked: { __typename: 'Amount', id: `${id}_tvl`, value: tvlUSD, currency: 'USD' },
      price: { __typename: 'Amount', id: `${id}_price`, value: priceUSD, currency: 'USD' },
      pricePercentChange: { __typename: 'Amount', id: `${id}_pct`, currency: 'USD', value: 0 },
      volume: { __typename: 'Amount', id: `${id}_vol`, value: volumeUSD, currency: 'USD' },
      priceHistory: [],
    },
    project: {
      __typename: 'TokenProject',
      id: `${id}_project`,
      logoUrl: opts.logoUrl || null,
      safetyLevel: 'VERIFIED',
    },
  }
}

// Handle topTokens query for Lux/Zoo
async function handleTopTokens(chain: string): Promise<any> {
  // Try V3 bundle first (more active), fallback to V2
  const [v3Bundle, v2Bundle] = await Promise.all([getV3Bundle(), getBundle()])
  const ethPrice = v3Bundle ? parseFloat(v3Bundle.ethPriceUSD) : (v2Bundle ? parseFloat(v2Bundle.ethPrice) : 0)

  // Get tokens from both V2 and V3 subgraphs
  const [v2Tokens, v3Tokens] = await Promise.all([getSubgraphTokens(100), getSubgraphV3Tokens(100)])

  // Merge tokens by address (V3 data takes priority, higher volume)
  const tokenMap = new Map<string, any>()
  for (const t of v2Tokens) {
    tokenMap.set(t.id.toLowerCase(), { ...t, source: 'v2' })
  }
  for (const t of v3Tokens) {
    const existing = tokenMap.get(t.id.toLowerCase())
    if (!existing || parseFloat(t.volumeUSD || '0') > parseFloat(existing.tradeVolumeUSD || existing.volumeUSD || '0')) {
      tokenMap.set(t.id.toLowerCase(), { ...t, source: 'v3' })
    }
  }

  const mergedTokens = Array.from(tokenMap.values())

  if (mergedTokens.length > 0) {
    const tokens = mergedTokens.map(t => {
      const meta = getTokenMeta(t.id)
      const volume = t.source === 'v3' ? t.volumeUSD : t.tradeVolumeUSD
      const tvl = t.source === 'v3' ? t.totalValueLockedUSD : t.totalLiquidity
      return buildTokenResponse(t.id, chain, {
        symbol: meta?.symbol || t.symbol,
        name: meta?.name || t.name,
        decimals: meta?.decimals ?? parseInt(t.decimals),
        derivedETH: t.derivedETH,
        volumeUSD: volume || '0',
        totalLiquidity: tvl || '0',
        logoUrl: meta?.logoUrl || null,
        ethPrice,
      })
    })

    // Add native LUX token at top
    const nativeLux = buildTokenResponse('0x0000000000000000000000000000000000000000', chain, {
      symbol: 'LUX',
      name: 'Lux',
      decimals: 18,
      derivedETH: '1',
      volumeUSD: '0',
      totalLiquidity: '0',
      logoUrl: 'https://explore.lux.network/assets/lux_logo.svg',
      ethPrice,
    })

    return { data: { topTokens: [nativeLux, ...tokens] } }
  }

  // Fallback: use Blockscout + known token list
  const blockscoutTokens = await getBlockscoutTokens()
  const tokens = LUX_TOKENS.map(t => {
    const bs = blockscoutTokens.find(b => b.address_hash?.toLowerCase() === t.address.toLowerCase())
    return buildTokenResponse(t.address, chain, {
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      logoUrl: t.logoUrl,
      volumeUSD: bs?.volume_24h || '0',
      ethPrice,
    })
  })

  return { data: { topTokens: tokens } }
}

// Handle token query for a specific address
async function handleToken(chain: string, address: string | null): Promise<any> {
  const [v3Bundle, v2Bundle] = await Promise.all([getV3Bundle(), getBundle()])
  const ethPrice = v3Bundle ? parseFloat(v3Bundle.ethPriceUSD) : (v2Bundle ? parseFloat(v2Bundle.ethPrice) : 0)

  // Native token
  if (!address || address === '0x0000000000000000000000000000000000000000') {
    return {
      data: {
        token: buildTokenResponse('0x0000000000000000000000000000000000000000', chain, {
          symbol: chain === 'LUX' ? 'LUX' : 'ZOO',
          name: chain === 'LUX' ? 'Lux' : 'Zoo',
          decimals: 18,
          derivedETH: '1',
          logoUrl: 'https://explore.lux.network/assets/lux_logo.svg',
          ethPrice,
        }),
      },
    }
  }

  const meta = getTokenMeta(address)
  const blockscoutTokens = await getBlockscoutTokens()
  const bs = blockscoutTokens.find(t => t.address_hash?.toLowerCase() === address.toLowerCase())
  const subgraphTokens = await getSubgraphTokens(100)
  const sg = subgraphTokens.find(t => t.id.toLowerCase() === address.toLowerCase())

  return {
    data: {
      token: buildTokenResponse(address, chain, {
        symbol: sg?.symbol || bs?.symbol || meta?.symbol || 'UNKNOWN',
        name: sg?.name || bs?.name || meta?.name || 'Unknown Token',
        decimals: sg ? parseInt(sg.decimals) : meta?.decimals || 18,
        derivedETH: sg?.derivedETH || '0',
        volumeUSD: sg?.tradeVolumeUSD || bs?.volume_24h || '0',
        totalLiquidity: sg?.totalLiquidity || '0',
        logoUrl: meta?.logoUrl || bs?.icon_url || null,
        ethPrice,
      }),
    },
  }
}

// Handle topV2Pairs query
async function handleTopV2Pairs(chain: string): Promise<any> {
  const pairs = await getSubgraphPairs(50)
  const bundle = await getBundle()
  const ethPrice = bundle ? parseFloat(bundle.ethPrice) : 0

  const v2Pairs = pairs.map(p => {
    const meta0 = getTokenMeta(p.token0.id)
    const meta1 = getTokenMeta(p.token1.id)
    return {
      __typename: 'V2Pair',
      address: p.id,
      chain,
      protocolVersion: 'V2',
      token0: buildTokenResponse(p.token0.id, chain, {
        symbol: p.token0.symbol,
        name: p.token0.name,
        decimals: parseInt(p.token0.decimals),
        derivedETH: p.token0.derivedETH,
        logoUrl: meta0?.logoUrl || null,
        ethPrice,
      }),
      token1: buildTokenResponse(p.token1.id, chain, {
        symbol: p.token1.symbol,
        name: p.token1.name,
        decimals: parseInt(p.token1.decimals),
        derivedETH: p.token1.derivedETH,
        logoUrl: meta1?.logoUrl || null,
        ethPrice,
      }),
      token0Supply: parseFloat(p.reserve0),
      token1Supply: parseFloat(p.reserve1),
      totalLiquidity: { __typename: 'Amount', id: `${p.id}_tvl`, value: parseFloat(p.reserveUSD), currency: 'USD' },
      cumulativeVolume: { __typename: 'Amount', id: `${p.id}_vol`, value: parseFloat(p.volumeUSD), currency: 'USD' },
      txCount: parseInt(p.txCount),
    }
  })

  return { data: { topV2Pairs: v2Pairs } }
}

// Handle topV3Pools — real V3 pools from subgraph
async function handleTopV3Pools(chain: string): Promise<any> {
  const pools = await getSubgraphV3Pools(50)
  const [v3Bundle, v2Bundle] = await Promise.all([getV3Bundle(), getBundle()])
  const ethPrice = v3Bundle ? parseFloat(v3Bundle.ethPriceUSD) : (v2Bundle ? parseFloat(v2Bundle.ethPrice) : 0)

  const v3Pools = pools.map(p => {
    const meta0 = getTokenMeta(p.token0.id)
    const meta1 = getTokenMeta(p.token1.id)
    return {
      __typename: 'V3Pool',
      address: p.id,
      chain,
      protocolVersion: 'V3',
      feeTier: parseInt(p.feeTier),
      token0: buildTokenResponse(p.token0.id, chain, {
        symbol: p.token0.symbol,
        name: p.token0.name,
        decimals: parseInt(p.token0.decimals),
        derivedETH: p.token0.derivedETH,
        logoUrl: meta0?.logoUrl || null,
        ethPrice,
      }),
      token1: buildTokenResponse(p.token1.id, chain, {
        symbol: p.token1.symbol,
        name: p.token1.name,
        decimals: parseInt(p.token1.decimals),
        derivedETH: p.token1.derivedETH,
        logoUrl: meta1?.logoUrl || null,
        ethPrice,
      }),
      token0Supply: parseFloat(p.totalValueLockedToken0),
      token1Supply: parseFloat(p.totalValueLockedToken1),
      totalLiquidity: { __typename: 'Amount', id: `${p.id}_tvl`, value: parseFloat(p.totalValueLockedUSD), currency: 'USD' },
      cumulativeVolume: { __typename: 'Amount', id: `${p.id}_vol`, value: parseFloat(p.volumeUSD), currency: 'USD' },
      txCount: parseInt(p.txCount),
    }
  })

  return { data: { topV3Pools: v3Pools } }
}

// Handle v2Transactions / v3Transactions
async function handleTransactions(chain: string): Promise<any> {
  const swaps = await getSubgraphSwaps(50)
  const bundle = await getBundle()
  const ethPrice = bundle ? parseFloat(bundle.ethPrice) : 0

  const txs = swaps.map(s => ({
    __typename: 'PoolTransaction',
    hash: s.id.split('-')[0] || s.id,
    timestamp: parseInt(s.timestamp),
    chain,
    token0: {
      __typename: 'Token',
      id: `${chain}_${s.pair?.token0?.symbol || '?'}`,
      symbol: s.pair?.token0?.symbol || '?',
      address: null,
      chain,
    },
    token1: {
      __typename: 'Token',
      id: `${chain}_${s.pair?.token1?.symbol || '?'}`,
      symbol: s.pair?.token1?.symbol || '?',
      address: null,
      chain,
    },
    token0Quantity: Math.abs(parseFloat(s.amount0In) - parseFloat(s.amount0Out)).toString(),
    token1Quantity: Math.abs(parseFloat(s.amount1In) - parseFloat(s.amount1Out)).toString(),
    usdValue: { __typename: 'Amount', id: s.id, value: parseFloat(s.amountUSD), currency: 'USD' },
    type: 'SWAP',
    account: s.sender,
  }))

  return { data: { v2Transactions: txs } }
}

export async function handleGraphQL(req: Request, res: Response): Promise<void> {
  const body = req.body
  const opName = extractOperationName(body)
  const nativeChain = isNativeChainQuery(body)

  // Not a special-cased Lux/Zoo operation (or a raw subgraph query): forward to
  // the native graph engine, which resolves uniswap-v2/v3-shaped fields directly.
  if (!nativeChain) {
    const result = await proxyToNativeGraph(body)
    res.json(result)
    return
  }

  console.log(`[native] ${opName} chain=${nativeChain}`)

  try {
    let result: any

    switch (opName) {
      case 'TopTokens100':
      case 'TopTokens':
      case 'TopTokensSparkline':
        result = await handleTopTokens(nativeChain)
        break

      case 'Token':
      case 'TokenPrice':
      case 'SimpleToken':
        result = await handleToken(nativeChain, body.variables?.address || null)
        break

      case 'TopV2Pairs':
        result = await handleTopV2Pairs(nativeChain)
        break

      case 'TopV3Pools':
        result = await handleTopV3Pools(nativeChain)
        break

      case 'V2Transactions':
      case 'V3Transactions':
        result = await handleTransactions(nativeChain)
        break

      case 'HistoricalProtocolVolume':
      case 'DailyProtocolTvl':
        result = { data: { historicalProtocolVolume: [], dailyProtocolTvl: [] } }
        break

      case 'IsV3SubgraphStale':
        result = { data: { isV3SubgraphStale: false } }
        break

      default:
        // Unhandled named op — forward to the native graph engine.
        console.log(`[native] unhandled op=${opName}, forwarding to native graph`)
        result = await proxyToNativeGraph(body)
        break
    }

    res.json(result)
  } catch (e) {
    console.error(`[native] error handling ${opName}:`, e)
    // Fall back to the native graph on error, never to a dead external proxy.
    const result = await proxyToNativeGraph(body)
    res.json(result)
  }
}
