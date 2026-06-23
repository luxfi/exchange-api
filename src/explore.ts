// explore.ts — Connect-RPC (unary, HTTP/JSON) handler for
// uniswap.explore.v1.ExploreStatsService.TokenRankings.
//
// This is the THIRD backend the lux.exchange FE expects, alongside /v1/graphql
// and the trading-api REST surface. The token selector's default list comes from
// here: the FE calls TokenRankings via the generated @luxamm/client-explore client
// over a Connect transport (useHttpGet: true), then reads
//   response.tokenRankings["TRENDING"].tokens
// and maps each TokenRankingsStat → CurrencyInfo. The mapper
// (tokenRankingsStatToCurrencyInfo) DROPS any token missing chain/symbol/name/
// decimals, and resolves chain via fromGraphQLChain — so `chain` MUST be the
// GraphQL enum string "LUX" (which maps to UniverseChainId.Lux = 96369), never a
// numeric id, and symbol/name/decimals are mandatory on every stat.
//
// Connect unary over HTTP/JSON, both forms (we serve BOTH; the web GET transport
// uses the first, a POST transport the second):
//   GET  /uniswap.explore.v1.ExploreStatsService/TokenRankings
//          ?connect=v1&encoding=json&message=<url-encoded request JSON>
//   POST /uniswap.explore.v1.ExploreStatsService/TokenRankings
//          Content-Type: application/json   body = request JSON
// Success: 200 application/json, the response message JSON (proto3 JSON, camelCase
// field names exactly per the proto). Error: the Connect error envelope
//   { "code": "<connect-code>", "message": "..." }
// with the matching HTTP status.

import type { Request, Response } from 'express'
import type { Address } from 'viem'
import { getRankedTokens, type RankedToken } from './subgraph'
import { bestRoute, toWrapped } from './dexRouter'
import { cacheGet, cacheSet, TTL } from './cache'
import { ACTIVE } from './networks'

// Connect's package.Service/Method path. Matches the generated typeName
// `uniswap.explore.v1.ExploreStatsService` + rpc `TokenRankings`.
export const TOKEN_RANKINGS_PATH = '/uniswap.explore.v1.ExploreStatsService/TokenRankings'

// CustomRankingType values (pkgs/api/src/clients/content/types.ts). These are the
// keys of TokenRankingsResponse.token_rankings the FE indexes into; the selector
// reads "TRENDING".
const RANKING_TRENDING = 'TRENDING'
const RANKING_1D_ASC = 'PRICE_PERCENT_CHANGE_1_DAY_ASC'
const RANKING_1D_DESC = 'PRICE_PERCENT_CHANGE_1_DAY_DESC'

// The GraphQL Chain enum string for Lux (GraphQLApi.Chain.Lux === "LUX", → 96369).
const LUX_CHAIN = 'LUX'
const LUX_CHAIN_ID = String(ACTIVE.chainId)
// The sentinel chainId meaning "all networks" (connectRpc/base.ts ALL_NETWORKS_ARG).
const ALL_NETWORKS_ARG = 'ALL_NETWORKS'

// ─────────────────────────────────────────────────────────────────────────────
// Connect error envelope. HTTP status per the Connect spec's code→status table.
// ─────────────────────────────────────────────────────────────────────────────

type ConnectCode = 'invalid_argument' | 'unimplemented' | 'internal'

const CONNECT_STATUS: Record<ConnectCode, number> = {
  invalid_argument: 400,
  unimplemented: 404,
  internal: 500,
}

function connectError(res: Response, code: ConnectCode, message: string): void {
  res.status(CONNECT_STATUS[code]).json({ code, message })
}

// ─────────────────────────────────────────────────────────────────────────────
// Request parsing. The request is TokenRankingsRequest { chainId, pageSize?,
// pageToken? } as proto3 JSON. GET carries it url-encoded in `message`; POST in
// the JSON body. We only act on chainId.
// ─────────────────────────────────────────────────────────────────────────────

interface TokenRankingsRequestJson {
  chainId?: string
}

export function parseRankingsRequest(req: Request): { value: TokenRankingsRequestJson } | { error: string } {
  if (req.method === 'GET') {
    const raw = req.query.message
    if (raw === undefined) return { value: {} } // no message → default (empty) request
    if (typeof raw !== 'string') return { error: 'message query param must be a single string' }
    try {
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object') {
        return { error: 'message must be a JSON object' }
      }
      return { value: parsed as TokenRankingsRequestJson }
    } catch {
      return { error: 'message query param is not valid JSON' }
    }
  }
  // POST: express.json() already parsed the body (or left it {} for an empty body).
  const body = req.body
  if (body === undefined || body === null) return { value: {} }
  if (typeof body !== 'object') return { error: 'request body must be a JSON object' }
  return { value: body as TokenRankingsRequestJson }
}

// LX_API is a single-chain venue (Lux C-Chain, 96369). Accept that chain, its
// numeric string, the ALL_NETWORKS aggregate, or an unset chainId (the FE
// prefetches before the brand config resolves the chain). Any OTHER concrete chain
// has no tokens here — return an empty ranking rather than error, mirroring the
// trading-api's "serve our tokens" stance, so the selector never shows an error.
export function chainIsServed(chainId: string | undefined): boolean {
  if (chainId === undefined || chainId === '') return true
  return chainId === LUX_CHAIN_ID || chainId === ALL_NETWORKS_ARG
}

// ─────────────────────────────────────────────────────────────────────────────
// Projection: RankedToken → TokenRankingsStat (proto3 JSON). Field names are the
// proto's JSON names (camelCase). Amount = { currency, value }. `optional` fields
// are omitted when there is no value. `chain` is the GraphQL string so the FE's
// fromGraphQLChain resolves it; symbol/name/decimals are always present (the
// mapper drops a stat without them).
// ─────────────────────────────────────────────────────────────────────────────

const NATIVE_SENTINEL = '0x0000000000000000000000000000000000000000'

function usd(value: number): { currency: 'USD'; value: number } {
  return { currency: 'USD', value }
}

export function toRankingsStat(t: RankedToken): Record<string, unknown> {
  const stat: Record<string, unknown> = {
    chain: LUX_CHAIN,
    // Native LUX keeps the zero sentinel; the FE's buildCurrency treats the
    // sentinel address as the native currency on the chain.
    address: t.address === NATIVE_SENTINEL ? NATIVE_SENTINEL : t.address,
    name: t.name,
    symbol: t.symbol,
    decimals: t.decimals,
    safetyLevel: 'VERIFIED',
  }
  if (t.logoUrl) stat.logo = t.logoUrl
  if (t.priceUSD > 0) stat.price = usd(t.priceUSD)
  if (t.volumeUSD > 0) stat.volume1Day = usd(t.volumeUSD)
  if (t.tvlUSD > 0) stat.totalValueLocked = usd(t.tvlUSD)
  return stat
}

// buildRankingsResponse assembles the TokenRankingsResponse (proto3 JSON) from the
// ranked token list. The map keys are the CustomRankingType values the explore
// views request; the selector reads TRENDING.
//
// PRICE_PERCENT_CHANGE_1_DAY ranks: we have no historical price series on the
// native graph yet, so 1-day % change is uniformly absent and both ordered lists
// equal the volume-ranked set — the same tokens, under the keys those views want.
// (When a price-history source lands, sort these by pricePercentChange1Day
// asc/desc here.)
export function buildRankingsResponse(ranked: RankedToken[]): {
  tokenRankings: Record<string, { tokens: Record<string, unknown>[] }>
} {
  const tokens = ranked.map(toRankingsStat)
  return {
    tokenRankings: {
      [RANKING_TRENDING]: { tokens },
      [RANKING_1D_ASC]: { tokens },
      [RANKING_1D_DESC]: { tokens },
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler. Mounted for both GET and POST at TOKEN_RANKINGS_PATH.
// ─────────────────────────────────────────────────────────────────────────────

export async function handleTokenRankings(req: Request, res: Response): Promise<void> {
  // Connect JSON requires application/json. The web GET transport sends
  // ?encoding=json; a POST sends Content-Type: application/json. We only speak
  // JSON here — a non-JSON encoding is unimplemented.
  if (req.method === 'GET' && req.query.encoding !== undefined && req.query.encoding !== 'json') {
    return connectError(res, 'unimplemented', `encoding ${String(req.query.encoding)} not supported; use json`)
  }

  const parsed = parseRankingsRequest(req)
  if ('error' in parsed) {
    return connectError(res, 'invalid_argument', parsed.error)
  }

  try {
    // Volume-desc ranking from the shared token primitive (native LUX first); a
    // chain we don't serve yields an empty list rather than an error.
    const ranked = chainIsServed(parsed.value.chainId) ? await getRankedTokens() : []
    res.json(buildRankingsResponse(ranked))
  } catch (e) {
    console.error('[explore] TokenRankings:', e)
    connectError(res, 'internal', 'Internal server error')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ExploreStats + ProtocolStats — the explore page's token/pool tables and the
// protocol TVL/volume charts. Same ExploreStatsService, same Connect-RPC JSON
// transport as TokenRankings; the FE reaches them via useExploreStatsQuery /
// useProtocolStatsQuery (apiBaseUrlV2 → this service). Without these two the
// explore page calls 404 and renders empty.
//
// tokenStats is the primary view: the curated, swappable Lux tokens (from
// getRankedTokens — names/logos/decimals) priced in USD on-chain by quoting one
// whole unit → LUSD through the SAME QuoterV2 path the swap uses, since the native
// graph indexes no USD price/TVL. Pool TVL/volume and the protocol time-series are
// not derivable from the native graph yet (it indexes a stale V2 deployment, not
// the live V3 pools the swap trades), so poolStats and the charts are returned
// empty rather than wrong — the token table is correct and real, the rest degrades
// cleanly. (When the graph indexes the live V3 deployment with TVL, fill poolStats
// from getSubgraphV3Pools + the protocol series from pool/token day data here.)
// ─────────────────────────────────────────────────────────────────────────────

export const EXPLORE_STATS_PATH = '/uniswap.explore.v1.ExploreStatsService/ExploreStats'
export const PROTOCOL_STATS_PATH = '/uniswap.explore.v1.ExploreStatsService/ProtocolStats'

const LUSD_ADDRESS = '0x848Cff46eb323f323b6Bbe1Df274E40793d7f2c2'
const STABLE = new Set(['USDT', 'USDC', 'LUSD', 'DAI', 'BUSD'])

// USD price of one whole token: stablecoins pin to $1; everything else is the
// amount of LUSD (= $1) that one unit swaps to, via the same on-chain router the
// trading-api quotes through. 0 when no route exists (the FE renders "-").
async function priceTokenUsd(addr: string, decimals: number, symbol: string): Promise<number> {
  if (STABLE.has(symbol.toUpperCase())) return 1
  if (!Number.isFinite(decimals) || decimals < 0) return 0
  try {
    const wrapped = toWrapped(addr) // native LUX / WLUX → WLUX
    if (wrapped.toLowerCase() === LUSD_ADDRESS.toLowerCase()) return 1
    const oneUnit = 10n ** BigInt(decimals)
    const route = await bestRoute(wrapped, LUSD_ADDRESS as Address, oneUnit, 'EXACT_INPUT')
    if (!route || route.amountOut <= 0n) return 0
    return Number(route.amountOut) / 1e18 // LUSD has 18 decimals
  } catch {
    return 0
  }
}

// RankedToken → TokenStats (proto3 JSON, camelCase). chain is the GraphQL enum
// string "LUX". price/volume omitted when zero (optional Amount fields).
function toTokenStats(t: RankedToken, priceUSD: number): Record<string, unknown> {
  const stat: Record<string, unknown> = {
    chain: LUX_CHAIN,
    address: t.address,
    name: t.name,
    symbol: t.symbol,
    decimals: t.decimals,
    standard: t.address === NATIVE_SENTINEL ? 'NATIVE' : 'ERC20',
  }
  if (t.logoUrl) {
    stat.logo = t.logoUrl
    stat.project = { name: t.name, logo: t.logoUrl, logoUrl: t.logoUrl }
  }
  if (priceUSD > 0) stat.price = usd(priceUSD)
  if (t.volumeUSD > 0) stat.volume1Day = usd(t.volumeUSD)
  return stat
}

const EMPTY_TVL = { v2: [], v3: [], v4: [] }
const EMPTY_VOLUME_SPLIT = { v2: [], v3: [], v4: [] }
const EMPTY_HISTORICAL_VOLUME = { Month: EMPTY_VOLUME_SPLIT, Year: EMPTY_VOLUME_SPLIT, Max: EMPTY_VOLUME_SPLIT }

function emptyExploreStats(): Record<string, unknown> {
  return {
    stats: {
      tokenStats: [],
      poolStats: [],
      poolStatsV3: [],
      transactionStats: [],
      dailyProtocolTvl: EMPTY_TVL,
      historicalProtocolVolume: EMPTY_HISTORICAL_VOLUME,
      topTokens: { hourly: [], daily: [] },
    },
  }
}

export async function handleExploreStats(req: Request, res: Response): Promise<void> {
  if (req.method === 'GET' && req.query.encoding !== undefined && req.query.encoding !== 'json') {
    return connectError(res, 'unimplemented', `encoding ${String(req.query.encoding)} not supported; use json`)
  }
  const parsed = parseRankingsRequest(req)
  if ('error' in parsed) {
    return connectError(res, 'invalid_argument', parsed.error)
  }

  try {
    if (!chainIsServed(parsed.value.chainId)) {
      res.json(emptyExploreStats())
      return
    }

    const cacheKey = 'explore:stats'
    const cached = cacheGet(cacheKey) as Record<string, unknown> | null
    if (cached) {
      res.json(cached)
      return
    }

    const ranked = await getRankedTokens()
    // Enrich each token with an on-chain USD price (one unit → LUSD). Parallel;
    // priceTokenUsd never throws, so a dead route degrades that token to 0.
    const prices = await Promise.all(
      ranked.map((t) => (t.priceUSD > 0 ? Promise.resolve(t.priceUSD) : priceTokenUsd(t.address, t.decimals, t.symbol))),
    )
    const tokenStats = ranked.map((t, i) => toTokenStats(t, prices[i]))

    const response = {
      stats: {
        tokenStats,
        poolStats: [],
        poolStatsV3: [],
        transactionStats: [],
        dailyProtocolTvl: EMPTY_TVL,
        historicalProtocolVolume: EMPTY_HISTORICAL_VOLUME,
        topTokens: { hourly: [], daily: tokenStats },
      },
    }
    cacheSet(cacheKey, response, TTL.SHORT)
    res.json(response)
  } catch (e) {
    console.error('[explore] ExploreStats:', e)
    connectError(res, 'internal', 'Internal server error')
  }
}

export async function handleProtocolStats(req: Request, res: Response): Promise<void> {
  if (req.method === 'GET' && req.query.encoding !== undefined && req.query.encoding !== 'json') {
    return connectError(res, 'unimplemented', `encoding ${String(req.query.encoding)} not supported; use json`)
  }
  const parsed = parseRankingsRequest(req)
  if ('error' in parsed) {
    return connectError(res, 'invalid_argument', parsed.error)
  }
  // No protocol-level TVL/volume time series on the native graph yet; return the
  // empty (well-formed) envelope so the charts render flat instead of erroring.
  res.json({ dailyProtocolTvl: EMPTY_TVL, historicalProtocolVolume: EMPTY_HISTORICAL_VOLUME })
}
