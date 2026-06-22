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
import { getRankedTokens, type RankedToken } from './subgraph'

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
const LUX_CHAIN_ID = '96369'
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
