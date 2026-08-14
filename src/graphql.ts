import { Request, Response } from 'express'
import fetch from 'node-fetch'
import { cacheGet, cacheSet, TTL } from './cache'
import { getSubgraphTokens, getSubgraphPairs, getBundle, getSubgraphSwaps, getSubgraphV3Pools, getV3Bundle, getSubgraphV3Swaps, getRankedTokens, deriveUsd } from './subgraph'
import { getTokenMeta } from './lux-tokens'
import { filterRealMarkets, type RawMarket } from './dexMarkets'
import { isDexQuery } from './dexRouting'
import { queryDChain, fetchMarkets } from './dchain'
import { ACTIVE } from './networks'
import { upstreamPrices } from './upstream'

// Real-asset gate for the AMM token/pool surfaces. The native graph indexes junk/test
// tokens (e.g. fake USDC/USDT contracts) that are NOT real Lux assets; a token surfaces
// in topTokens / V2-V3 pool lists ONLY if it is the native coin or resolves in the
// curated lux-tokens list. This is the SAME real-asset gate /v1/swappable_tokens uses —
// one definition of "real token", reused on every surface the token selector reads.
const NATIVE_ADDR = '0x0000000000000000000000000000000000000000'
const isCuratedAddress = (addr?: string | null): boolean =>
  !!addr && (addr.toLowerCase() === NATIVE_ADDR || !!getTokenMeta(addr))

// AMM_GRAPH is the native Lux graph engine's uniswap-v2/v3-shaped `amm` schema
// (pools/pairs/swaps/tokens/factories) embedded in the explorer — the single
// source for the FE's AMM surfaces. Override per-environment via SUBGRAPH_URL.
//
// The native DEX (CLOB) markets/orders/fills are a SEPARATE surface and are NOT
// served here: they come from the D-Chain's own read surface via dchain.ts. A
// query is split by its leading root field — dexRouting.isDexQuery → D-Chain
// adapter, otherwise → AMM_GRAPH (see proxyToNativeGraph). This REPLACES the dead
// `/v1/graph/cchain/dex/graphql` subgraph derivation (that route 404s on the
// deployed explorer; the native CLOB lives on the D-Chain, not the C-Chain graph).
//
// The default is ACTIVE.subgraphUrl — the network's own graph — NOT a hardcoded
// host. This line read cchain's, so the two modules that resolve this one value
// disagreed: subgraph.ts followed the network and this one always went to Lux.
// With SUBGRAPH_URL set both landed in the same place and the split was
// invisible. Zoo's deployment dropped the override once `zoo` was a real network
// entry, and the disagreement surfaced immediately — shaped responses came from
// Zoo's graph while every raw query went to Lux's, so zoo.exchange printed
// $126.0K of PROTOCOL TVL over a table of WLUX and LZOO while its own factory
// held $204,000 in WZOO/ZUSD.
const AMM_GRAPH = process.env.SUBGRAPH_URL || ACTIVE.subgraphUrl

// acceptedMarketIds resolves the set of REAL market ids for the dex graph by
// fetching its markets once and running them through the real-asset gate. It is the
// single source of truth for "which markets are real", reused by every dex response
// (markets, orders-only, fills-only) so the policy lives in exactly one place. The
// per-token on-chain results are cached in filterRealMarkets; this short fetch is
// also cheap and bounded.
async function acceptedMarketIds(): Promise<Set<string>> {
  const cacheKey = `dex:accepted-ids`
  const cached = cacheGet(cacheKey) as string[] | null
  if (cached) {
    return new Set(cached)
  }
  let ids: string[] = []
  try {
    // Same D-Chain markets source the markets surface uses, run through the same
    // real-asset gate — one definition of "which markets are real".
    const { acceptedIds } = await filterRealMarkets(await fetchMarkets())
    ids = [...acceptedIds]
  } catch {
    ids = [] // fail closed — no provable markets ⇒ no orders/fills survive
  }
  // Short TTL: the orders/fills polls (~4s) reuse this set; markets refresh at PROXY.
  cacheSet(cacheKey, ids, TTL.PROXY)
  return new Set(ids)
}

// sanitizeDexData enforces the real-asset gate on a DEX (CLOB) graph response
// before it leaves this API: the markets display must surface ONLY real,
// accepted-chain-state markets. Synthetic-seed rows (phantom asset ids, crossed
// books, mock/test/Liquidity* tokens) are REJECTED (stripped). The FE issues
// markets / orders / fills as SEPARATE queries, so each is gated:
//   • a `markets` payload is filtered to the real set directly;
//   • an orders-only / fills-only payload is filtered against the real-market set
//     (resolved via acceptedMarketIds) — a row survives ONLY if it carries a
//     `market` in that set. Fail closed: a row with no resolvable market link, or
//     when zero markets are real, is dropped. This keeps synthetic-seed fills off
//     the "Recent Trades" panel even though dex `fills` rows carry no market field.
// AMM responses and dex responses with none of these collections pass through.
//
// Verification calls the network's C-Chain RPC (per-token code + decimals, cached),
// so a network whose real asset contracts are not yet deployed yields an EMPTY
// market list — the correct "No active markets" state, with no special-casing.
export async function sanitizeDexData(data: any): Promise<any> {
  const d = data?.data
  if (!d || typeof d !== 'object') {
    return data
  }
  const hasMarkets = Array.isArray(d.markets)
  const hasOrders = Array.isArray(d.orders)
  const hasFills = Array.isArray(d.fills)
  if (!hasMarkets && !hasOrders && !hasFills) {
    return data // nothing CLOB-shaped to gate
  }

  let real: RawMarket[] | undefined
  let acceptedIds: Set<string>
  if (hasMarkets) {
    const r = await filterRealMarkets(d.markets as RawMarket[])
    real = r.markets
    acceptedIds = r.acceptedIds
  } else {
    // orders/fills-only — resolve the real-market set independently.
    acceptedIds = await acceptedMarketIds()
  }

  const out = { ...data, data: { ...d } }
  if (hasMarkets) {
    out.data.markets = real
  }
  // Orders carry a `market` id ⇒ filter precisely to accepted markets.
  if (Array.isArray(out.data.orders)) {
    out.data.orders = out.data.orders.filter(
      (r: any) => typeof r?.market === 'string' && acceptedIds.has(r.market),
    )
  }
  // Fills are emitted globally by the matcher and (in this schema) carry NO market
  // field, so they cannot be attributed per-market. They are legitimate chain output
  // ONLY when real markets exist; when zero markets are real, every fill is synthetic
  // seed and is dropped. If a fill DOES carry a market id, it must be an accepted one.
  if (Array.isArray(out.data.fills)) {
    out.data.fills =
      acceptedIds.size === 0
        ? []
        : out.data.fills.filter(
            (r: any) => r?.market === undefined || acceptedIds.has(r.market),
          )
  }
  return out
}

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

// Resolve a GraphQL body from the correct native source, split by its leading root
// field (dexRouting.isDexQuery): native-CLOB queries (markets/orders/fills) from
// the D-Chain read surface (dchain.ts), everything else forwarded verbatim to the
// AMM graph. For AMM only the query + variables are forwarded — never client
// headers — and the target is a fixed server-side constant; the dex target is
// likewise server-resolved, so neither path is an SSRF/open-proxy.
async function proxyToNativeGraph(body: any): Promise<any> {
  // Source-scoped cache keys: the CLOB (D-Chain) and AMM (graph) surfaces must
  // never share a cache entry even for an identical body.
  if (isDexQuery(body)) {
    const cacheKey = `dchain:${JSON.stringify(body)}`
    const cached = cacheGet(cacheKey)
    if (cached) return cached
    let data: any
    try {
      // The D-Chain response passes the real-asset gate before caching, so
      // synthetic-seed markets are stripped at the source and never served.
      data = await sanitizeDexData(await queryDChain(body))
    } catch (e) {
      console.error('D-Chain CLOB query failed:', e)
      data = { data: null } // fail typed-empty → FE renders "No active markets"
    }
    cacheSet(cacheKey, data, TTL.PROXY)
    return data
  }

  const cacheKey = `native:${AMM_GRAPH}:${JSON.stringify(body)}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached
  try {
    const res = await fetch(AMM_GRAPH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: body?.query, variables: body?.variables }),
      signal: AbortSignal.timeout(15000),
    })
    const raw = await res.json()
    cacheSet(cacheKey, raw, TTL.PROXY)
    return raw
  } catch (e) {
    console.error('Native graph query failed:', e)
    // Fail typed-empty, never with a dead-upstream error string. The FE renders
    // an empty market list rather than an error toast.
    return { data: null }
  }
}

// tokenResponseFromUsd builds the Uniswap-schema Token from ALREADY-DERIVED USD
// values. This is the single shaper; buildTokenResponse (subgraph-row inputs) and
// handleTopTokens (RankedToken inputs) both funnel through here so the output
// shape lives once.
function tokenResponseFromUsd(address: string, chain: string, v: {
  symbol: string
  name: string
  decimals: number
  priceUSD: number
  volumeUSD: number
  tvlUSD: number
  logoUrl?: string | null
}): any {
  const id = `${chain}_${address}`
  const isNative = address === '0x0000000000000000000000000000000000000000'
  const token = {
    __typename: 'Token',
    id,
    address: isNative ? null : address,
    chain,
    symbol: v.symbol,
    name: v.name,
    decimals: v.decimals,
    standard: 'ERC20',
    // A token page asks for every one of these. A field the client selected and
    // the server omitted is not a smaller answer — the client cannot write the
    // object to its cache at all, so the whole token comes back undefined and
    // the page reports it has no data. Present and honestly empty is a real
    // answer; absent is a broken one.
    isBridged: false,
    bridgedWithdrawalInfo: null,
    feeData: null,
    protectionInfo: null,
    market: {
      __typename: 'TokenMarket',
      id: `${id}_market`,
      totalValueLocked: { __typename: 'Amount', id: `${id}_tvl`, value: v.tvlUSD, currency: 'USD' },
      price: { __typename: 'Amount', id: `${id}_price`, value: v.priceUSD, currency: 'USD' },
      pricePercentChange: { __typename: 'Amount', id: `${id}_pct`, currency: 'USD', value: 0 },
      volume: { __typename: 'Amount', id: `${id}_vol`, value: v.volumeUSD, currency: 'USD' },
      priceHistory: [],
      ohlc: [],
      historicalVolume: [],
    },
    project: {
      __typename: 'TokenProject',
      id: `${id}_project`,
      name: v.name,
      logoUrl: v.logoUrl || null,
      safetyLevel: 'VERIFIED',
      isSpam: false,
      spamCode: 0,
      tokens: [] as any[],
    },
  }
  // The project lists the tokens it covers, and here that is this one. A copy
  // without the project underneath it, because the client walks this and a
  // literal that contains itself does not survive being written down.
  token.project.tokens = [
    {
      __typename: 'Token',
      id,
      chain,
      address: isNative ? null : address,
      decimals: v.decimals,
      name: v.name,
      symbol: v.symbol,
      standard: 'ERC20',
    },
  ]
  return token
}

// Build a Uniswap-schema Token response from raw subgraph-row data (derivedETH +
// ethPrice → USD). Used by the per-token / per-pool shapers.
function buildTokenResponse(address: string, chain: string, opts: {
  symbol?: string
  name?: string
  decimals?: number
  derivedETH?: string
  volumeUSD?: string
  totalLiquidity?: string
  logoUrl?: string | null
  ethPrice?: number
  upstreamUsd?: Map<string, number>
} = {}): any {
  // One definition of what a token is worth, shared with the ranked list, so a
  // token's price on its own page and its price in the table are the same
  // number arrived at the same way. This block used to restate the arithmetic
  // and the stablecoin exception in its own words.
  const { priceUSD, volumeUSD, tvlUSD } = deriveUsd({
    symbol: opts.symbol || '',
    address,
    derivedETH: opts.derivedETH,
    volumeUSD: opts.volumeUSD,
    tvlUSD: opts.totalLiquidity,
    ethPrice: opts.ethPrice || 0,
    upstreamUsd: opts.upstreamUsd,
  })

  return tokenResponseFromUsd(address, chain, {
    symbol: opts.symbol || 'UNKNOWN',
    name: opts.name || 'Unknown Token',
    decimals: opts.decimals || 18,
    priceUSD,
    volumeUSD,
    tvlUSD,
    logoUrl: opts.logoUrl,
  })
}

// Handle topTokens query for Lux/Zoo. Projects the shared ranked-token primitive
// (native LUX first, then volume desc) into the GraphQL topTokens shape.
async function handleTopTokens(chain: string): Promise<any> {
  const ranked = await getRankedTokens()
  // Curated tokens only — the subgraph indexes junk/test tokens (fake USDC/USDT); the
  // token selector reads topTokens, so gate it to real Lux assets (same gate as
  // /v1/swappable_tokens). Native LUX always passes.
  const tokens = ranked
    .filter(t => isCuratedAddress(t.address))
    .map(t =>
    tokenResponseFromUsd(t.address, chain, {
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      priceUSD: t.priceUSD,
      volumeUSD: t.volumeUSD,
      tvlUSD: t.tvlUSD,
      logoUrl: t.logoUrl,
    }),
  )
  return { data: { topTokens: tokens } }
}

// Handle token query for a specific address
async function handleToken(chain: string, address: string | null): Promise<any> {
  const [v3Bundle, v2Bundle, upstreamUsd] = await Promise.all([
    getV3Bundle(),
    getBundle(),
    upstreamPrices(ACTIVE.tokens.map((t) => t.upstream).filter((id): id is string => !!id)),
  ])
  const ethPrice = v3Bundle ? parseFloat(v3Bundle.ethPriceUSD) : (v2Bundle ? parseFloat(v2Bundle.ethPrice) : 0)

  // Native token
  if (!address || address === '0x0000000000000000000000000000000000000000') {
    return {
      data: {
        // Same source as the ranked list's leading row (subgraph.ts): the coin
        // belongs to the network this process serves. This branch used to carry
        // its own `chain === 'LUX' ? … : 'ZOO'` — a second, differently-written
        // answer to one question, which named every non-Lux chain ZOO and served
        // Lux's logo to all of them.
        token: buildTokenResponse('0x0000000000000000000000000000000000000000', chain, {
          symbol: ACTIVE.coin.symbol,
          name: ACTIVE.coin.name,
          decimals: 18,
          derivedETH: '1',
          logoUrl: ACTIVE.coin.logoUrl ?? undefined,
          ethPrice,
          upstreamUsd,
        }),
      },
    }
  }

  const meta = getTokenMeta(address)
  const subgraphTokens = await getSubgraphTokens(100)
  const sg = subgraphTokens.find(t => t.id.toLowerCase() === address.toLowerCase())

  return {
    data: {
      token: buildTokenResponse(address, chain, {
        symbol: sg?.symbol || meta?.symbol || 'UNKNOWN',
        name: sg?.name || meta?.name || 'Unknown Token',
        decimals: sg ? parseInt(sg.decimals) : meta?.decimals || 18,
        derivedETH: sg?.derivedETH || '0',
        volumeUSD: sg?.tradeVolumeUSD || '0',
        totalLiquidity: sg?.totalLiquidity || '0',
        logoUrl: meta?.logoUrl || null,
        ethPrice,
        upstreamUsd,
      }),
    },
  }
}

// Handle topV2Pairs query
async function handleTopV2Pairs(chain: string): Promise<any> {
  const pairs = await getSubgraphPairs(50)
  const bundle = await getBundle()
  const ethPrice = bundle ? parseFloat(bundle.ethPrice) : 0

  const v2Pairs = pairs
    .filter(p => isCuratedAddress(p.token0.id) && isCuratedAddress(p.token1.id))
    .map(p => {
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

  const v3Pools = pools
    .filter(p => isCuratedAddress(p.token0.id) && isCuratedAddress(p.token1.id))
    .map(p => {
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

// tokenProjectsFor builds a Uniswap `tokenProjects` payload for the requested contracts,
// including only those that resolve to a known Lux token (by address). Non-Lux contracts
// (ETHEREUM/POLYGON/…) yield no project — the LX_API serves only Lux-ecosystem tokens.
function tokenProjectsFor(contracts: Array<{ chain?: string; address?: string }> | undefined): any[] {
  const out: any[] = []
  for (const c of contracts || []) {
    const addr = (c?.address || '').toLowerCase()
    if (!addr) continue
    const meta = getTokenMeta(addr)
    if (!meta) continue
    const id = `LUX_${meta.address}`
    const project = { __typename: 'TokenProject', id: `${id}_project`, logoUrl: meta.logoUrl || null, safetyLevel: 'VERIFIED', isSpam: false }
    out.push({
      ...project,
      name: meta.name,
      tokens: [
        {
          __typename: 'Token',
          id,
          chain: 'LUX',
          address: meta.address,
          decimals: meta.decimals,
          name: meta.name,
          symbol: meta.symbol,
          standard: 'ERC20',
          project,
        },
      ],
    })
  }
  return out
}

export async function handleGraphQL(req: Request, res: Response): Promise<void> {
  const body = req.body
  const opName = extractOperationName(body)
  const nativeChain = isNativeChainQuery(body)

  // Uniswap data-api ops the native explorer graph cannot resolve (it has no
  // `tokenProjects` field). The request carries its own per-contract chain, so this is
  // chain-agnostic and must be answered here REGARDLESS of isNativeChainQuery —
  // forwarding it yields "unknown field: tokenProjects" and breaks the token selector's
  // common-bases section. The LX_API only knows Lux-ecosystem tokens, so it returns a
  // project for each requested contract that resolves to a known Lux token, omitting
  // the rest (non-Lux contracts simply have no project here).
  if (opName === 'TokenProjects' || opName === 'TokenProject') {
    res.json({ data: { tokenProjects: tokenProjectsFor(body?.variables?.contracts) } })
    return
  }

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
