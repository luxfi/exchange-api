import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ADDRESSES,
  FEE_TIERS,
  encodePath,
  priceImpactPct,
  spotPriceFromSqrt,
  toWrapped,
  isNative,
  bestSingleHop,
  bestRoute,
  getClient,
  NATIVE_SENTINEL,
  type Address,
} from './dexRouter'

// Live-token addresses (chainId 96369), verified on mainnet.
const CYRUS = '0x0A78f7Ce8D65e0FD4D6B78848483bA3C4fb895c5' as Address
const WLUX = ADDRESSES.WLUX
const LUSD = ADDRESSES.LUSD
const ONE = 1_000000000000000000n // 1e18

// reachable() probes the RPC once; live tests skip cleanly (CI never flakes) but PASS
// when the node is up (it is, per the ICO).
async function reachable(): Promise<boolean> {
  try {
    await getClient().getBlockNumber()
    return true
  } catch (e) {
    console.warn('[dexRouter.test] RPC unreachable, skipping live asserts:', (e as Error).message)
    return false
  }
}

// ── Pure: path encoding ───────────────────────────────────────────────────────

test('encodePath: 2-hop CYRUS|3000|LUSD|3000|WLUX equals the expected packed bytes', () => {
  const path = encodePath([CYRUS, LUSD, WLUX], [3000, 3000])
  // tokenIn(20) | fee(3) | token(20) | fee(3) | tokenOut(20) = 66 bytes = 132 hex chars.
  const expected =
    '0x' +
    CYRUS.slice(2).toLowerCase() +
    '000bb8' + // 3000 as uint24 (3 bytes)
    LUSD.slice(2).toLowerCase() +
    '000bb8' +
    WLUX.slice(2).toLowerCase()
  assert.equal(path.toLowerCase(), expected)
  assert.equal((path.length - 2) / 2, 66) // byte length
})

test('encodePath: single-hop CYRUS|3000|LUSD is 43 bytes', () => {
  const path = encodePath([CYRUS, LUSD], [3000])
  assert.equal((path.length - 2) / 2, 43) // 20 + 3 + 20
})

test('encodePath: rejects mismatched tokens/fees lengths', () => {
  assert.throws(() => encodePath([CYRUS, LUSD], [3000, 3000]), /must be fees/)
})

// ── Pure: fee-tier list is exactly [500, 3000, 10000] ─────────────────────────

test('FEE_TIERS enumerates the three canonical tiers', () => {
  assert.deepEqual([...FEE_TIERS], [500, 3000, 10000])
})

// ── Pure: native handling ─────────────────────────────────────────────────────

test('toWrapped substitutes WLUX for the native sentinel and checksums others', () => {
  assert.equal(toWrapped(NATIVE_SENTINEL), WLUX)
  assert.equal(toWrapped(CYRUS.toLowerCase()), CYRUS)
  assert.ok(isNative(NATIVE_SENTINEL))
  assert.ok(!isNative(CYRUS))
})

// ── Pure: price impact clamps to 0..100 ───────────────────────────────────────

test('priceImpactPct clamps into [0,100] and is 0 for degenerate inputs', () => {
  assert.equal(priceImpactPct(1, 1), 0) // execution == spot → no impact
  assert.ok(priceImpactPct(0.9, 1) > 9 && priceImpactPct(0.9, 1) < 11) // ~10%
  assert.equal(priceImpactPct(2, 1), 0) // execution better than spot → clamp up to 0
  // A catastrophic ratio stays inside the band: exec/spot = 0.0001 → (1-0.0001)*100 = 99.99.
  const v = priceImpactPct(0.0001, 1)
  assert.ok(v >= 0 && v <= 100)
  assert.ok(Math.abs(v - 99.99) < 1e-6)
  // Impact never exceeds 100 for positive finite inputs (the >100 clamp is defensive);
  // an extreme ratio saturates at the 100 ceiling. Every output stays within the band.
  assert.ok(priceImpactPct(1e-300, 1) <= 100)
  // spot <= 0 or non-finite → 0
  assert.equal(priceImpactPct(1, 0), 0)
  assert.equal(priceImpactPct(Number.NaN, 1), 0)
})

test('spotPriceFromSqrt returns 0 for a zero sqrt and a positive number otherwise', () => {
  assert.equal(spotPriceFromSqrt(0n), 0)
  assert.ok(spotPriceFromSqrt(2n ** 96n) > 0) // sqrt = 1.0 → price 1.0
  assert.ok(Math.abs(spotPriceFromSqrt(2n ** 96n) - 1) < 1e-9)
})

// ── Live: fee-tier selection picks the non-reverting tier ─────────────────────

test('LIVE bestSingleHop(WLUX→LUSD) selects fee 3000 (the only live tier)', async () => {
  if (!(await reachable())) return
  const best = await bestSingleHop(WLUX, LUSD, ONE, 'EXACT_INPUT')
  assert.ok(best, 'WLUX→LUSD must have a non-reverting tier')
  assert.equal(best!.fee, 3000, 'only fee 3000 exists for WLUX/LUSD')
  assert.ok(best!.amount > 0n, 'amountOut must be positive')
})

test('LIVE bestSingleHop(CYRUS→LUSD) selects fee 3000 and returns a sane amount', async () => {
  if (!(await reachable())) return
  const best = await bestSingleHop(CYRUS, LUSD, ONE, 'EXACT_INPUT')
  assert.ok(best, 'CYRUS→LUSD must have a non-reverting tier')
  assert.equal(best!.fee, 3000)
  assert.ok(best!.amount > 0n)
  // ~0.51 LUSD per CYRUS (order-of-magnitude; market moves). Bound generously.
  const human = Number(best!.amount) / 1e18
  assert.ok(human > 0.01 && human < 50, `CYRUS→LUSD ~0.51 expected, got ${human}`)
})

// ── Live: routes ──────────────────────────────────────────────────────────────

test('LIVE bestRoute(CYRUS→WLUX, EXACT_INPUT) is a 2-hop via LUSD with amountOut > 0', async () => {
  if (!(await reachable())) return
  const route = await bestRoute(CYRUS, WLUX, ONE, 'EXACT_INPUT')
  assert.ok(route, 'CYRUS→WLUX must route (forced 2-hop)')
  assert.equal(route!.hops.length, 2, 'no direct CYRUS/WLUX pool → must be 2 hops')
  assert.equal(route!.hops[0].tokenIn.toLowerCase(), CYRUS.toLowerCase())
  assert.equal(route!.hops[0].tokenOut.toLowerCase(), LUSD.toLowerCase(), 'hub is LUSD')
  assert.equal(route!.hops[1].tokenOut.toLowerCase(), WLUX.toLowerCase())
  assert.ok(route!.amountOut > 0n, 'total amountOut must be positive')
  assert.equal(route!.amountIn, ONE, 'EXACT_INPUT keeps amountIn exact')
  assert.ok(route!.priceImpact >= 0 && route!.priceImpact <= 100)
  // Pool state must populate (direct reads, since Multicall3 aggregate3 reverts here):
  // every hop resolves a real pool address with a live sqrtPriceX96 and liquidity.
  for (const h of route!.hops) {
    assert.notEqual(h.poolAddress.toLowerCase(), NATIVE_SENTINEL.toLowerCase(), 'pool must resolve')
    assert.ok(h.sqrtRatioX96 > 0n, 'sqrtRatioX96 must be live')
    assert.ok(h.liquidity > 0n, 'liquidity must be live')
  }
})

test('LIVE bestRoute(WLUX→LUSD, EXACT_INPUT) returns amountOut > 0 (single hop)', async () => {
  if (!(await reachable())) return
  const route = await bestRoute(WLUX, LUSD, ONE, 'EXACT_INPUT')
  assert.ok(route, 'WLUX→LUSD must route')
  assert.ok(route!.amountOut > 0n)
  assert.equal(route!.amountIn, ONE)
  // WLUX→LUSD ~0.000575; bound generously.
  const human = Number(route!.amountOut) / 1e18
  assert.ok(human > 0 && human < 1, `WLUX→LUSD tiny expected, got ${human}`)
})

test('LIVE bestRoute(CYRUS→WLUX, EXACT_OUTPUT) derives an amountIn > 0 for 1 WLUX out', async () => {
  if (!(await reachable())) return
  const route = await bestRoute(CYRUS, WLUX, ONE, 'EXACT_OUTPUT')
  assert.ok(route, 'CYRUS→WLUX EXACT_OUTPUT must route')
  assert.equal(route!.hops.length, 2)
  assert.equal(route!.amountOut, ONE, 'EXACT_OUTPUT keeps amountOut exact')
  assert.ok(route!.amountIn > 0n, 'derived amountIn must be positive')
})
