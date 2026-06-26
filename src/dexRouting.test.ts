import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDexQuery, leadRootField } from './dexRouting'

// isDexQuery is the routing invariant: native-CLOB (markets/orders/fills) queries
// must route to the D-Chain adapter (true), AMM (pools/swaps/tokens) queries to the
// amm graph (false). Misrouting a CLOB query to the amm graph is the "unknown
// field: markets" failure. These assert the predicate WITHOUT a network.

test('routes CLOB market/fill/order queries to the dex (D-Chain) adapter', () => {
  for (const q of [
    '{ markets { id baseToken quoteToken } }',
    'query Markets { markets(first: 50) { id } }',
    '{ market(id: "0xabc") { id volume24h } }',
    '{ fills(first: 100) { id amountOut } }',
    'query OB { orderbook(id: "0xabc") { bids asks } }',
    '{ perpPositions { id } }',
    '{ marketDayDatas { id } }',
  ]) {
    assert.ok(isDexQuery({ query: q }), `expected dex routing for: ${q}`)
  }
})

test('routes AMM pool/swap/token queries to the amm graph', () => {
  for (const q of [
    '{ pools { id totalValueLockedUSD } }',
    'query TopTokens { tokens(first: 100) { id symbol } }',
    '{ swaps(first: 50) { id amount0 amount1 } }',
    '{ pairs { id reserveUSD } }',
    '{ uniswapFactories { totalVolumeUSD } }',
    '{ bundle(id: "1") { ethPrice } }',
  ]) {
    assert.ok(!isDexQuery({ query: q }), `expected amm routing for: ${q}`)
  }
})

test('whole-word match: marketCap-like substrings do NOT route to dex', () => {
  // A field that merely CONTAINS "market" must not be mistaken for the dex root.
  assert.ok(!isDexQuery({ query: '{ tokens { id marketCap } }' }))
})

test('empty / missing query falls back to amm (not dex)', () => {
  assert.ok(!isDexQuery({}))
  assert.ok(!isDexQuery({ query: '' }))
})

// ── lead-root routing: only the FIRST top-level field decides. ───────────────────
test('lead-root wins: a mixed { pools ... markets ... } document routes to amm', () => {
  // `pools` is the leading root; the sibling `markets` must NOT pull this to dex.
  const q = '{ pools { id totalValueLockedUSD } markets { id } }'
  assert.ok(!isDexQuery({ query: q }), 'sibling markets must not re-route')
})

test('nested dex trigger word does not mis-route: pools(orderBy:..){ order } stays amm', () => {
  // `order` appears only as a NESTED field under the amm lead root `pools`.
  const q = '{ pools(orderBy: volumeUSD, orderDirection: desc) { order: id reserveUSD } }'
  assert.ok(!isDexQuery({ query: q }), 'nested order must not re-route')
})

test('a genuine CLOB lead root still routes to dex even with amm fields nested below', () => {
  const q = '{ markets(first: 50) { id pools { id } } }'
  assert.ok(isDexQuery({ query: q }), 'markets is the lead root')
})

test('aliased dex lead root resolves to the real field: { mk: markets {..} } -> dex', () => {
  assert.ok(isDexQuery({ query: '{ mk: markets { id } }' }), 'alias target markets')
})

test('aliased amm lead root resolves to the real field: { m: pools {..} } -> amm', () => {
  assert.ok(!isDexQuery({ query: '{ m: pools { id } }' }), 'alias target pools')
})

test('trigger word inside a comment or string literal does not route to dex', () => {
  assert.ok(!isDexQuery({ query: '# markets are great\n{ pools { id } }' }), 'comment')
  assert.ok(!isDexQuery({ query: '{ pools(where: { name: "markets" }) { id } }' }), 'string literal')
})

test('named/var/directive headers are skipped to the real lead root', () => {
  assert.ok(isDexQuery({ query: 'query M($id: ID! = "0xabc") { market(id: $id) { id } }' }), 'var default {} not a selection set')
  assert.ok(!isDexQuery({ query: 'query Tokens { tokens(first: 100) { id symbol } }' }))
})

// ── leadRootField directly (the pure key the predicate is built on) ──────────────
test('leadRootField returns the leading top-level field name', () => {
  assert.equal(leadRootField('{ markets { id } }'), 'markets')
  assert.equal(leadRootField('{ pools { id } }'), 'pools')
  assert.equal(leadRootField('{ mk: markets { id } }'), 'markets')
  assert.equal(leadRootField(''), null)
  assert.equal(leadRootField('{ ...Frag }'), null)
})
