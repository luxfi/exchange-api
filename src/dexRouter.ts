// dexRouter — pure routing/quoting core for the Lux C-Chain DEX (chainId 96369).
//
// This module is the single source of on-chain truth for swap pricing. It owns NO
// HTTP surface (no Express, no req/res) so it is reusable verbatim by luxfi/broker as
// its "Lux DEX venue". Everything below is computed from live QuoterV2 / V3 pool reads
// via viem `eth_call`; nothing is derived from the AMM graph (which silently drops
// unknown fields and returns empty reserves/prices). The graph is discovery-only and
// lives in subgraph.ts / graphql.ts.
//
// The CYRUS ICO pool is Uniswap-V3 shaped: V2 getReserves reverts, so we ALWAYS quote
// through QuoterV2. CYRUS only pairs with LUSD; CYRUS↔WLUX is therefore a forced 2-hop
// through the LUSD hub. Fee tiers are per-pool and the graph's feeTier is unreliable,
// so we enumerate [500, 3000, 10000] on every leg and keep the best non-reverting tier.

import {
  createPublicClient,
  http,
  getAddress,
  encodePacked,
  type Address,
  type PublicClient,
} from 'viem'
import { getTokenMeta } from './lux-tokens'

// ─────────────────────────────────────────────────────────────────────────────
// Chain + contract constants (canonical registry values for chainId 96369; see
// ~/work/lux/exchange/pkgs/exchange/src/contracts/addresses.ts → LUX_MAINNET_CONTRACTS).
// These — plus the fee-tier list and hub set below — are the ONLY hardcoded values in
// the quoting path. Every amount in a quote comes from an on-chain call.
// ─────────────────────────────────────────────────────────────────────────────

export const CHAIN_ID = 96369

export const ADDRESSES = {
  WLUX: getAddress('0x4888e4a2ee0f03051c72d2bd3acf755ed3498b3e'),
  V3_QUOTER_V2: getAddress('0x15C729fdd833Ba675edd466Dfc63E1B737925A4c'),
  V3_SWAP_ROUTER_02: getAddress('0x939bC0Bca6F9B9c52E6e3AD8A3C590b5d9B9D10E'),
  V3_FACTORY: getAddress('0x80bBc7C4C7a59C899D1B37BC14539A22D5830a84'),
  LUSD: getAddress('0x848Cff46eb323f323b6Bbe1Df274E40793d7f2c2'),
  MULTICALL3: getAddress('0xd25F88CBdAe3c2CCA3Bb75FC4E723b44C0Ea362F'),
} as const

// Native sentinel — represents native LUX. Treated as WLUX for routing/quoting math,
// but echoed back verbatim in token fields when the caller passes it.
export const NATIVE_SENTINEL =
  '0x0000000000000000000000000000000000000000' as Address

// Fee tiers enumerated on every leg. Proven: CYRUS/LUSD and WLUX/LUSD exist ONLY at
// fee 3000; 500/10000 revert. Code tolerates per-tier reverts and picks the best.
export const FEE_TIERS = [500, 3000, 10000] as const

// Routing hubs for 2-hop discovery. A hub equal to tokenIn/tokenOut is skipped.
const HUBS: Address[] = [ADDRESSES.WLUX, ADDRESSES.LUSD]

const MAX_UINT256 = (1n << 256n) - 1n

export type TradeType = 'EXACT_INPUT' | 'EXACT_OUTPUT'

// ─────────────────────────────────────────────────────────────────────────────
// Minimal local ABIs. QuoterV2 funcs are nonpayable but the node executes them as an
// eth_call, so viem readContract returns the outputs without a signer.
// ─────────────────────────────────────────────────────────────────────────────

const QUOTER_V2_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'quoteExactOutputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const

const V3_FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const

const V3_POOL_ABI = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'liquidity',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint128' }],
  },
] as const

const ERC20_ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const

// SwapRouter02 surface used by trading.ts to build calldata. `exactOutput` is included
// (the copied exchange fragment omits it) for multi-hop EXACT_OUTPUT swaps.
export const SWAP_ROUTER_02_ABI = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'exactInput',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'path', type: 'bytes' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'exactOutputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountOut', type: 'uint256' },
          { name: 'amountInMaximum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountIn', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'exactOutput',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'path', type: 'bytes' },
          { name: 'recipient', type: 'address' },
          { name: 'amountOut', type: 'uint256' },
          { name: 'amountInMaximum', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'amountIn', type: 'uint256' }],
  },
] as const

export const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

// ─────────────────────────────────────────────────────────────────────────────
// Public client — bound to LUX_RPC_URL + chain 96369. One lazily-created singleton.
// ─────────────────────────────────────────────────────────────────────────────

const RPC_URL = process.env.LUX_RPC_URL || 'https://api.lux.network/ext/bc/C/rpc'

// NOTE: Multicall3 is deployed on this chain but its `aggregate3` reverts at the top
// level (even with per-call allowFailure), so we do NOT wire `contracts.multicall3` and
// never call viem's multicall action. Batched reads go through the http transport's
// JSON-RPC batching instead (multiple eth_calls, one HTTP request), which works.
const luxChain = {
  id: CHAIN_ID,
  name: 'Lux C-Chain',
  nativeCurrency: { name: 'Lux', symbol: 'LUX', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const

let _client: PublicClient | null = null

/** viem public client bound to the Lux C-Chain RPC. Reused across calls. */
export function getClient(): PublicClient {
  if (!_client) {
    _client = createPublicClient({
      chain: luxChain,
      transport: http(RPC_URL, { batch: true }),
    }) as PublicClient
  }
  return _client
}

// ─────────────────────────────────────────────────────────────────────────────
// Address helpers
// ─────────────────────────────────────────────────────────────────────────────

const ZERO = NATIVE_SENTINEL.toLowerCase()

export function isNative(addr: string): boolean {
  return addr.toLowerCase() === ZERO
}

/** Substitute WLUX for the native sentinel; otherwise checksum the input. */
export function toWrapped(addr: string): Address {
  return isNative(addr) ? ADDRESSES.WLUX : getAddress(addr)
}

// ─────────────────────────────────────────────────────────────────────────────
// Token metadata — prefer the curated lux-tokens list, fall back to on-chain ERC20.
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedToken {
  address: Address
  symbol: string
  decimals: number
}

const _tokenCache = new Map<string, ResolvedToken>()

/**
 * Resolve symbol+decimals for an on-chain token address (sentinel must already be
 * substituted to WLUX by the caller). Curated list first; ERC20 decimals()/symbol()
 * via multicall otherwise. Cached for process lifetime (token metadata is immutable).
 */
export async function resolveToken(addr: Address): Promise<ResolvedToken> {
  const key = addr.toLowerCase()
  const cached = _tokenCache.get(key)
  if (cached) return cached

  const meta = getTokenMeta(addr)
  if (meta) {
    const r: ResolvedToken = {
      address: getAddress(addr),
      symbol: meta.symbol,
      decimals: meta.decimals,
    }
    _tokenCache.set(key, r)
    return r
  }

  // Parallel eth_calls (transport-batched), not Multicall3 — see getPoolState for why.
  const client = getClient()
  const [decimals, symbol] = await Promise.all([
    client
      .readContract({ address: addr, abi: ERC20_ABI, functionName: 'decimals' })
      .then((r) => Number(r))
      .catch(() => 18),
    client
      .readContract({ address: addr, abi: ERC20_ABI, functionName: 'symbol' })
      .then((r) => r as string)
      .catch(() => '???'),
  ])
  const r: ResolvedToken = {
    address: getAddress(addr),
    symbol,
    decimals,
  }
  _tokenCache.set(key, r)
  return r
}

// ─────────────────────────────────────────────────────────────────────────────
// Single-hop quoting via QuoterV2
// ─────────────────────────────────────────────────────────────────────────────

export interface SingleQuote {
  amount: bigint // amountOut for EXACT_INPUT, amountIn for EXACT_OUTPUT
  sqrtPriceX96After: bigint
  gasEstimate: bigint
}

/** quoteExactInputSingle on QuoterV2. Returns null on revert (no pool at that fee). */
export async function quoteExactInputSingle(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  fee: number,
): Promise<SingleQuote | null> {
  try {
    const res = (await getClient().readContract({
      address: ADDRESSES.V3_QUOTER_V2,
      abi: QUOTER_V2_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn,
          tokenOut,
          amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })) as readonly [bigint, bigint, number, bigint]
    return {
      amount: res[0],
      sqrtPriceX96After: res[1],
      gasEstimate: res[3],
    }
  } catch {
    return null
  }
}

/** quoteExactOutputSingle on QuoterV2. Returns null on revert. */
export async function quoteExactOutputSingle(
  tokenIn: Address,
  tokenOut: Address,
  amountOut: bigint,
  fee: number,
): Promise<SingleQuote | null> {
  try {
    const res = (await getClient().readContract({
      address: ADDRESSES.V3_QUOTER_V2,
      abi: QUOTER_V2_ABI,
      functionName: 'quoteExactOutputSingle',
      args: [
        {
          tokenIn,
          tokenOut,
          amount: amountOut,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })) as readonly [bigint, bigint, number, bigint]
    return {
      amount: res[0],
      sqrtPriceX96After: res[1],
      gasEstimate: res[3],
    }
  } catch {
    return null
  }
}

export interface BestSingle extends SingleQuote {
  fee: number
}

/**
 * Best single-hop quote across all fee tiers. For EXACT_INPUT, "best" = max amountOut;
 * for EXACT_OUTPUT, "best" = min amountIn. Tiers that revert are skipped. null if every
 * tier reverts (no pool for this pair at any tier).
 */
export async function bestSingleHop(
  tokenIn: Address,
  tokenOut: Address,
  amount: bigint,
  tradeType: TradeType,
): Promise<BestSingle | null> {
  const quotes = await Promise.all(
    FEE_TIERS.map(async (fee) => {
      const q =
        tradeType === 'EXACT_INPUT'
          ? await quoteExactInputSingle(tokenIn, tokenOut, amount, fee)
          : await quoteExactOutputSingle(tokenIn, tokenOut, amount, fee)
      return q ? ({ ...q, fee } as BestSingle) : null
    }),
  )

  let best: BestSingle | null = null
  for (const q of quotes) {
    if (!q || q.amount === 0n) continue
    if (!best) {
      best = q
      continue
    }
    if (tradeType === 'EXACT_INPUT') {
      if (q.amount > best.amount) best = q // more out is better
    } else {
      if (q.amount < best.amount) best = q // less in is better
    }
  }
  return best
}

// ─────────────────────────────────────────────────────────────────────────────
// Pool metadata (address + slot0 + liquidity) for V3PoolInRoute fields
// ─────────────────────────────────────────────────────────────────────────────

export interface PoolState {
  address: Address
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
}

/**
 * Resolve a V3 pool's address + slot0 + liquidity for (tokenA, tokenB, fee). Batched
 * with multicall. Best-effort: if getPool returns the zero address or slot0/liquidity
 * fail, returns the (possibly zero) address with zeroed state — never throws. The
 * quote itself already proved the pool trades (the quoter did not revert).
 */
export async function getPoolState(
  tokenA: Address,
  tokenB: Address,
  fee: number,
): Promise<PoolState> {
  const client = getClient()
  let poolAddr: Address = NATIVE_SENTINEL
  try {
    poolAddr = (await client.readContract({
      address: ADDRESSES.V3_FACTORY,
      abi: V3_FACTORY_ABI,
      functionName: 'getPool',
      args: [tokenA, tokenB, fee],
    })) as Address
  } catch {
    /* keep zero address — best effort */
  }

  if (isNative(poolAddr)) {
    return { address: poolAddr, sqrtPriceX96: 0n, tick: 0, liquidity: 0n }
  }

  // Read slot0 + liquidity as two independent eth_calls in parallel. The http transport
  // JSON-RPC-batches them into one HTTP round-trip. We deliberately do NOT use viem's
  // multicall action: this chain's Multicall3 `aggregate3` reverts (the top-level CALL
  // fails even with per-call allowFailure), whereas direct contract reads succeed.
  const [slot0, liq] = await Promise.all([
    client
      .readContract({ address: poolAddr, abi: V3_POOL_ABI, functionName: 'slot0' })
      .then((r) => r as readonly [bigint, number, number, number, number, number, boolean])
      .catch(() => null),
    client
      .readContract({ address: poolAddr, abi: V3_POOL_ABI, functionName: 'liquidity' })
      .then((r) => r as bigint)
      .catch(() => null),
  ])

  return {
    address: poolAddr,
    sqrtPriceX96: slot0 ? slot0[0] : 0n,
    tick: slot0 ? Number(slot0[1]) : 0,
    liquidity: liq ?? 0n,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Price impact
// ─────────────────────────────────────────────────────────────────────────────

const Q96 = 2n ** 96n

/**
 * Spot price of token0 in terms of token1, from a pool's sqrtPriceX96:
 *   price1Per0 = (sqrtPriceX96 / 2^96)^2
 * Returned as a float. 0 if sqrtPriceX96 is 0 (pool state unavailable).
 */
export function spotPriceFromSqrt(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 === 0n) return 0
  const ratio = Number(sqrtPriceX96) / Number(Q96)
  return ratio * ratio
}

/**
 * Price impact in percent (0..100): (1 - executionPrice / spotPrice) * 100, clamped.
 * executionPrice and spotPrice must be expressed in the SAME orientation
 * (tokenOut per tokenIn, in human units). Slippage from depth always makes execution
 * worse than spot, so impact is non-negative; we clamp defensively against rounding.
 */
export function priceImpactPct(executionPrice: number, spotPrice: number): number {
  if (!isFinite(executionPrice) || !isFinite(spotPrice) || spotPrice <= 0 || executionPrice <= 0) {
    return 0
  }
  const impact = (1 - executionPrice / spotPrice) * 100
  if (impact < 0) return 0
  if (impact > 100) return 100
  return impact
}

// ─────────────────────────────────────────────────────────────────────────────
// Path encoding (Uniswap V3): tokenIn | fee(3 bytes) | token | fee | tokenOut.
// For EXACT_OUTPUT the SwapRouter expects the path REVERSED (tokenOut..tokenIn); we
// expose both via the `tokens`/`fees` ordering decided by the caller.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode a V3 multi-hop path. `tokens` length must be `fees.length + 1`. fee is a
 * uint24 (3 bytes) between each adjacent token pair. Returns 0x-hex.
 */
export function encodePath(tokens: Address[], fees: number[]): `0x${string}` {
  if (tokens.length !== fees.length + 1) {
    throw new Error(`encodePath: tokens (${tokens.length}) must be fees (${fees.length}) + 1`)
  }
  const types: string[] = ['address']
  const values: (Address | number)[] = [tokens[0]]
  for (let i = 0; i < fees.length; i++) {
    types.push('uint24', 'address')
    values.push(fees[i], tokens[i + 1])
  }
  return encodePacked(types, values)
}

// ─────────────────────────────────────────────────────────────────────────────
// Route — single-hop vs 2-hop through the hub set
// ─────────────────────────────────────────────────────────────────────────────

export interface RouteHop {
  tokenIn: Address
  tokenOut: Address
  fee: number
  amountIn: bigint
  amountOut: bigint
  sqrtRatioX96: bigint
  liquidity: bigint
  tickCurrent: number
  poolAddress: Address
}

export interface Route {
  hops: RouteHop[]
  amountIn: bigint // total input (exact for EXACT_INPUT, derived for EXACT_OUTPUT)
  amountOut: bigint // total output (derived for EXACT_INPUT, exact for EXACT_OUTPUT)
  gasUseEstimate: bigint
  priceImpact: number // 0..100
}

/** Build a RouteHop from a single-hop quote + on-chain pool state. */
async function hopFromSingle(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  amountOut: bigint,
  best: BestSingle,
): Promise<RouteHop> {
  const pool = await getPoolState(tokenIn, tokenOut, best.fee)
  return {
    tokenIn,
    tokenOut,
    fee: best.fee,
    amountIn,
    amountOut,
    sqrtRatioX96: pool.sqrtPriceX96,
    liquidity: pool.liquidity,
    tickCurrent: pool.tick,
    poolAddress: pool.address,
  }
}

// Reference notional (~$ size) for the marginal-price quote, in token units of the leg
// input. We size it small relative to the actual trade so it reflects the near-spot
// (best-obtainable) marginal rate, then compare the real leg's average rate against it.
//
// Why not slot0's sqrtPriceX96? On these pools the naive sqrtPriceX96→price model is
// provably inconsistent with the quoter (off by ~1e8 on CYRUS/LUSD: pool spot ≈ 5.8e7
// LUSD/CYRUS vs quoter 0.51 — the active liquidity sits outside the current tick for
// that direction). The quoter is ground truth, so we take the MARGINAL quoter rate as
// "spot": it needs no decimal/orientation guessing and is exactly the rate a tiny trade
// would get. Price impact = degradation from that marginal rate to the actual average
// rate, composed across hops. This is the conventional router definition of impact.
const MARGINAL_REF_RAW = 1_000000000000000n // 1e15 raw units (~0.001 of an 18-dec token)

/**
 * Aggregate price impact (0..100) across a route's hops. For each leg we quote a small
 * reference input to obtain the marginal (near-spot) rate, then compare the leg's actual
 * average rate to it; the per-leg rates are composed multiplicatively into an overall
 * marginal vs overall execution rate. If any leg's marginal quote is unavailable or the
 * trade is at/above marginal (rounding), impact is 0 for that leg.
 */
async function routePriceImpact(hops: RouteHop[]): Promise<number> {
  let marginalProduct = 1
  let execProduct = 1
  for (const h of hops) {
    // Actual average rate for this leg (tokenOut per tokenIn), in raw units. Decimals
    // cancel in the marginal/exec ratio, so no human conversion is needed.
    if (h.amountIn <= 0n || h.amountOut <= 0n) return 0
    const execRate = Number(h.amountOut) / Number(h.amountIn)

    // Marginal rate from a tiny reference quote on the same pool/fee. Cap the reference
    // at the actual input so we never quote a larger size than the trade itself.
    const refIn = h.amountIn < MARGINAL_REF_RAW ? h.amountIn : MARGINAL_REF_RAW
    const ref = await quoteExactInputSingle(h.tokenIn, h.tokenOut, refIn, h.fee)
    if (!ref || ref.amount <= 0n) return 0 // no clean marginal → report 0, don't guess
    const marginalRate = Number(ref.amount) / Number(refIn)

    execProduct *= execRate
    marginalProduct *= marginalRate
  }
  // executionPrice / spotPrice with both as tokenOut-per-tokenIn → impact via the shared
  // clamp. marginalProduct is the best-obtainable rate, execProduct the realized rate.
  return priceImpactPct(execProduct, marginalProduct)
}

/**
 * Best route for (tokenIn, tokenOut, amount, tradeType). Compares the best single-hop
 * against every viable 2-hop through the hub set [WLUX, LUSD] (skipping a hub equal to
 * tokenIn/tokenOut) and returns the structured winner. For EXACT_INPUT the chain runs
 * forward (out of hop1 = in of hop2); for EXACT_OUTPUT it runs backward (in of hop2 =
 * out of hop1). Inputs are wrapped addresses (native already substituted to WLUX).
 * Returns null only when NO route produces output. Never throws on partial pool state.
 */
export async function bestRoute(
  tokenIn: Address,
  tokenOut: Address,
  amount: bigint,
  tradeType: TradeType,
): Promise<Route | null> {
  const inLc = tokenIn.toLowerCase()
  const outLc = tokenOut.toLowerCase()

  // ── Candidate 1: direct single-hop ──
  const single = await bestSingleHop(tokenIn, tokenOut, amount, tradeType)

  // ── Candidate 2: 2-hop through each eligible hub ──
  const hubs = HUBS.filter((h) => {
    const hl = h.toLowerCase()
    return hl !== inLc && hl !== outLc
  })

  const twoHopRoutes = await Promise.all(
    hubs.map((hub) => buildTwoHop(tokenIn, hub, tokenOut, amount, tradeType)),
  )

  // ── Collect all viable routes ──
  const candidates: Route[] = []

  if (single && single.amount > 0n) {
    const out = tradeType === 'EXACT_INPUT' ? single.amount : amount
    const inp = tradeType === 'EXACT_INPUT' ? amount : single.amount
    const hop = await hopFromSingle(tokenIn, tokenOut, inp, out, single)
    candidates.push({
      hops: [hop],
      amountIn: inp,
      amountOut: out,
      gasUseEstimate: single.gasEstimate,
      priceImpact: await routePriceImpact([hop]),
    })
  }

  for (const r of twoHopRoutes) {
    if (r) candidates.push(r)
  }

  if (candidates.length === 0) return null

  // Best = max amountOut (EXACT_INPUT) or min amountIn (EXACT_OUTPUT).
  let best = candidates[0]
  for (const c of candidates.slice(1)) {
    if (tradeType === 'EXACT_INPUT') {
      if (c.amountOut > best.amountOut) best = c
    } else {
      if (c.amountIn < best.amountIn) best = c
    }
  }
  return best
}

/**
 * Build a 2-hop route tokenIn → hub → tokenOut for the given trade type. Returns null
 * if either leg has no pool. For EXACT_INPUT we quote hop1 (tokenIn→hub) then hop2
 * (hub→tokenOut) with hop1's output. For EXACT_OUTPUT we quote hop2 (hub→tokenOut) for
 * the desired output, then hop1 (tokenIn→hub) for hop2's required input.
 */
async function buildTwoHop(
  tokenIn: Address,
  hub: Address,
  tokenOut: Address,
  amount: bigint,
  tradeType: TradeType,
): Promise<Route | null> {
  if (tradeType === 'EXACT_INPUT') {
    const leg1 = await bestSingleHop(tokenIn, hub, amount, 'EXACT_INPUT')
    if (!leg1 || leg1.amount === 0n) return null
    const leg2 = await bestSingleHop(hub, tokenOut, leg1.amount, 'EXACT_INPUT')
    if (!leg2 || leg2.amount === 0n) return null

    const hop1 = await hopFromSingle(tokenIn, hub, amount, leg1.amount, leg1)
    const hop2 = await hopFromSingle(hub, tokenOut, leg1.amount, leg2.amount, leg2)
    const hops = [hop1, hop2]
    return {
      hops,
      amountIn: amount,
      amountOut: leg2.amount,
      gasUseEstimate: leg1.gasEstimate + leg2.gasEstimate,
      priceImpact: await routePriceImpact(hops),
    }
  }

  // EXACT_OUTPUT — chain backward.
  const leg2 = await bestSingleHop(hub, tokenOut, amount, 'EXACT_OUTPUT')
  if (!leg2 || leg2.amount === 0n) return null
  const leg1 = await bestSingleHop(tokenIn, hub, leg2.amount, 'EXACT_OUTPUT')
  if (!leg1 || leg1.amount === 0n) return null

  // hop1: tokenIn→hub, in = leg1.amount (required), out = leg2.amount (hub needed).
  const hop1 = await hopFromSingle(tokenIn, hub, leg1.amount, leg2.amount, leg1)
  // hop2: hub→tokenOut, in = leg2.amount (hub), out = amount (desired).
  const hop2 = await hopFromSingle(hub, tokenOut, leg2.amount, amount, leg2)
  const hops = [hop1, hop2]
  return {
    hops,
    amountIn: leg1.amount,
    amountOut: amount,
    gasUseEstimate: leg1.gasEstimate + leg2.gasEstimate,
    priceImpact: await routePriceImpact(hops),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Allowance read (for /v1/check_approval)
// ─────────────────────────────────────────────────────────────────────────────

/** ERC20 allowance(owner, SwapRouter02). */
export async function getAllowance(token: Address, owner: Address): Promise<bigint> {
  return (await getClient().readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [owner, ADDRESSES.V3_SWAP_ROUTER_02],
  })) as bigint
}

export { MAX_UINT256 }
