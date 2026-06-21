import { test } from 'node:test'
import assert from 'node:assert/strict'
import { graphEndpointFor } from './graphql'

// graphEndpointFor is the FIX-D routing invariant: native-CLOB (dex) queries must
// resolve against the `dex` schema endpoint, AMM queries against `amm`. Misrouting
// is the "unknown field: markets" failure. These assert the predicate WITHOUT a
// network — the live devnet check proves the endpoints actually resolve.

const isDex = (url: string) => url.endsWith('/dex/graphql')
const isAmm = (url: string) => url.endsWith('/amm/graphql')

test('routes CLOB market/fill/order queries to the dex schema', () => {
  for (const q of [
    '{ markets { id baseToken quoteToken } }',
    'query Markets { markets(first: 50) { id } }',
    '{ market(id: "0xabc") { id volume24h } }',
    '{ fills(first: 100) { id amountOut } }',
    'query OB { orderbook(id: "0xabc") { bids asks } }',
    '{ perpPositions { id } }',
    '{ marketDayDatas { id } }',
  ]) {
    assert.ok(isDex(graphEndpointFor({ query: q })), `expected dex endpoint for: ${q}`)
  }
})

test('routes AMM pool/swap/token queries to the amm schema', () => {
  for (const q of [
    '{ pools { id totalValueLockedUSD } }',
    'query TopTokens { tokens(first: 100) { id symbol } }',
    '{ swaps(first: 50) { id amount0 amount1 } }',
    '{ pairs { id reserveUSD } }',
    '{ uniswapFactories { totalVolumeUSD } }',
    '{ bundle(id: "1") { ethPrice } }',
  ]) {
    assert.ok(isAmm(graphEndpointFor({ query: q })), `expected amm endpoint for: ${q}`)
  }
})

test('whole-word match: marketCap-like substrings do NOT route to dex', () => {
  // A field that merely CONTAINS "market" must not be mistaken for the dex root.
  assert.ok(isAmm(graphEndpointFor({ query: '{ tokens { id marketCap } }' })))
})

test('empty / missing query falls back to amm (the verbatim default)', () => {
  assert.ok(isAmm(graphEndpointFor({})))
  assert.ok(isAmm(graphEndpointFor({ query: '' })))
})
