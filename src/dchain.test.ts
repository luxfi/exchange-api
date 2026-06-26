import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  marketToRaw,
  orderToFe,
  tradeToFill,
  firstArg,
  queryDChain,
  type DexGet,
} from './dchain'

// These prove the translation from the D-Chain read surface (dex/pkg/dchain/read.go
// JSON) to the FE's dex-schema shapes (exchange/apps/web dexSubgraph.ts) without a
// network: the mappers are pure, and queryDChain takes an injectable transport.

// Canonical custody market as read.go's dex_get_markets emits it: numeric
// prices/sizes, hex 32-byte asset ids, native LUX base (all-zero), on-chain LUSD
// quote (left-padded 20-byte address).
const MKT_LUSD = {
  poolId: 'ab'.repeat(32),
  symbol: 'LUX/LUSD',
  base: '0'.repeat(64),
  quote: '000000000000000000000000848cff46eb323f323b6bbe1df274e40793d7f2c2',
  assetsBound: true,
  orders: 4,
  remaining: 40,
  bestBid: 4.9,
  bestAsk: 5.1,
}

test('marketToRaw maps read.go marketJSON to the FE DexMarket/RawMarket shape', () => {
  const r = marketToRaw(MKT_LUSD) as any
  assert.equal(r.id, MKT_LUSD.poolId)
  assert.equal(r.symbol, 'LUX/LUSD')
  // FE reads these as strings; read.go emits numbers.
  assert.equal(r.bestBid, '4.9')
  assert.equal(r.bestAsk, '5.1')
  assert.equal(r.remaining, '40')
  assert.equal(r.openOrders, 4) // number
  assert.equal(r.baseToken, MKT_LUSD.base)
  assert.equal(r.quoteToken, MKT_LUSD.quote)
  assert.equal(r.assetsBound, true)
})

test('marketToRaw on an unbound placeholder: empty asset refs, assetsBound false', () => {
  const r = marketToRaw({ poolId: 'cd'.repeat(32), symbol: 'aabbcc', assetsBound: false }) as any
  assert.equal(r.baseToken, '') // gate rejects an empty ref → placeholder dropped
  assert.equal(r.quoteToken, '')
  assert.equal(r.assetsBound, false)
  assert.equal(r.bestBid, '0')
  assert.equal(r.bestAsk, '0')
})

test('orderToFe maps read.go orderJSON, tagging the market id for FE filtering', () => {
  const o = orderToFe({ orderId: 7, side: 'sell', price: 5.1, size: 10, remaining: 8, user: 'maker' }, 'abab')
  assert.deepEqual(o, {
    id: 'abab-7',
    market: 'abab',
    orderId: 7,
    price: '5.1',
    size: '10',
    remaining: '8',
    side: 'sell',
    user: 'maker',
  })
})

test('tradeToFill maps read.go tradeJSON; id is the <height>-<seq> coordinate', () => {
  const f = tradeToFill({
    height: 7, seq: 2, tradeId: 1, price: 5, size: 10,
    takerSide: 'buy', makerOrderId: 11, takerOrderId: 22, timestamp: 1234,
  })
  assert.deepEqual(f, {
    id: '7-2',
    height: 7,
    price: '5',
    size: '10',
    side: 'buy',
    timestamp: 1234,
    makerOrderId: '11',
    takerOrderId: '22',
    tradeId: 1,
  })
})

test('firstArg parses `first: N`, defaults when absent, bounds the window', () => {
  assert.equal(firstArg('{ fills(first: 50) { id } }', 25), 50)
  assert.equal(firstArg('{ fills { id } }', 25), 25)
  assert.equal(firstArg('{ fills(first: 0) { id } }', 25), 25) // non-positive → default
  assert.equal(firstArg('{ fills(first: 99999) { id } }', 25, 1000), 1000) // capped
})

// ── queryDChain dispatch over an injected transport ──────────────────────────

test('queryDChain markets → {data:{markets:[mapped]}}', async () => {
  const get: DexGet = async (path) => {
    assert.equal(path, '/dex/dex_get_markets')
    return { markets: [MKT_LUSD] }
  }
  const res = await queryDChain({ query: '{ markets { id symbol bestBid } }' }, get)
  assert.equal(res.data.markets.length, 1)
  assert.equal(res.data.markets[0].id, MKT_LUSD.poolId)
  assert.equal(res.data.markets[0].bestBid, '4.9')
})

test('queryDChain orders enumerates markets then fans out per-market, tagging market', async () => {
  const calls: string[] = []
  const get: DexGet = async (path) => {
    calls.push(path)
    if (path === '/dex/dex_get_markets') return { markets: [{ poolId: 'aa', symbol: 'LUX/LUSD', assetsBound: true }] }
    if (path === '/dex/dex_get_orders?market=aa') {
      return { orders: [{ orderId: 1, side: 'buy', price: 4.9, size: 10, remaining: 10, user: 'maker' }] }
    }
    throw new Error(`unexpected path ${path}`)
  }
  const res = await queryDChain({ query: '{ orders(first: 500) { id market price } }' }, get)
  assert.deepEqual(calls, ['/dex/dex_get_markets', '/dex/dex_get_orders?market=aa'])
  assert.equal(res.data.orders.length, 1)
  assert.equal(res.data.orders[0].market, 'aa')
  assert.equal(res.data.orders[0].id, 'aa-1')
  assert.equal(res.data.orders[0].price, '4.9')
})

test('queryDChain fills returns the most-recent `first`, newest-first', async () => {
  const get: DexGet = async (path) => {
    assert.ok(path.startsWith('/dex/dex_get_trades?limit='))
    // read.go returns ASCENDING (height,seq); adapter must tail+reverse to newest-first.
    return {
      trades: [
        { height: 1, seq: 0, tradeId: 1, price: 5, size: 1, takerSide: 'buy' },
        { height: 2, seq: 0, tradeId: 2, price: 6, size: 1, takerSide: 'sell' },
        { height: 3, seq: 0, tradeId: 3, price: 7, size: 1, takerSide: 'buy' },
      ],
    }
  }
  const res = await queryDChain({ query: '{ fills(first: 2) { id price } }' }, get)
  assert.equal(res.data.fills.length, 2)
  assert.equal(res.data.fills[0].id, '3-0') // newest first
  assert.equal(res.data.fills[1].id, '2-0')
})

test('queryDChain on a root outside the FE CLOB surface fails empty', async () => {
  const get: DexGet = async () => {
    throw new Error('must not hit the network for an unsupported root')
  }
  const res = await queryDChain({ query: '{ fundingRates { id } }' }, get)
  assert.deepEqual(res, { data: null })
})
