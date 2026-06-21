import { test } from 'node:test'
import assert from 'node:assert/strict'
import { graphEndpointFor, deriveDexGraph } from './graphql'

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

// ── lead-root routing (item 2): only the FIRST top-level field decides. ──────────
test('lead-root wins: a mixed { pools ... markets ... } document routes to amm', () => {
  // `pools` is the leading root; the sibling `markets` must NOT pull this to dex.
  const q = '{ pools { id totalValueLockedUSD } markets { id } }'
  assert.ok(isAmm(graphEndpointFor({ query: q })), 'sibling markets must not re-route')
})

test('nested dex trigger word does not mis-route: pools(orderBy:..){ order } stays amm', () => {
  // `order` appears only as a NESTED field under the amm lead root `pools`.
  const q = '{ pools(orderBy: volumeUSD, orderDirection: desc) { order: id reserveUSD } }'
  assert.ok(isAmm(graphEndpointFor({ query: q })), 'nested order must not re-route')
})

test('a genuine CLOB lead root still routes to dex even with amm fields nested below', () => {
  const q = '{ markets(first: 50) { id pools { id } } }'
  assert.ok(isDex(graphEndpointFor({ query: q })), 'markets is the lead root')
})

test('aliased dex lead root resolves to the real field: { mk: markets {..} } -> dex', () => {
  assert.ok(isDex(graphEndpointFor({ query: '{ mk: markets { id } }' })), 'alias target markets')
})

test('aliased amm lead root resolves to the real field: { m: pools {..} } -> amm', () => {
  assert.ok(isAmm(graphEndpointFor({ query: '{ m: pools { id } }' })), 'alias target pools')
})

test('trigger word inside a comment or string literal does not route to dex', () => {
  assert.ok(isAmm(graphEndpointFor({ query: '# markets are great\n{ pools { id } }' })), 'comment')
  assert.ok(isAmm(graphEndpointFor({ query: '{ pools(where: { name: "markets" }) { id } }' })), 'string literal')
})

test('named/var/directive headers are skipped to the real lead root', () => {
  assert.ok(isDex(graphEndpointFor({ query: 'query M($id: ID! = "0xabc") { market(id: $id) { id } }' })), 'var default {} not a selection set')
  assert.ok(isAmm(graphEndpointFor({ query: 'query Tokens { tokens(first: 100) { id symbol } }' })))
})

// ── DEX_GRAPH derivation guard (item 3): deriveDexGraph. ─────────────────────────
test('deriveDexGraph swaps the amm segment for dex by default', () => {
  assert.equal(
    deriveDexGraph('http://explorer/v1/graph/cchain/amm/graphql'),
    'http://explorer/v1/graph/cchain/dex/graphql',
  )
})

test('deriveDexGraph honors an explicit DEX_SUBGRAPH_URL verbatim', () => {
  assert.equal(
    deriveDexGraph('http://explorer/anything', 'http://other/dex/graphql'),
    'http://other/dex/graphql',
  )
})

test('deriveDexGraph FAILS FAST when the swap is a no-op and no explicit dex url is set', () => {
  // SUBGRAPH_URL without an `/amm/graphql` segment would collapse dex -> amm.
  assert.throws(
    () => deriveDexGraph('http://explorer/v1/graph/cchain/graphql'),
    /cannot derive the DEX .* graph endpoint/,
    'must throw rather than silently collapse to the amm endpoint',
  )
})

test('deriveDexGraph does NOT throw on no-op swap when an explicit dex url IS set', () => {
  assert.equal(
    deriveDexGraph('http://explorer/v1/graph/cchain/graphql', 'http://explorer/v1/graph/cchain/dex/graphql'),
    'http://explorer/v1/graph/cchain/dex/graphql',
  )
})
