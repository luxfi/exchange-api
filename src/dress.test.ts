import test from 'node:test'
import assert from 'node:assert/strict'

// The transform needs no network: what it needs is handed to it.
const bare = { usd: new Map<string, number>(), supply: new Map<string, number>(), nativeUSD: 0 }
import { dress } from './graphql'

// A token page issues a raw subgraph query, so what it reads has to be dressed
// on the way out or it reads the chain's own answer while the list beside it
// reads ours. The wrapper is the case that shows it: Lux and Zoo share bytecode,
// and bytecode carries the name string, so Zoo's coin calls itself Wrapped LUX.
test('a raw token row wears the registry name, not the contract name', () => {
  const body = {
    data: {
      tokens: [
        { id: '0x4888E4a2Ee0F03051c72D2BD3ACf755eD3498B3E', symbol: 'WLUX', name: 'Wrapped LUX' },
      ],
    },
  }
  const out = dress(body, bare)
  const row = out.data.tokens[0]
  assert.notEqual(row.symbol, 'WLUX', 'the wrapper kept the contract symbol')
  assert.notEqual(row.name, 'Wrapped LUX', 'the wrapper kept the contract name')
})

// The same row nested under a pool has to say the same thing. A pool listing
// naming the token one way beside a page naming it another is the same defect
// twice.
test('a token nested in a pool is dressed too', () => {
  const body = {
    data: {
      pools: [
        {
          id: '0xpool',
          token0: { id: '0x4888E4a2Ee0F03051c72D2BD3ACf755eD3498B3E', symbol: 'WLUX', name: 'Wrapped LUX' },
        },
      ],
    },
  }
  const out = dress(body, bare)
  assert.notEqual(out.data.pools[0].token0.symbol, 'WLUX')
})

// Only fields the client selected. A row that did not ask for a supply must not
// come back carrying one — the client caches on the shape it asked for.
test('dressing adds no field the query did not select', () => {
  const body = { data: { tokens: [{ id: '0x4888E4a2Ee0F03051c72D2BD3ACf755eD3498B3E', symbol: 'WLUX', name: 'x' }] } }
  const out = dress(body, bare)
  assert.deepEqual(Object.keys(out.data.tokens[0]).sort(), ['id', 'name', 'symbol'])
})

// A token the registry does not carry is left exactly as the chain reported it.
test('an unknown token is untouched', () => {
  const body = { data: { tokens: [{ id: '0x00000000000000000000000000000000000000ff', symbol: 'NOPE', name: 'Nope' }] } }
  const out = dress(body, bare)
  assert.equal(out.data.tokens[0].symbol, 'NOPE')
  assert.equal(out.data.tokens[0].name, 'Nope')
})

// An empty or errored response passes straight through.
test('a response with no data is returned as-is', () => {
  assert.deepEqual(dress({ data: null }, bare), { data: null })
  assert.deepEqual(dress({ errors: [{ message: 'boom' }] }, bare), { errors: [{ message: 'boom' }] })
})

// An asset we issue declares its supply on its home chain; the row on any other
// chain holds the slice bridged there. Valuing that slice as the whole asset is
// how one token reported two fully diluted values an order of magnitude apart.
test('a bridged row reports the asset supply, not its own slice', () => {
  const zoo = { usd: new Map([['zoo', 0.0000129]]), supply: new Map([['zoo', 2e12]]), nativeUSD: 0.00044 }
  const body = {
    data: {
      tokens: [
        { id: '0x5e5290F350352768bD2bFC59C2DA15Dd04a7cB88', symbol: 'LZOO', name: 'Lux ZOO', totalSupply: '10863299479', derivedETH: '0.0459' },
      ],
    },
  }
  const out = dress(body, zoo)
  assert.equal(out.data.tokens[0].totalSupply, '2000000000000')
  assert.equal(Number(out.data.tokens[0].derivedETH).toFixed(6), (0.0000129 / 0.00044).toFixed(6))
})
