import { Request, Response } from 'express'
import fetch from 'node-fetch'
import { cacheGet, cacheSet, TTL } from './cache'
import { getSubgraphTokens, getSubgraphPairs, getBundle, getSubgraphSwaps, getSubgraphV3Pools, getV3Bundle, getSubgraphV3Swaps, getRankedTokens } from './subgraph'
import { getTokenMeta } from './lux-tokens'

// The native Lux graph engine (luxfi/graph in the explorer) is the single source
// of truth. It exposes TWO schemas on the SAME host/slug under distinct subgraph
// paths: `amm` (uniswap-v2/v3-shaped pools/pairs/swaps/tokens/factories) and `dex`
// (the native CLOB: markets/fills/orders/orderbook). The FE's AMM queries resolve
// against `amm`; its CLOB/market queries resolve against `dex`. Routing the wrong
// one returns "unknown field: markets" — the markets-won't-load failure. This
// REPLACES the dead Uniswap hosted gateway, which returned HTML.
//
// AMM_GRAPH is the existing SUBGRAPH_URL knob (the AMM endpoint, default). DEX_GRAPH
// is derived from it by swapping the subgraph segment (same explorer host + slug),
// overridable independently. One base, two schema endpoints — no second host config.
const AMM_GRAPH = process.env.SUBGRAPH_URL ||
  'http://explorer.lux-mainnet.svc:8090/v1/graph/cchain/amm/graphql'

// deriveDexGraph resolves the `dex` (CLOB) schema endpoint from the `amm` one. An
// explicit DEX_SUBGRAPH_URL always wins. Otherwise the dex endpoint is the amm one
// with the `/amm/graphql` segment swapped for `/dex/graphql` (one base, two schema
// paths on the same explorer host+slug).
//
// FOOTGUN GUARD: if an operator overrides SUBGRAPH_URL to a value that lacks the
// `/amm/graphql` segment, the swap is a no-op and the dex endpoint silently collapses
// to the amm one — every CLOB query then routes to the amm schema and fails with
// "unknown field: markets". Rather than fail opaquely at request time, fail FAST at
// startup: when the derivation is a no-op and no explicit DEX_SUBGRAPH_URL is set,
// throw with the exact remedy.
export function deriveDexGraph(ammGraph: string, explicitDexGraph?: string): string {
  if (explicitDexGraph) return explicitDexGraph
  const derived = ammGraph.replace('/amm/graphql', '/dex/graphql')
  if (derived === ammGraph) {
    throw new Error(
      `cannot derive the DEX (CLOB) graph endpoint: SUBGRAPH_URL (${ammGraph}) has no ` +
        `'/amm/graphql' segment to swap for '/dex/graphql', so the dex endpoint would ` +
        `collapse to the amm endpoint and every CLOB query would fail ("unknown field: ` +
        `markets"). Set DEX_SUBGRAPH_URL explicitly, or include '/amm/graphql' in SUBGRAPH_URL.`,
    )
  }
  return derived
}

const DEX_GRAPH = deriveDexGraph(AMM_GRAPH, process.env.DEX_SUBGRAPH_URL)

// dexRootFields are the root query fields that ONLY the native DEX (CLOB) schema
// resolves. A query whose LEADING top-level field is one of these routes to
// DEX_GRAPH; everything else (AMM pools/swaps/tokens/factories, and any raw
// subgraph query) goes to AMM_GRAPH.
const dexRootFields = new Set([
  'markets', 'market', 'fills', 'fill', 'orders', 'order', 'orderbook',
  'perpPositions', 'perpPosition', 'fundingRates', 'fundingRate',
  'liquidations', 'liquidation', 'marketDayDatas',
])

// isNameStart / isNameChar implement the GraphQL Name production /[_A-Za-z][_0-9A-Za-z]*/.
const isNameStart = (c: string) => /[_A-Za-z]/.test(c)
const isNameChar = (c: string) => /[_0-9A-Za-z]/.test(c)

// leadRootField returns the name of the FIRST field in the operation's top-level
// selection set, or null if there is none. It is the routing key: only the leading
// root field decides amm-vs-dex, so a mixed document `{ pools ... markets ... }`
// routes by `pools` (its lead root), and trigger words that appear only as NESTED
// fields, ALIASES' targets aside, inside string literals, or inside comments never
// mis-route. This replaces a whole-document substring scan, which false-positived on
// all of the above.
//
// The scan skips, in order to find the top-level `{`: `#` comments, `"..."`/`"""..."""`
// string literals (so trigger words inside them don't count), and a balanced `(...)`
// variable-definitions group (whose default values may themselves contain `{ }`). The
// first `{` seen at paren-depth 0 opens the top-level selection set; the first Name
// token after it is the lead field, unless it is an alias (`alias: field`), in which
// case the Name after the `:` is the real field. A leading `...` (fragment spread /
// inline fragment) yields null (routed to the AMM default).
export function leadRootField(query: string): string | null {
  const n = query.length
  let i = 0
  let parenDepth = 0
  let inSelectionSet = false

  const skipString = () => {
    if (query.startsWith('"""', i)) {
      i += 3
      while (i < n && !query.startsWith('"""', i)) i++
      i += 3
      return
    }
    i++ // opening quote
    while (i < n && query[i] !== '"') {
      if (query[i] === '\\') i++ // skip escaped char
      i++
    }
    i++ // closing quote
  }

  const readName = (): string => {
    const start = i
    i++ // first char already known to be a name start
    while (i < n && isNameChar(query[i])) i++
    return query.slice(start, i)
  }

  // Phase 1: advance to the top-level selection-set opener `{` (paren-depth 0).
  while (i < n && !inSelectionSet) {
    const c = query[i]
    if (c === '#') {
      while (i < n && query[i] !== '\n') i++
    } else if (c === '"') {
      skipString()
    } else if (c === '(') {
      parenDepth++
      i++
    } else if (c === ')') {
      if (parenDepth > 0) parenDepth--
      i++
    } else if (c === '{' && parenDepth === 0) {
      inSelectionSet = true
      i++
    } else {
      i++
    }
  }
  if (!inSelectionSet) return null

  // Phase 2: read the first field name in the top-level selection set, skipping
  // comments/strings/whitespace; resolve an `alias: field` to `field`.
  let firstName: string | null = null
  while (i < n) {
    const c = query[i]
    if (c === '#') {
      while (i < n && query[i] !== '\n') i++
    } else if (c === '"') {
      skipString()
    } else if (c === '.') {
      // A leading `...` (fragment spread / inline fragment) is not a routable field.
      return null
    } else if (isNameStart(c)) {
      const name = readName()
      if (firstName === null) {
        firstName = name
        continue // peek ahead for an alias colon
      }
      // We already have a candidate and just read a SECOND name without an
      // intervening colon — the first was the real field (no alias).
      return firstName
    } else if (c === ':') {
      // The name we read was an alias; the real field is the next Name token.
      firstName = null
      i++
    } else {
      // Any other punctuation (e.g. `(`, `{`, `@`) terminates the field name —
      // whatever we have is the lead field.
      if (firstName !== null) return firstName
      i++
    }
  }
  return firstName
}

// graphEndpointFor selects the native-graph schema endpoint for a GraphQL body by
// the LEADING root field of its top-level selection set (see leadRootField). The
// decision is a pure function of the query text and two SERVER-SIDE constants — the
// client never supplies the target URL, so this cannot be turned into an SSRF/
// open-proxy (the SSRF-safety the verbatim forwarder already had is preserved).
export function graphEndpointFor(body: any): string {
  const root = leadRootField(body?.query || '')
  return root !== null && dexRootFields.has(root) ? DEX_GRAPH : AMM_GRAPH
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

// Forward a GraphQL body verbatim to the native graph engine, routed to the schema
// (amm vs dex) that resolves the query's root fields (see graphEndpointFor). Only the
// query + variables are forwarded — never client headers — and the target is one of
// two fixed server-side constants, so this cannot be turned into an SSRF/open-proxy.
async function proxyToNativeGraph(body: any): Promise<any> {
  const endpoint = graphEndpointFor(body)
  // Endpoint-scoped cache key: amm and dex must never share a cache entry even for
  // an identical body (they resolve different schemas).
  const cacheKey = `native:${endpoint}:${JSON.stringify(body)}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  try {
    const res = await fetch(endpoint, {
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
  return {
    __typename: 'Token',
    id,
    address: address === '0x0000000000000000000000000000000000000000' ? null : address,
    chain,
    symbol: v.symbol,
    name: v.name,
    decimals: v.decimals,
    standard: 'ERC20',
    market: {
      __typename: 'TokenMarket',
      id: `${id}_market`,
      totalValueLocked: { __typename: 'Amount', id: `${id}_tvl`, value: v.tvlUSD, currency: 'USD' },
      price: { __typename: 'Amount', id: `${id}_price`, value: v.priceUSD, currency: 'USD' },
      pricePercentChange: { __typename: 'Amount', id: `${id}_pct`, currency: 'USD', value: 0 },
      volume: { __typename: 'Amount', id: `${id}_vol`, value: v.volumeUSD, currency: 'USD' },
      priceHistory: [],
    },
    project: {
      __typename: 'TokenProject',
      id: `${id}_project`,
      logoUrl: v.logoUrl || null,
      safetyLevel: 'VERIFIED',
    },
  }
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
} = {}): any {
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
  const tokens = ranked.map(t =>
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
