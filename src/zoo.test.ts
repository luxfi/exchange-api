import test from 'node:test'
import assert from 'node:assert/strict'

// One image serves Lux and Zoo, and the network is read once, when networks.ts
// loads. This file is its own process and boots as Zoo, so the network is set
// before anything that reads it is loaded.
process.env.NETWORK = 'zoo'
const { toRankingsStat } = require('./explore') as typeof import('./explore')
const { handleGraphQL } = require('./graphql') as typeof import('./graphql')

function ask(body: any): Promise<any> {
  return new Promise((resolve) => {
    handleGraphQL({ body } as any, { json: resolve } as any)
  })
}

// The app draws each row's chain badge from this label.
test("Zoo's ranked tokens are on Zoo's chain", () => {
  const stat = toRankingsStat({
    address: '0x0000000000000000000000000000000000000000',
    symbol: 'ZOO',
    name: 'Zoo',
    decimals: 18,
    priceUSD: 0,
    volumeUSD: 0,
    tvlUSD: 0,
    logoUrl: 'https://exchange.zoo.network/tokens/zoo.svg',
  })
  assert.equal(stat.chain, 'ZOO')
})

test("Zoo's deployment holds nothing on Lux's chain", async () => {
  assert.deepEqual(await ask({ operationName: 'TopTokens', variables: { chain: 'LUX' } }), { data: { topTokens: [] } })
  assert.deepEqual(await ask({ operationName: 'Token', variables: { chain: 'LUX', address: null } }), {
    data: { token: null },
  })
})
