import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Request } from 'express'
import {
  TOKEN_RANKINGS_PATH,
  parseRankingsRequest,
  chainIsServed,
  toRankingsStat,
  buildRankingsResponse,
} from './explore'
import type { RankedToken } from './subgraph'

// These assert the Connect-RPC TokenRankings shaper WITHOUT a network. They lock
// the wire contract the FE's generated @luxamm/client-explore client decodes:
//   response.tokenRankings["TRENDING"].tokens : TokenRankingsStat[]
// and the proto3-JSON field names / nesting of each stat. The live curl in the
// task proves the end-to-end path against real subgraph data.

const fakeReq = (over: Partial<Request>): Request => ({ method: 'GET', query: {}, body: undefined, ...over }) as Request

// ── path ─────────────────────────────────────────────────────────────────────
test('procedure path is package.Service/Method', () => {
  assert.equal(TOKEN_RANKINGS_PATH, '/uniswap.explore.v1.ExploreStatsService/TokenRankings')
})

// ── request parsing: GET message + POST body ───────────────────────────────────
test('GET parses the url-decoded message JSON', () => {
  const r = parseRankingsRequest(fakeReq({ method: 'GET', query: { message: '{"chainId":"96369"}' } }))
  assert.deepEqual(r, { value: { chainId: '96369' } })
})

test('GET with no message → empty request (FE prefetch before chain resolves)', () => {
  const r = parseRankingsRequest(fakeReq({ method: 'GET', query: {} }))
  assert.deepEqual(r, { value: {} })
})

test('GET with malformed message JSON → error', () => {
  const r = parseRankingsRequest(fakeReq({ method: 'GET', query: { message: '{not json' } }))
  assert.ok('error' in r)
})

test('GET with a non-object message → error', () => {
  const r = parseRankingsRequest(fakeReq({ method: 'GET', query: { message: '42' } }))
  assert.ok('error' in r)
})

test('POST parses the JSON body', () => {
  const r = parseRankingsRequest(fakeReq({ method: 'POST', body: { chainId: 'ALL_NETWORKS' } }))
  assert.deepEqual(r, { value: { chainId: 'ALL_NETWORKS' } })
})

test('POST with empty body → empty request', () => {
  const r = parseRankingsRequest(fakeReq({ method: 'POST', body: {} }))
  assert.deepEqual(r, { value: {} })
})

// ── chain gating: single-chain venue ───────────────────────────────────────────
test('serves Lux (96369), ALL_NETWORKS, and unset chainId', () => {
  assert.equal(chainIsServed('96369'), true)
  assert.equal(chainIsServed('ALL_NETWORKS'), true)
  assert.equal(chainIsServed(undefined), true)
  assert.equal(chainIsServed(''), true)
})

test('does not serve a foreign chain (empty ranking, not an error)', () => {
  assert.equal(chainIsServed('1'), false)
  assert.equal(chainIsServed('8453'), false)
})

// ── stat projection: the mapper's mandatory fields + Amount shape ──────────────
const LUX: RankedToken = {
  address: '0x0000000000000000000000000000000000000000',
  symbol: 'LUX',
  name: 'Lux',
  decimals: 18,
  priceUSD: 0,
  volumeUSD: 0,
  tvlUSD: 0,
  logoUrl: 'https://lux.exchange/assets/lux_app_logo-4TeLXZ7D.svg',
}

const USDC: RankedToken = {
  address: '0xf85cf66fd0189c435033056edec5e525f39374a6',
  symbol: 'USDC',
  name: 'Bridged USDC',
  decimals: 6,
  priceUSD: 1,
  volumeUSD: 123456.7,
  tvlUSD: 9876.5,
  logoUrl: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
}

test('stat carries chain=LUX (maps to 96369) and the mandatory symbol/name/decimals', () => {
  // tokenRankingsStatToCurrencyInfo drops a stat without these — they must be present.
  const stat = toRankingsStat(USDC)
  assert.equal(stat.chain, 'LUX')
  assert.equal(stat.symbol, 'USDC')
  assert.equal(stat.name, 'Bridged USDC')
  assert.equal(stat.decimals, 6)
  assert.equal(stat.address, '0xf85cf66fd0189c435033056edec5e525f39374a6')
})

test('stat encodes Amount as { currency, value } and only when > 0', () => {
  const stat = toRankingsStat(USDC)
  assert.deepEqual(stat.price, { currency: 'USD', value: 1 })
  assert.deepEqual(stat.volume1Day, { currency: 'USD', value: 123456.7 })
  assert.deepEqual(stat.totalValueLocked, { currency: 'USD', value: 9876.5 })
})

test('native LUX (zero price/volume) omits the optional Amount fields', () => {
  const stat = toRankingsStat(LUX)
  assert.equal(stat.address, '0x0000000000000000000000000000000000000000')
  assert.equal('price' in stat, false)
  assert.equal('volume1Day' in stat, false)
  assert.equal('totalValueLocked' in stat, false)
  assert.equal(stat.logo, LUX.logoUrl) // logo present when set
})

// ── full response: the map keyed by CustomRankingType the selector indexes ──────
test('response is { tokenRankings: { TRENDING|...: { tokens: [...] } } }', () => {
  const resp = buildRankingsResponse([LUX, USDC])
  // The selector reads tokenRankings["TRENDING"].tokens.
  assert.ok(resp.tokenRankings.TRENDING)
  assert.equal(resp.tokenRankings.TRENDING.tokens.length, 2)
  assert.equal(resp.tokenRankings.TRENDING.tokens[0].symbol, 'LUX')
  assert.equal(resp.tokenRankings.TRENDING.tokens[1].symbol, 'USDC')
  // All three CustomRankingType keys are present (explore views request each).
  assert.ok(resp.tokenRankings.PRICE_PERCENT_CHANGE_1_DAY_ASC)
  assert.ok(resp.tokenRankings.PRICE_PERCENT_CHANGE_1_DAY_DESC)
})

test('empty ranking yields empty token lists under every key (no error)', () => {
  const resp = buildRankingsResponse([])
  assert.deepEqual(resp.tokenRankings.TRENDING.tokens, [])
  assert.deepEqual(resp.tokenRankings.PRICE_PERCENT_CHANGE_1_DAY_ASC.tokens, [])
})
