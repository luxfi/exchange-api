import test from 'node:test'
import assert from 'node:assert/strict'

import { tokenResponseFromUsd, handleGraphQL } from './graphql'

// This server answers by operation name and returns a document it composed
// itself, rather than resolving the query it was handed. So the contract is not
// "which fields exist in a schema" but "which keys are on the object" — an alias
// the page wrote is a key this response owes it, and a field the page selected
// and did not receive costs it the whole token, not just that field. The page
// then reports it has no data while every figure it needed was in hand.
//
// These are the selections lux.exchange sends as TokenWeb.
const token = () =>
  tokenResponseFromUsd('0x0000000000000000000000000000000000000000', 'LUX', {
    symbol: 'LUX',
    name: 'Lux',
    decimals: 18,
    priceUSD: 2,
    volumeUSD: 1000,
    tvlUSD: 5000,
    totalSupply: 100,
    circulating: 50,
  })

test('a token carries the market figures the page reads', () => {
  const m = token().market
  for (const key of ['totalValueLocked', 'price', 'volume24H', 'marketCap', 'fullyDilutedValuation']) {
    assert.ok(key in m, `market is missing ${key}`)
  }
  // The page asks for volume as `volume24H: volume(duration: DAY)`. Resolving
  // only `volume` leaves it reading undefined.
  assert.equal(m.volume24H.value, 1000)
  assert.equal(m.marketCap.value, 100, 'price x circulating')
  assert.equal(m.fullyDilutedValuation.value, 200, 'price x total supply')
})

test('a year high and low are stated, even with no year of prices', () => {
  const m = token().market
  // Present and null — nothing here keeps a year of prices, and the page draws
  // null as the dash it draws for any figure it lacks. Absent, it would take the
  // whole token down with it.
  assert.ok('priceHigh52W' in m && 'priceLow52W' in m)
  assert.equal(m.priceHigh52W, null)
})

test('the project states what the page selects of it', () => {
  const p = token().project
  for (const key of ['id', 'name', 'logoUrl', 'isSpam', 'description', 'homepageUrl', 'twitterName', 'markets', 'tokens']) {
    assert.ok(key in p, `project is missing ${key}`)
  }
})

test('the project quotes the same valuation the market does', () => {
  const t = token()
  const pm = t.project.markets[0]
  // Two readings of one number. The page draws its header figures off the
  // project's list rather than the market, and two spellings of the arithmetic
  // is how they come to disagree.
  assert.equal(pm.marketCap.value, t.market.marketCap.value)
  assert.equal(pm.fullyDilutedValuation.value, t.market.fullyDilutedValuation.value)
})

test('each token under the project carries its market', () => {
  const t = token()
  const listed = t.project.tokens[0]
  assert.ok(listed.market, 'the project lists a token with no market')
  assert.equal(listed.market.price.value, t.market.price.value)
})

test('an unknown supply yields no valuation rather than a zero one', () => {
  const t = tokenResponseFromUsd('0xabc', 'LUX', {
    symbol: 'X', name: 'X', decimals: 18, priceUSD: 2, volumeUSD: 0, tvlUSD: 0,
  })
  // A valuation of an unknown supply has no meaning; zero would say the token is
  // worth nothing. Null renders as the dash the page already draws.
  assert.equal(t.market.marketCap, null)
  assert.equal(t.market.fullyDilutedValuation, null)
  assert.equal(t.project.markets[0].marketCap, null)
})

// Convert carries no chain, so the chain check would hand it to a graph with no
// `convert` field. It is answered before that check, like tokenProjects.
function ask(body: any): Promise<any> {
  return new Promise((resolve) => {
    handleGraphQL({ body } as any, { json: resolve } as any)
  })
}

test('a currency converts to itself at par', async () => {
  const out = await ask({
    operationName: 'Convert',
    variables: { fromCurrency: 'USD', toCurrency: 'USD' },
  })
  assert.equal(out.data.convert.value, 1)
  assert.equal(out.data.convert.currency, 'USD')
})

test('a pair with no rate answers nothing rather than a made-up rate', async () => {
  const out = await ask({
    operationName: 'Convert',
    variables: { fromCurrency: 'USD', toCurrency: 'EUR' },
  })
  // Everything here is priced in USD. Returning 1 would state that a dollar is a
  // euro; null is read as "priced in USD" and leaves the figures alone.
  assert.equal(out.data.convert, null)
})

// The app asks for tokens on chains this API does not serve, USDC on BASE among
// them. It has none there, and says so, rather than handing a Uniswap query to a
// graph that cannot parse it.
test('a token on another chain is no token, not an error', async () => {
  for (const chain of ['ETHEREUM', 'BASE']) {
    const out = await ask({
      operationName: 'Token',
      query: 'query Token($chain: Chain!, $address: String) { token(chain: $chain, address: $address) { id } }',
      variables: { chain, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    })
    assert.deepEqual(out, { data: { token: null } })
  }
})
