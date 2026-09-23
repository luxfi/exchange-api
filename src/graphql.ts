import { Request, Response } from 'express'
import fetch from 'node-fetch'
import { cacheGet, cacheSet, TTL } from './cache'
import { getSubgraphTokens, getSubgraphPairs, getBundle, getSubgraphV3Pools, getV3Bundle, getSubgraphV3Swaps, getSubgraphV3TokenSwaps, getRankedTokens, deriveUsd, type SwapPage } from './subgraph'

import { filterRealMarkets, type RawMarket } from './dexMarkets'
import { isDexQuery } from './dexRouting'
import { queryDChain, fetchMarkets } from './dchain'
import { ACTIVE, getTokenMeta, tokenMetaOn, graphUrlFor } from './networks'
import { upstreamPrices, upstreamSupply } from './upstream'
import type { TokenMeta } from './lux-tokens'

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

// The operations that ask for one token on one chain.
const TOKEN_OPS = new Set(['Token', 'TokenPrice', 'SimpleToken', 'TokenWeb', 'TokenMarket'])

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
    const raw = dress(await res.json(), await dressing())
    cacheSet(cacheKey, raw, TTL.PROXY)
    return raw
  } catch (e) {
    console.error('Native graph query failed:', e)
    // Fail typed-empty, never with a dead-upstream error string. The FE renders
    // an empty market list rather than an error toast.
    return { data: null }
  }
}

/** A token row on the wire: an address for an id, and a symbol. */
const isToken = (v: any): boolean =>
  !!v && typeof v === 'object' && typeof v.id === 'string' && typeof v.symbol === 'string' &&
  /^0x[0-9a-fA-F]{40}$/.test(v.id)

/**
 * What a token IS, applied wherever a token row leaves this service.
 *
 * Three things the chain cannot answer for itself, all of them already settled
 * in the registry, all of them already asked by the named operations:
 *
 *   its name     Lux and Zoo were deployed from the same account in the same
 *                order, so their contracts share addresses AND bytecode — and
 *                bytecode carries the name string. Zoo's own coin introduced
 *                itself as "Wrapped LUX" on Zoo's own exchange.
 *
 *   its supply   An asset we issue declares its supply once, on its home chain.
 *                What sits in another chain's row is the slice bridged there,
 *                and valuing that slice as the whole asset is how ZOO came to
 *                report a fully diluted value of $221K on one chain and $19.7M
 *                on the other.
 *
 *   its price    An asset the world prices is priced by the world. One thin
 *                local pool, seeded at a round ratio and never traded, is not a
 *                second opinion.
 *
 * The named handlers asked all three. A raw subgraph query went round them, and
 * a token page issues one — so the page that a person actually opens read the
 * chain's own answer while the list beside it read ours. One dressing, on the
 * way out, for every path.
 */
type Dressing = {
  usd: Map<string, number>
  supply: Map<string, number>
  nativeUSD: number
  /** What a token IS on the chain being read — not necessarily the one served. */
  meta: (address: string) => TokenMeta | undefined
}

/** The transform: what the dressing does, given what it needs. */
export function dress(body: any, d: Dressing): any {
  if (!body?.data) {
    return body
  }
  const walk = (node: any): void => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (!node || typeof node !== 'object') {
      return
    }
    const meta = isToken(node) ? d.meta(node.id) : undefined
    if (meta) {
      node.symbol = meta.symbol
      node.name = meta.name
      const supply = meta.upstream ? d.supply.get(meta.upstream) : undefined
      if (supply && 'totalSupply' in node) {
        node.totalSupply = String(supply)
      }
      const price = meta.upstream ? d.usd.get(meta.upstream) : undefined
      if (price && d.nativeUSD > 0 && 'derivedETH' in node) {
        node.derivedETH = String(price / d.nativeUSD)
      }
    }
    Object.values(node).forEach(walk)
  }
  walk(body.data)
  return body
}

/** What the dressing needs, gathered. Every source of it is cached. */
async function dressing(slug?: string): Promise<Dressing> {
  const assets = [...new Set(ACTIVE.tokens.map((t) => t.upstream).filter((id): id is string => !!id))]
  const [usd, supplies, bundle] = await Promise.all([
    upstreamPrices(assets),
    Promise.all(assets.map(async (id) => [id, (await upstreamSupply(id))?.totalSupply] as const)),
    getV3Bundle(),
  ])
  const supply = new Map<string, number>()
  for (const [id, total] of supplies) {
    if (total !== undefined) {
      supply.set(id, total)
    }
  }
  return {
    usd,
    supply,
    nativeUSD: parseFloat(bundle?.ethPriceUSD ?? ''),
    meta: slug ? (a: string) => tokenMetaOn(slug, a) : getTokenMeta,
  }
}

/**
 * A chain's own graph, read through here so its answers are dressed.
 *
 * The exchange can be pointed at another chain while running on this one, and
 * only the graph has a route per chain — so the front end asked the graph
 * directly and got the chain's own answers back undressed. Its token list named
 * bridged ether LETH beside a token page calling the same contract ETH, and the
 * page a person opens and the list they opened it from disagreed.
 *
 * The registry for the chain in the path, not the one this process serves: Lux
 * and Zoo share contract addresses, so the served network's list would name
 * another chain's tokens after its own.
 */
export async function handleChainGraph(req: Request, res: Response): Promise<void> {
  const { slug, subgraph } = req.params
  const url = graphUrlFor(slug)
  if (!url) {
    res.status(404).json({ errors: [{ message: `no graph for ${slug}` }] })
    return
  }
  const target = url.replace('/amm/graphql', `/${subgraph}/graphql`)
  const cacheKey = `chain:${target}:${JSON.stringify(req.body)}`
  const cached = cacheGet(cacheKey)
  if (cached) {
    res.json(cached)
    return
  }
  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: req.body?.query, variables: req.body?.variables }),
      signal: AbortSignal.timeout(15000),
    })
    const out = dress(await upstream.json(), await dressing(slug))
    cacheSet(cacheKey, out, TTL.PROXY)
    res.json(out)
  } catch (e) {
    console.error(`chain graph ${slug}/${subgraph} failed:`, e)
    res.json({ data: null })
  }
}

// tokenResponseFromUsd builds the Uniswap-schema Token from ALREADY-DERIVED USD
// values. This is the single shaper; buildTokenResponse (subgraph-row inputs) and
// handleTopTokens (RankedToken inputs) both funnel through here so the output
// shape lives once.
/** price x quantity, or undefined when the quantity is unknown. */
function mul(price: number, qty?: number): number | undefined {
  if (qty === undefined || !Number.isFinite(qty) || !Number.isFinite(price)) {
    return undefined
  }
  return price * qty
}

/** A USD Amount, or null — the shape the client reads as "no figure". */
function usdAmount(id: string, value?: number): any {
  return value === undefined ? null : { __typename: 'Amount', id, value, currency: 'USD' }
}

/**
 * The fields a Token must carry that we have no answer for.
 *
 * Present and null, never absent. A field the client selected and the server
 * omitted is not a smaller answer: the client cannot write the object to its
 * cache at all, so the whole token comes back undefined and the page reports it
 * has no data. Every place that builds a Token spreads this, so there is one
 * statement of what a Token owes its reader.
 */
const UNKNOWN_TOKEN_FIELDS = {
  isBridged: false,
  bridgedWithdrawalInfo: null,
  feeData: null,
  protectionInfo: null,
} as const

export function tokenResponseFromUsd(address: string, chain: string, v: {
  symbol: string
  name: string
  decimals: number
  priceUSD: number
  volumeUSD: number
  tvlUSD: number
  logoUrl?: string | null
  totalSupply?: number
  circulating?: number
}): any {
  const id = `${chain}_${address}`
  const isNative = address === '0x0000000000000000000000000000000000000000'
  // Stated once. The token page reads a valuation twice — off the market, and off
  // the project's markets list — and two spellings of the same arithmetic is how
  // one of them drifts.
  const fdv = usdAmount(`${id}_fdv`, mul(v.priceUSD, v.totalSupply))
  const mcap = usdAmount(`${id}_mcap`, mul(v.priceUSD, v.circulating))
  const token = {
    __typename: 'Token',
    id,
    address: isNative ? null : address,
    chain,
    symbol: v.symbol,
    name: v.name,
    decimals: v.decimals,
    standard: 'ERC20',
    ...UNKNOWN_TOKEN_FIELDS,
    market: {
      __typename: 'TokenMarket',
      id: `${id}_market`,
      totalValueLocked: { __typename: 'Amount', id: `${id}_tvl`, value: v.tvlUSD, currency: 'USD' },
      price: { __typename: 'Amount', id: `${id}_price`, value: v.priceUSD, currency: 'USD' },
      pricePercentChange: { __typename: 'Amount', id: `${id}_pct`, currency: 'USD', value: 0 },
      volume: { __typename: 'Amount', id: `${id}_vol`, value: v.volumeUSD, currency: 'USD' },
      // The same figure under the name the token page asks for it by:
      // `volume24H: volume(duration: DAY)`. This server answers by operation name
      // and returns a document it composed itself, so an alias the client wrote is
      // a key this object has to carry. Resolving `volume` alone is not a smaller
      // answer — the page reads volume24H, finds nothing, and reports no data.
      volume24H: { __typename: 'Amount', id: `${id}_vol`, value: v.volumeUSD, currency: 'USD' },
      // A year's high and low need a year of prices, and nothing here keeps them.
      // Null, which the page draws as the dash it draws for any figure it lacks;
      // zero would claim the price stood still for a year.
      priceHigh52W: null,
      priceLow52W: null,
      // What the token is worth in whole, and what of it is on the market.
      // Both were absent, so the page drew a dash where a valuation belongs
      // however much the token traded — the supply was on the indexer's row the
      // whole time and nothing carried it this far.
      //
      // Null where the supply is unknown, which the client renders as the dash
      // it already had. A valuation of an unknown supply is a figure with no
      // meaning; zero would say the token is worth nothing.
      fullyDilutedValuation: fdv,
      marketCap: mcap,
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
      // What a project says about itself. Nothing here keeps prose or links for
      // a token, so these are null rather than absent: the page selects them, and
      // a field it selected and did not receive costs it the whole token.
      description: null,
      homepageUrl: null,
      twitterName: null,
      // The project's own view of the valuation, which the page reads instead of
      // the market's when it draws the header figures.
      markets: [
        {
          __typename: 'TokenProjectMarket',
          id: `${id}_project_market`,
          fullyDilutedValuation: fdv,
          marketCap: mcap,
          priceHigh52W: null,
          priceLow52W: null,
        },
      ],
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
      // The same market, because this is the same token. The page walks the
      // project's list to draw the figures beside each one, and this list has a
      // single member.
      market: token.market,
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
  totalSupply?: number
  circulating?: number
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
    totalSupply: opts.totalSupply,
    circulating: opts.circulating,
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
      totalSupply: t.totalSupply,
      circulating: t.circulating,
      logoUrl: t.logoUrl,
    }),
  )
  return { data: { topTokens: tokens } }
}

// Handle token query for a specific address
/**
 * The chain coin's supply and what of it is loose, read from the wrapped
 * native's indexer row — the only row that carries them.
 */
async function nativeSupply(): Promise<{ totalSupply?: number; circulating?: number }> {
  const wrapped = ACTIVE.contracts.WLUX?.toLowerCase()
  if (!wrapped) {
    return {}
  }
  const row = (await getSubgraphTokens(100)).find((t) => String(t.id).toLowerCase() === wrapped)
  const total = parseFloat(row?.totalSupply || '')
  if (!Number.isFinite(total) || total <= 0) {
    return {}
  }
  const staked = parseFloat(row?.staked || '')
  const locked = Number.isFinite(staked) && staked > 0 ? Math.min(staked, total) : 0
  return { totalSupply: total, circulating: total - locked }
}

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
          // The coin's supply, from the wrapped native's row.
          //
          // The indexer has no row at the zero sentinel — a native coin is not a
          // contract — and publishes the chain's genesis supply and what is
          // staked onto the wrapper instead. They are one asset, so the coin's
          // page states the same valuation its wrapper does; without this it
          // printed a dash while the wrapper beside it printed a figure.
          ...(await nativeSupply()),
        }),
      },
    }
  }

  const meta = getTokenMeta(address)
  const subgraphTokens = await getSubgraphTokens(100)
  const sg = subgraphTokens.find(t => t.id.toLowerCase() === address.toLowerCase())
  // The supply is on the same indexer row as the price. Read here so a token's
  // own page states the same valuation the ranked table does.
  // An asset we issue declares its supply once, on its home chain; what sits in
  // this chain's row is only the slice bridged here.
  const declared = meta?.upstream ? await upstreamSupply(meta.upstream) : undefined
  const total = parseFloat(sg?.totalSupply || '')
  const staked = parseFloat(sg?.staked || '')
  const local = Number.isFinite(total) && total > 0 ? total : undefined
  const totalSupply = declared?.totalSupply ?? local
  const circulating =
    declared?.circulating ??
    (local === undefined
      ? undefined
      : local - (Number.isFinite(staked) && staked > 0 ? Math.min(staked, local) : 0))

  return {
    data: {
      token: buildTokenResponse(address, chain, {
        // The curated name wins, as it already does for the ranked table. The
        // chain says LETH / Lux Ether for bridged ether; the curated list says
        // ETH / Ethereum, which is what it is called everywhere else and what
        // the table prints. Reading the chain first here meant a token's own
        // page and the table that links to it disagreed about its name.
        symbol: meta?.symbol || sg?.symbol || 'UNKNOWN',
        name: meta?.name || sg?.name || 'Unknown Token',
        decimals: sg ? parseInt(sg.decimals) : meta?.decimals || 18,
        derivedETH: sg?.derivedETH || '0',
        volumeUSD: sg?.tradeVolumeUSD || '0',
        totalLiquidity: sg?.totalLiquidity || '0',
        logoUrl: meta?.logoUrl || null,
        ethPrice,
        upstreamUsd,
        totalSupply,
        circulating,
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
/**
 * One side of a swap, as the transactions table reads a token.
 *
 * The table selects more of a token than the row itself carries — decimals, a
 * project, a logo — and a field it selected and did not receive costs it the
 * whole transaction, so every one of them is stated here, null where unknown.
 */
function transactionToken(chain: string, symbol?: string): any {
  const sym = symbol || '?'
  // A swap names its sides by symbol; the curated list is where a symbol becomes
  // an address, a precision and a logo. The native coin is not in that list — it
  // is not a contract — so it answers for itself.
  const native = sym.toLowerCase() === ACTIVE.coin.symbol.toLowerCase()
  const meta = native
    ? { address: NATIVE_ADDR, symbol: ACTIVE.coin.symbol, name: ACTIVE.coin.name, decimals: 18, logoUrl: ACTIVE.coin.logoUrl ?? null }
    : ACTIVE.tokens.find(t => t.symbol.toLowerCase() === sym.toLowerCase())
  const address = native ? null : (meta?.address ?? null)
  const id = `${chain}_${meta?.address ?? sym}`
  const self = { __typename: 'Token', id, address, symbol: sym, chain }
  return {
    ...self,
    decimals: meta?.decimals ?? 18,
    project: {
      __typename: 'TokenProject',
      id: `${id}_project`,
      name: meta?.name ?? sym,
      tokens: [self],
      logo: meta?.logoUrl ? { __typename: 'Image', id: `${id}_logo`, url: meta.logoUrl } : null,
    },
  }
}

/**
 * The recent swaps, shaped as PoolTransactions — the chain's, or one token's.
 *
 * The graph answers the v3 shape — a swap belongs to a `pool`, and its
 * `amount0`/`amount1` are signed base units — whatever the selection asked for.
 * Reading it as v2 (`pair`, `amount0In`) gave every row a "?" counterparty and
 * a quantity of NaN, which the table drew as 0.
 *
 * The indexer's amountUSD is 0 on a swap it has not yet priced, so such a row is
 * priced here from the token's own USD price — the same one the page shows
 * above the table.
 */
async function poolTransactions(chain: string, page: SwapPage = { first: 50 }, address: string | null = null): Promise<any[]> {
  const [swaps, ranked] = await Promise.all([
    address ? getSubgraphV3TokenSwaps(address, page) : getSubgraphV3Swaps(page),
    getRankedTokens().catch(() => [] as Awaited<ReturnType<typeof getRankedTokens>>),
  ])
  const price = new Map(ranked.map(t => [t.address, t.priceUSD]))
  const scale = (raw: string | undefined, decimals: number | string | undefined): number =>
    Math.abs(parseFloat(raw || '0')) / 10 ** Number(decimals ?? 18)
  return swaps.map(s => {
    const t0 = s.pool?.token0
    const t1 = s.pool?.token1
    const q0 = scale(s.amount0, t0?.decimals)
    const q1 = scale(s.amount1, t1?.decimals)
    const indexed = parseFloat(s.amountUSD || '0')
    const usd = indexed > 0
      ? indexed
      : q0 * (price.get(String(t0?.id ?? '').toLowerCase()) ?? 0) || q1 * (price.get(String(t1?.id ?? '').toLowerCase()) ?? 0)
    return {
      __typename: 'PoolTransaction',
      // The table keys rows by id and asks which pool version they came from.
      // Both were absent, and a row the client cannot key is a row it drops.
      id: s.id,
      protocolVersion: 'V3',
      hash: s.id.split('#')[0] || s.id,
      timestamp: parseInt(s.timestamp),
      chain,
      token0: transactionToken(chain, t0?.symbol),
      token1: transactionToken(chain, t1?.symbol),
      token0Quantity: q0.toString(),
      token1Quantity: q1.toString(),
      usdValue: { __typename: 'Amount', id: s.id, value: usd, currency: 'USD' },
      type: 'SWAP',
      account: s.origin || s.sender,
    }
  })
}

async function handleTransactions(chain: string): Promise<any> {
  return { data: { v2Transactions: await poolTransactions(chain) } }
}

/**
 * A token's own transactions, which the token page asks for as a field OF the
 * token rather than as a list beside it. Same swaps, hung where the page looks.
 */
async function handleTokenTransactions(chain: string, address: string | null, page: SwapPage): Promise<any> {
  const [token, txs] = await Promise.all([
    handleToken(chain, address),
    poolTransactions(chain, page, address),
  ])
  return {
    data: {
      token: {
        ...token.data.token,
        // The page asks v2, v3 and v4 as three queries and concatenates the
        // answers, so a swap must appear under exactly one. Every pool here is a
        // v3 pool — the graph's `pairs` are the same rows as its `pools`.
        v2Transactions: [],
        v3Transactions: txs,
        // V4 is real here — the PoolManager ABI is a live precompile at 0x9999
        // (LP-9999, receipt settlement), and it emits the standard Initialize /
        // ModifyLiquidity / Swap events for an indexer to read.
        //
        // Empty because no pool has been opened on it yet, not because there is
        // no V4: a scan of every block on mainnet finds no event at 0x9999 or at
        // the 0x9010 read view. When the first pool is initialized this becomes a
        // read of those logs, keyed by poolId. The query ERRORING is what put a
        // banner over the page announcing data was away; an empty list states the
        // position honestly.
        v4Transactions: [],
      },
    },
  }
}

// tokenProjectsFor builds a Uniswap `tokenProjects` payload for the requested contracts,
// including only those that resolve to a token of the network this process serves.
// Other chains' contracts (ETHEREUM/POLYGON/…) yield no project.
function tokenProjectsFor(contracts: Array<{ chain?: string; address?: string }> | undefined): any[] {
  const out: any[] = []
  for (const c of contracts || []) {
    const addr = (c?.address || '').toLowerCase()
    if (!addr) continue
    const meta = getTokenMeta(addr)
    if (!meta) continue
    const id = `${ACTIVE.chain}_${meta.address}`
    const project = { __typename: 'TokenProject', id: `${id}_project`, logoUrl: meta.logoUrl || null, safetyLevel: 'VERIFIED', isSpam: false }
    out.push({
      ...project,
      name: meta.name,
      tokens: [
        {
          __typename: 'Token',
          id,
          chain: ACTIVE.chain,
          address: meta.address,
          decimals: meta.decimals,
          name: meta.name,
          symbol: meta.symbol,
          standard: 'ERC20',
          ...UNKNOWN_TOKEN_FIELDS,
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

  // What a unit of one currency is worth in another. Everything here is priced in
  // USD, so USD to USD is the identity and is the only rate this holds — the app
  // asks for exactly that on every page load, and being refused left an error in
  // the console of an otherwise working page.
  //
  // Carries no chain, so it is answered here for the same reason TokenProjects is:
  // the chain check below would send it to a graph that has no `convert` field.
  // Another pair would need a rate source this does not have, and a made-up rate
  // is worse than none — null is the answer the client reads as "priced in USD".
  if (opName === 'Convert') {
    const from = body?.variables?.fromCurrency
    const to = body?.variables?.toCurrency
    res.json({
      data: {
        convert: from === to
          ? { __typename: 'Amount', id: `convert_${from}_${to}`, value: 1, currency: to }
          : null,
      },
    })
    return
  }

  // A token on another chain — the app asks for USDC on BASE and the like. This
  // API holds only its own network's tokens, so the answer is that it has none;
  // the native graph cannot parse the Uniswap query and answered with an error.
  const chain = body?.variables?.chain
  if (TOKEN_OPS.has(opName) && typeof chain === 'string' && !NATIVE_CHAINS.has(chain)) {
    res.json({ data: { token: null } })
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
      // The token page's own two reads. They ask the same question as Token — a
      // token on a chain — and differ only in how much of the answer they select,
      // so they are answered from the same place rather than a second one that
      // could drift from it. Unhandled, they fell through to the native graph,
      // which has no token(chain:, address:) and refuses them outright.
      case 'TokenWeb':
      case 'TokenMarket':
        result = await handleToken(nativeChain, body.variables?.address || null)
        break

      case 'V2TokenTransactions':
      case 'V3TokenTransactions':
      case 'V4TokenTransactions':
        result = await handleTokenTransactions(nativeChain, body.variables?.address || null, {
          first: body.variables?.first || 50,
          before: body.variables?.cursor || undefined,
        })
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
