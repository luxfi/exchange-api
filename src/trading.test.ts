// MUST be first: pins SUBGRAPH_URL to the public AMM endpoint before ./trading (and its
// transitive ./subgraph) capture it at module load. In CommonJS, imports compile to
// ordered require() calls, so this side-effect import runs before the ones below.
import { PUBLIC_GRAPH } from './test-graph-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fetch from 'node-fetch'
import type { Request, Response } from 'express'
import { handleSwappableTokens, handleQuote, handleCheckApproval, buildSwappableTokens } from './trading'
import { getClient, ADDRESSES, NATIVE_SENTINEL } from './dexRouter'
import { LUX_TOKENS } from './lux-tokens'

const CYRUS = '0x0A78f7Ce8D65e0FD4D6B78848483bA3C4fb895c5'
const WLUX = ADDRESSES.WLUX
const LUSD = ADDRESSES.LUSD
const SWAPPER = '0x0000000000000000000000000000000000000001'
const ONE = '1000000000000000000'
// Junk the AMM indexer picked up but which are NOT real Lux assets (fake USDC/USDT).
// Curated curation must exclude these from the swappable set, by construction.
const JUNK_USDC = '0x8031e9b0d02a792cfefaa2bdca6e1289d385426f'
const JUNK_USDT = '0xdf1de693c31e2a5eb869c329529623556b20abf3'

// Minimal Express req/res doubles capturing the status code + JSON body.
interface Captured {
  status: number
  body: any
}

function mockRes(): { res: Response; captured: Captured } {
  const captured: Captured = { status: 200, body: undefined }
  const res = {
    status(code: number) {
      captured.status = code
      return this
    },
    json(payload: any) {
      captured.body = payload
      return this
    },
  } as unknown as Response
  return { res, captured }
}

function mockReq(opts: { query?: any; body?: any }): Request {
  return { query: opts.query ?? {}, body: opts.body ?? {} } as unknown as Request
}

async function reachable(): Promise<boolean> {
  try {
    await getClient().getBlockNumber()
    return true
  } catch (e) {
    console.warn('[trading.test] RPC unreachable, skipping live asserts:', (e as Error).message)
    return false
  }
}

// The AMM graph is the discovery source for swappable_tokens. Guard the CYRUS-presence
// assert behind its reachability so CI stays green when neither graph host resolves,
// while still asserting real discovery when it does.
async function graphReachable(): Promise<boolean> {
  try {
    const res = await fetch(process.env.SUBGRAPH_URL || PUBLIC_GRAPH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ pools(first: 1) { id } }' }),
      signal: AbortSignal.timeout(10000),
    })
    const data = (await res.json()) as { data?: { pools?: unknown[] } }
    return Array.isArray(data?.data?.pools)
  } catch (e) {
    console.warn('[trading.test] AMM graph unreachable, skipping discovery assert:', (e as Error).message)
    return false
  }
}

// ── swappable_tokens ──────────────────────────────────────────────────────────

test('LIVE swappable_tokens: chainId param does not gate the single-chain Lux token set', async () => {
  if (!(await graphReachable())) return
  const { res, captured } = mockRes()
  await handleSwappableTokens(mockReq({ query: { tokenInChainId: '1' } }), res)
  assert.equal(captured.status, 200)
  assert.ok(typeof captured.body.requestId === 'string')
  const tokens = captured.body.tokens as any[]
  // Single-chain venue: a transient/foreign chainId still yields the Lux tokens,
  // each carrying its real chainId 96369 — never an empty list (which the FE shows
  // as "Couldn't load tokens").
  assert.ok(Array.isArray(tokens) && tokens.length > 1, 'chainId=1 must still return the Lux set')
  assert.equal(tokens[0].symbol, 'LUX')
  assert.ok(tokens.every((t) => t.chainId === 96369), 'every token carries chainId 96369')
})

test('LIVE swappable_tokens: native LUX first, includes CYRUS, every decimals is a number', async () => {
  if (!(await graphReachable())) return
  const { res, captured } = mockRes()
  await handleSwappableTokens(mockReq({ query: { tokenInChainId: '96369' } }), res)
  assert.equal(captured.status, 200)
  const tokens = captured.body.tokens as any[]
  assert.ok(Array.isArray(tokens) && tokens.length > 1, 'discovery must yield more than just native')
  // Native LUX is first (sentinel address).
  assert.equal(tokens[0].address, NATIVE_SENTINEL)
  assert.equal(tokens[0].symbol, 'LUX')
  // decimals MUST be a number for every entry; project shape is well-formed.
  for (const t of tokens) {
    assert.equal(typeof t.decimals, 'number', `decimals must be number for ${t.symbol}`)
    assert.equal(t.isSpam, false)
    assert.equal(t.project.safetyLevel, 'VERIFIED')
    assert.ok(t.project.logo === null || typeof t.project.logo.url === 'string')
  }
  // CYRUS must be present.
  assert.ok(
    tokens.some((t) => t.address.toLowerCase() === CYRUS.toLowerCase()),
    'CYRUS must appear in swappable_tokens',
  )
})

// ── swappable_tokens: curated source of truth (pure, no network) ───────────────

test('lux-tokens: curated data has LUX/WLUX/LUSD and excludes the indexed junk USDC/USDT', () => {
  const set = new Set(LUX_TOKENS.map((t) => t.address.toLowerCase()))
  assert.ok(set.has(NATIVE_SENTINEL.toLowerCase()), 'native LUX sentinel present')
  assert.ok(set.has(WLUX.toLowerCase()), 'WLUX present')
  assert.ok(set.has(LUSD.toLowerCase()), 'LUSD present')
  assert.ok(!set.has(JUNK_USDC), 'fake USDC must not be curated')
  assert.ok(!set.has(JUNK_USDT), 'fake USDT must not be curated')
})

test('buildSwappableTokens([]): curated list is the source of truth — native first, junk excluded, shape valid', () => {
  const tokens = buildSwappableTokens([])
  // Native LUX is always first (sentinel address).
  assert.equal(tokens[0].address, NATIVE_SENTINEL)
  assert.equal(tokens[0].symbol, 'LUX')
  // Exactly one entry per curated token — never fewer (immune to the subgraph thin-list
  // bug) and never more (junk can't be added).
  assert.equal(tokens.length, LUX_TOKENS.length)
  const addrs = new Set(tokens.map((t) => t.address.toLowerCase()))
  assert.ok(addrs.has(WLUX.toLowerCase()), 'WLUX present')
  assert.ok(addrs.has(LUSD.toLowerCase()), 'LUSD present')
  assert.ok(!addrs.has(JUNK_USDC), 'fake USDC excluded')
  assert.ok(!addrs.has(JUNK_USDT), 'fake USDT excluded')
  // Shape: decimals numeric, project well-formed, chainId pinned to 96369.
  for (const t of tokens) {
    assert.equal(t.chainId, 96369)
    assert.equal(typeof t.decimals, 'number')
    assert.equal(t.isSpam, false)
    assert.equal(t.project.safetyLevel, 'VERIFIED')
    assert.ok(t.project.logo === null || typeof t.project.logo.url === 'string')
  }
})

test('buildSwappableTokens(order): subgraph ranks curated tokens but never changes membership', () => {
  // Subgraph reports LUSD first (highest liquidity) plus a junk address it indexed.
  const tokens = buildSwappableTokens([LUSD.toLowerCase(), JUNK_USDC])
  // Native always first; LUSD becomes the first NON-native (ranked #1 by the subgraph).
  assert.equal(tokens[0].address, NATIVE_SENTINEL)
  assert.equal(tokens[1].address.toLowerCase(), LUSD.toLowerCase(), 'subgraph rank orders LUSD first')
  // Membership unchanged: full curated set, junk still absent (the rank for junk is ignored).
  assert.equal(tokens.length, LUX_TOKENS.length)
  assert.ok(!new Set(tokens.map((t) => t.address.toLowerCase())).has(JUNK_USDC))
})

// ── quote ─────────────────────────────────────────────────────────────────────

test('quote: foreign tokenInChainId yields a 404 QUOTE_ERROR, not a 500', async () => {
  const { res, captured } = mockRes()
  await handleQuote(
    mockReq({
      body: {
        type: 'EXACT_INPUT',
        amount: ONE,
        tokenInChainId: 1,
        tokenOutChainId: 1,
        tokenIn: CYRUS,
        tokenOut: WLUX,
        swapper: SWAPPER,
      },
    }),
    res,
  )
  assert.equal(captured.status, 404)
  assert.equal(captured.body.errorCode, 'QUOTE_ERROR')
})

test('quote: a malformed amount is a 400 boundary error', async () => {
  const { res, captured } = mockRes()
  await handleQuote(
    mockReq({
      body: { type: 'EXACT_INPUT', amount: 'not-a-number', tokenIn: CYRUS, tokenOut: WLUX, swapper: SWAPPER },
    }),
    res,
  )
  assert.equal(captured.status, 400)
})

test('quote: an unroutable pair returns a clean 200 CLASSIC with an empty route, not a 404', async () => {
  const { res, captured } = mockRes()
  // 0x..02 is a precompile address: valid format, on chain 96369, but no V3 pool exists —
  // so bestRoute yields null whether the RPC is up (quoter reverts) or down (read throws).
  // The FE's EXACT_OUTPUT USD-price probe relies on this degrading gracefully (no 404).
  const NO_POOL = '0x0000000000000000000000000000000000000002'
  await handleQuote(
    mockReq({
      body: {
        type: 'EXACT_OUTPUT',
        amount: ONE,
        tokenInChainId: 96369,
        tokenOutChainId: 96369,
        tokenIn: NO_POOL,
        tokenOut: WLUX,
        swapper: SWAPPER,
      },
    }),
    res,
  )
  assert.equal(captured.status, 200, JSON.stringify(captured.body))
  assert.equal(captured.body.routing, 'CLASSIC')
  assert.equal(captured.body.permitData, null)
  assert.ok(typeof captured.body.requestId === 'string')
  const q = captured.body.quote
  // Empty route = the FE's documented "non-null quote, no routes" path → null trade.
  assert.ok(Array.isArray(q.route), 'route must be an array')
  assert.equal(q.route.length, 0, 'no-route quote carries an EMPTY route')
  assert.equal(q.tradeType, 'EXACT_OUTPUT')
  assert.equal(q.chainId, 96369)
})

test('LIVE quote CYRUS→WLUX: CLASSIC, permitData null, route is Array<Array>, decimals are strings, output > 0', async () => {
  if (!(await reachable())) return
  const { res, captured } = mockRes()
  await handleQuote(
    mockReq({
      body: {
        type: 'EXACT_INPUT',
        amount: ONE,
        tokenInChainId: 96369,
        tokenOutChainId: 96369,
        tokenIn: CYRUS,
        tokenOut: WLUX,
        swapper: SWAPPER,
      },
    }),
    res,
  )
  assert.equal(captured.status, 200, JSON.stringify(captured.body))
  const b = captured.body
  assert.equal(b.routing, 'CLASSIC')
  assert.equal(b.permitData, null)
  assert.ok(typeof b.requestId === 'string')

  const q = b.quote
  assert.equal(q.chainId, 96369)
  assert.equal(q.tradeType, 'EXACT_INPUT')

  // route is Array<Array<V3PoolInRoute>>.
  assert.ok(Array.isArray(q.route), 'route must be an array')
  assert.ok(Array.isArray(q.route[0]), 'route[0] must be an array (the single path)')
  assert.equal(q.route[0].length, 2, 'CYRUS→WLUX is a 2-hop path')

  // Every TokenInRoute.decimals is a STRING (the V3PoolInRoute contract).
  for (const hop of q.route[0]) {
    assert.equal(hop.type, 'v3-pool')
    assert.equal(typeof hop.tokenIn.decimals, 'string', 'tokenIn.decimals must be a string')
    assert.equal(typeof hop.tokenOut.decimals, 'string', 'tokenOut.decimals must be a string')
    assert.equal(hop.tokenIn.chainId, 96369)
    // amounts are numeric wei strings.
    assert.match(hop.amountIn, /^\d+$/)
    assert.match(hop.amountOut, /^\d+$/)
    assert.match(hop.fee, /^\d+$/)
  }

  // ClassicOutput.amount is a numeric string > "0".
  assert.match(q.output.amount, /^\d+$/)
  assert.ok(BigInt(q.output.amount) > 0n, 'output amount must be > 0')
  assert.match(q.input.amount, /^\d+$/)
  assert.equal(q.input.amount, ONE, 'EXACT_INPUT input amount is the request amount')

  // priceImpact within [0,100]; routeString reads SYM -> SYM -> SYM.
  assert.ok(q.priceImpact >= 0 && q.priceImpact <= 100)
  assert.match(q.routeString, /CYRUS -> LUSD -> WLUX/)

  // Boundary token echo: input is CYRUS, output is WLUX (caller passed WLUX, not native).
  assert.equal(q.input.token.toLowerCase(), CYRUS.toLowerCase())
  assert.equal(q.output.token.toLowerCase(), WLUX.toLowerCase())
})

// ── check_approval ──────────────────────────────────────────────────────────

test('check_approval: native sentinel needs no approval (approval null)', async () => {
  const { res, captured } = mockRes()
  await handleCheckApproval(
    mockReq({
      body: { walletAddress: SWAPPER, token: NATIVE_SENTINEL, amount: ONE, chainId: 96369 },
    }),
    res,
  )
  assert.equal(captured.status, 200)
  assert.equal(captured.body.approval, null)
  assert.ok(typeof captured.body.requestId === 'string')
})

test('LIVE check_approval CYRUS for a zero-allowance wallet yields an approve tx to the token', async () => {
  if (!(await reachable())) return
  const { res, captured } = mockRes()
  // SWAPPER (0x..01) holds no CYRUS and has granted no allowance → expect a build.
  await handleCheckApproval(
    mockReq({
      body: { walletAddress: SWAPPER, token: CYRUS, amount: ONE, chainId: 96369 },
    }),
    res,
  )
  assert.equal(captured.status, 200, JSON.stringify(captured.body))
  const approval = captured.body.approval
  assert.ok(approval, 'a zero-allowance wallet must get an approval tx')
  assert.equal(approval.to.toLowerCase(), CYRUS.toLowerCase())
  assert.equal(approval.from.toLowerCase(), SWAPPER.toLowerCase())
  assert.equal(approval.value, '0')
  assert.equal(approval.chainId, 96369)
  // approve(spender, MaxUint256) → selector 0x095ea7b3.
  assert.ok(approval.data.startsWith('0x095ea7b3'), 'must be an ERC20 approve calldata')
})
