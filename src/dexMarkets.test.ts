import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  filterRealMarkets,
  isStructurallyReal,
  isCrossed,
  parseTokenRef,
  type RawMarket,
  type AssetVerifier,
} from './dexMarkets'
import type { Address } from 'viem'

// Real synthetic-seed rows captured live from the devnet dex subgraph
// (api-exchange.lux-dev.network). These are EXACTLY what the gate must reject.
const SYNTH_LUX_LUSD: RawMarket = {
  id: '4c55582f4c5553440000000000000000000000000000000000000000000000d0',
  symbol: 'LUX/LUSD',
  bestBid: '12.4875',
  bestAsk: '5', // bid > ask => CROSSED — impossible for a real matched book
  baseToken: '0000000000000000000000000000000000000000000000000000000000000000',
  quoteToken: '000000000000000000000000000000000000000000000000004c555344000001',
  assetsBound: true,
}
const SYNTH_LUX_LETH: RawMarket = {
  id: '4c55582f4c4554480000000000000000000000000000000000000000000000d0',
  symbol: 'LUX/LETH',
  bestBid: '0.003996',
  bestAsk: '0.004004', // not crossed, but quoteToken is a phantom (ascii "LETH") address
  baseToken: '0000000000000000000000000000000000000000000000000000000000000000',
  quoteToken: '000000000000000000000000000000000000000000000000004c455448000001',
  assetsBound: true,
}
const PLACEHOLDER: RawMarket = {
  id: '32bb228d59d9770be8c4ec1153267135f294bfcc0a96bab8f54c408e3735cebd',
  symbol: '32bb228d59d9770be8c4ec1153267135f294bfcc0a96bab8f54c408e3735cebd',
  bestBid: '0',
  bestAsk: '0',
  baseToken: '',
  quoteToken: '',
  assetsBound: false,
}

// A genuinely real market: native LUX base + a real on-chain LUSD quote (20-byte
// address that the verifier confirms has code + decimals()).
const REAL_LUSD = '0x848Cff46eb323f323b6Bbe1Df274E40793d7f2c2'
const REAL_LUX_LUSD: RawMarket = {
  id: 'real-lux-lusd',
  symbol: 'LUX/LUSD',
  bestBid: '4.9',
  bestAsk: '5.1', // uncrossed
  baseToken: '0000000000000000000000000000000000000000000000000000000000000000',
  quoteToken: '000000000000000000000000' + REAL_LUSD.slice(2).toLowerCase(),
  assetsBound: true,
}

// Verifier that recognizes ONLY the real LUSD contract (mirrors a network where
// just that asset is deployed). Phantom addresses → false.
const onlyRealLusd: AssetVerifier = async (a: Address) =>
  a.toLowerCase() === REAL_LUSD.toLowerCase()
// Verifier that fails everything — models a fresh network with no real assets
// deployed (e.g. devnet today). Every EVM market must then be rejected.
const verifyNone: AssetVerifier = async () => false

// ── isCrossed ────────────────────────────────────────────────────────────────
test('isCrossed: bid >= ask is crossed; one-sided/empty is not', () => {
  assert.equal(isCrossed('12.4875', '5'), true) // the synthetic LUX/LUSD book
  assert.equal(isCrossed('5', '5'), true) // touching counts as crossed
  assert.equal(isCrossed('4.9', '5.1'), false) // healthy book
  assert.equal(isCrossed('0', '5'), false) // one side empty — thin, not crossed
  assert.equal(isCrossed(undefined, undefined), false)
})

// ── parseTokenRef ──────────────────────────────────────────────────────────────
test('parseTokenRef: native sentinel, address candidates, and garbage', () => {
  assert.equal(parseTokenRef(SYNTH_LUX_LUSD.baseToken), 'native')
  // phantom ascii-of-symbol id still parses to an ADDRESS candidate (left-padded);
  // it is the on-chain check, not parsing, that rejects it.
  const q = parseTokenRef(SYNTH_LUX_LUSD.quoteToken)
  assert.ok(q !== null && q !== 'native' && typeof q.address === 'string')
  // a real 20-byte ref resolves to that address.
  const r = parseTokenRef('000000000000000000000000' + REAL_LUSD.slice(2).toLowerCase())
  assert.ok(r !== null && r !== 'native' && r.address.toLowerCase() === REAL_LUSD.toLowerCase())
  assert.equal(parseTokenRef(''), null)
  assert.equal(parseTokenRef('not-hex'), null)
  // a 32-byte id with non-zero high bytes is NOT an address candidate.
  assert.equal(parseTokenRef('ff' + '00'.repeat(31)), null)
})

// ── isStructurallyReal ─────────────────────────────────────────────────────────
test('isStructurallyReal: rejects crossed, placeholder, mock/Liquidity symbols', () => {
  assert.equal(isStructurallyReal(SYNTH_LUX_LUSD), false) // crossed
  assert.equal(isStructurallyReal(PLACEHOLDER), false) // not assetsBound + hex symbol
  assert.equal(isStructurallyReal(SYNTH_LUX_LETH), true) // structurally ok (killed later on-chain)
  assert.equal(isStructurallyReal(REAL_LUX_LUSD), true)
  for (const sym of ['LIQUID/LUSD', 'MOCK/LUSD', 'TEST/LUX', 'LUX/SYNTH', 'LUXLUSD', '0xdead/LUSD']) {
    assert.equal(isStructurallyReal({ ...REAL_LUX_LUSD, symbol: sym }), false, sym)
  }
})

// ── filterRealMarkets: the gate ────────────────────────────────────────────────
test('gate rejects ALL synthetic seed rows, keeps only on-chain-verified markets', async () => {
  const input = [SYNTH_LUX_LUSD, SYNTH_LUX_LETH, PLACEHOLDER, REAL_LUX_LUSD]
  const { markets, acceptedIds } = await filterRealMarkets(input, onlyRealLusd)
  assert.deepEqual(
    markets.map((m) => m.id),
    ['real-lux-lusd'],
    'only the real LUX/LUSD (native + on-chain LUSD) survives',
  )
  assert.ok(acceptedIds.has('real-lux-lusd'))
  assert.equal(acceptedIds.has(SYNTH_LUX_LUSD.id), false)
  assert.equal(acceptedIds.has(SYNTH_LUX_LETH.id), false)
})

test('gate yields EMPTY on a network with no real assets deployed (devnet today)', async () => {
  const input = [SYNTH_LUX_LUSD, SYNTH_LUX_LETH, PLACEHOLDER, REAL_LUX_LUSD]
  const { markets } = await filterRealMarkets(input, verifyNone)
  assert.deepEqual(markets, [], 'no verifiable assets => No active markets')
})

// Mirrors graphql.sanitizeDexData's per-collection drop logic.
const keepOrder = (acceptedIds: Set<string>) => (r: any) =>
  typeof r?.market === 'string' && acceptedIds.has(r.market)
const filterFills = (fills: any[], acceptedIds: Set<string>) =>
  acceptedIds.size === 0
    ? []
    : fills.filter((r) => r?.market === undefined || acceptedIds.has(r.market))

test('orders are filtered precisely to accepted markets (they carry a market id)', async () => {
  const { acceptedIds } = await filterRealMarkets([SYNTH_LUX_LUSD, REAL_LUX_LUSD], onlyRealLusd)
  const orders = [
    { id: '1', market: SYNTH_LUX_LUSD.id, price: '5' }, // rejected market
    { id: '2', market: 'real-lux-lusd', price: '5.1' }, // accepted market
  ]
  assert.deepEqual(orders.filter(keepOrder(acceptedIds)).map((o) => o.id), ['2'])
})

test('fail-closed: ALL fills are dropped when zero markets are real (the live shape)', async () => {
  // Real devnet dex `fills` carry makerOrderId/takerOrderId/tradeId but NO market —
  // with every market rejected, none of these synthetic fills may survive.
  const { acceptedIds } = await filterRealMarkets([SYNTH_LUX_LUSD, SYNTH_LUX_LETH], verifyNone)
  assert.equal(acceptedIds.size, 0)
  const liveShapedFills = [
    { id: '172:0', price: '5', size: '10', side: 'buy', makerOrderId: '519691042817', tradeId: 1 },
    { id: '187:0', price: '100', size: '1', side: 'buy', makerOrderId: '798863917057', tradeId: 1 },
  ]
  assert.deepEqual(filterFills(liveShapedFills, acceptedIds), [])
})

test('fills (no market field) survive when at least one market is real', async () => {
  const { acceptedIds } = await filterRealMarkets([REAL_LUX_LUSD], onlyRealLusd)
  assert.equal(acceptedIds.size, 1)
  const fills = [{ id: '172:0', price: '5', size: '10', side: 'buy', tradeId: 1 }]
  assert.deepEqual(filterFills(fills, acceptedIds).map((f) => f.id), ['172:0'])
})
