// trading.ts — Express handlers for the Uniswap trading-api REST surface, shaped to the
// generated OpenAPI models at ~/work/lux/exchange/pkgs/api/src/clients/trading. Each
// handler is a thin adapter: it parses/validates the request at the boundary, delegates
// ALL pricing/routing to dexRouter (the pure on-chain core), and serializes the result
// into the exact response shape the FE's generated client expects.
//
// Routing is CLASSIC (Uniswap V3) only. There is no Permit2 on Lux — SwapRouter02 uses
// direct ERC20 approval — so permitData is always null and /v1/swap consumes a plain
// approval, never a signed permit. This mirrors Uniswap's documented behavior when an
// integrator opts out of Permit2.

import type { Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import {
  encodeFunctionData,
  getAddress,
  type Address,
} from 'viem'
import { cacheGet, cacheSet, TTL } from './cache'
import { getSubgraphPairs, getSubgraphV3Pools } from './subgraph'
import { LUX_TOKENS, LUX_NATIVE, type TokenMeta } from './lux-tokens'
import {
  ADDRESSES,
  CHAIN_ID,
  NATIVE_SENTINEL,
  SWAP_ROUTER_02_ABI,
  ERC20_APPROVE_ABI,
  MAX_UINT256,
  bestRoute,
  encodePath,
  getAllowance,
  getClient,
  isNative,
  resolveToken,
  toWrapped,
  type Route,
  type RouteHop,
  type TradeType,
} from './dexRouter'

// ─────────────────────────────────────────────────────────────────────────────
// Shared error helpers — boundary failures map to 4xx, unexpected ones to 500.
// ─────────────────────────────────────────────────────────────────────────────

function badRequest(res: Response, detail: string): void {
  res.status(400).json({ errorCode: 'VALIDATION_ERROR', detail })
}

function notFound(res: Response, detail: string): void {
  res.status(404).json({ errorCode: 'QUOTE_ERROR', detail })
}

function serverError(res: Response, where: string, e: unknown): void {
  console.error(`[trading] ${where}:`, e)
  res.status(500).json({ errorCode: 'INTERNAL_ERROR', detail: 'Internal server error' })
}

function isAddressLike(s: unknown): s is string {
  return typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s)
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/swappable_tokens
// ─────────────────────────────────────────────────────────────────────────────
//
// The curated lux-tokens list is the SOURCE OF TRUTH for the swappable set: a token is
// returned iff it is curated (native LUX first). The subgraph is consulted ONLY to ORDER
// the curated tokens by observed liquidity — it can neither ADD a member (so junk the
// indexer picked up, e.g. fake USDC/USDT, never surfaces) nor DROP one (so the subgraph's
// intermittent "premature close" thin-list — sometimes only native LUX — can't shrink the
// selector). decimals MUST be a number in this response.

interface SwappableToken {
  address: string
  chainId: number
  name: string
  symbol: string
  project: { logo: { url: string } | null; safetyLevel: 'VERIFIED'; isSpam: false }
  isSpam: false
  decimals: number
}

// Project a curated token into the response shape. Native LUX keeps the zero sentinel as
// its address; ERC20s are checksummed. Every curated token is VERIFIED by construction.
function curatedSwappableToken(t: TokenMeta): SwappableToken {
  return {
    address: isNative(t.address) ? NATIVE_SENTINEL : getAddress(t.address),
    chainId: CHAIN_ID,
    name: t.name,
    symbol: t.symbol,
    project: {
      logo: t.logoUrl ? { url: t.logoUrl } : null,
      safetyLevel: 'VERIFIED',
      isSpam: false,
    },
    isSpam: false,
    decimals: t.decimals,
  }
}

// Pure core: the curated set (source of truth) ordered by a subgraph liquidity ranking.
// Membership is ALWAYS the full curated list — native LUX first, then the rest sorted by
// `order` (unknown/unranked addresses sink to the end; curated order breaks ties). The
// subgraph can neither add nor remove a token here. No I/O — unit-testable in isolation.
export function buildSwappableTokens(order: string[]): SwappableToken[] {
  const rank = new Map<string, number>()
  order.forEach((addr, i) => {
    const key = addr.toLowerCase()
    if (!rank.has(key)) rank.set(key, i)
  })
  const rankOf = (addr: string): number => rank.get(addr.toLowerCase()) ?? Number.MAX_SAFE_INTEGER

  const rest = LUX_TOKENS.map((t, idx) => ({ t, idx }))
    .filter(({ t }) => !isNative(t.address))
    .sort((a, b) => rankOf(a.t.address) - rankOf(b.t.address) || a.idx - b.idx)
    .map(({ t }) => t)

  return [LUX_NATIVE, ...rest].map(curatedSwappableToken)
}

// Subgraph-derived ORDERING hint: lowercase token addresses in descending-liquidity order
// (pairs/pools are fetched ordered by reserveUSD/TVL desc, so first-seen = highest
// liquidity). Ordering ONLY — never decides membership. Returns [] on a subgraph miss (the
// caller then falls back to curated order). Never caches an empty result: a transient
// hiccup must not pin an empty ordering for the whole TTL.
async function subgraphTokenOrder(): Promise<string[]> {
  const cacheKey = 'trading:swappable:order'
  const cached = cacheGet(cacheKey) as string[] | null
  if (cached) return cached

  const [pairs, pools] = await Promise.all([
    getSubgraphPairs(200),
    getSubgraphV3Pools(200),
  ])

  const order: string[] = []
  const seen = new Set<string>()
  for (const p of [...pairs, ...pools]) {
    for (const t of [p.token0, p.token1]) {
      const id = typeof t?.id === 'string' ? t.id.toLowerCase() : undefined
      if (id && !seen.has(id)) {
        seen.add(id)
        order.push(id)
      }
    }
  }
  if (order.length > 0) cacheSet(cacheKey, order, TTL.SHORT)
  return order
}

export async function handleSwappableTokens(req: Request, res: Response): Promise<void> {
  try {
    const chainIdRaw = req.query.tokenInChainId
    if (chainIdRaw !== undefined && Number.isNaN(parseInt(String(chainIdRaw), 10))) {
      return badRequest(res, 'tokenInChainId must be a number')
    }
    // LX_API is single-chain (Lux C-Chain 96369). The interface prefetches this list with
    // whatever chain the swap form currently holds — possibly a transient generic default.
    // We ignore it and always serve the Lux set (every token carries chainId 96369) so the
    // selector never empties; cross-chain semantics don't apply to a one-chain venue.
    const tokens = buildSwappableTokens(await subgraphTokenOrder())
    res.json({ requestId: randomUUID(), tokens })
  } catch (e) {
    serverError(res, 'swappable_tokens', e)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/quote
// ─────────────────────────────────────────────────────────────────────────────

// Echo the ORIGINAL caller address in token fields (native sentinel stays native), even
// though routing/quoting math substitutes WLUX for the sentinel.
function echoToken(original: string): string {
  return isNative(original) ? NATIVE_SENTINEL : getAddress(original)
}

interface TokenInRoute {
  address: string
  chainId: number
  symbol: string
  decimals: string // NOTE: string here (V3PoolInRoute), unlike swappable_tokens (number)
}

interface V3PoolInRoute {
  type: 'v3-pool'
  address: string
  tokenIn: TokenInRoute
  tokenOut: TokenInRoute
  sqrtRatioX96: string
  liquidity: string
  tickCurrent: string
  fee: string
  amountIn: string
  amountOut: string
}

// Per-hop the token fields echo the ORIGINAL caller-supplied addresses on the boundary
// hops (so a native-sentinel input/output round-trips), while intermediate hub tokens
// are their real on-chain addresses.
async function tokenInRoute(
  onChain: Address,
  echoAs: string | null,
): Promise<TokenInRoute> {
  const t = await resolveToken(onChain)
  return {
    address: echoAs !== null ? echoToken(echoAs) : getAddress(onChain),
    chainId: CHAIN_ID,
    symbol: echoAs !== null && isNative(echoAs) ? LUX_NATIVE.symbol : t.symbol,
    decimals: String(t.decimals),
  }
}

async function hopToV3PoolInRoute(
  hop: RouteHop,
  echoIn: string | null,
  echoOut: string | null,
): Promise<V3PoolInRoute> {
  const [tin, tout] = await Promise.all([
    tokenInRoute(hop.tokenIn, echoIn),
    tokenInRoute(hop.tokenOut, echoOut),
  ])
  return {
    type: 'v3-pool',
    address: getAddress(hop.poolAddress),
    tokenIn: tin,
    tokenOut: tout,
    sqrtRatioX96: hop.sqrtRatioX96.toString(),
    liquidity: hop.liquidity.toString(),
    tickCurrent: hop.tickCurrent.toString(),
    fee: hop.fee.toString(),
    amountIn: hop.amountIn.toString(),
    amountOut: hop.amountOut.toString(),
  }
}

async function buildRouteString(hops: RouteHop[], inSym: string, outSym: string): Promise<string> {
  // SYM -> SYM -> SYM across the hop chain. First hop's in uses the caller's input symbol,
  // last hop's out uses the caller's output symbol, intermediates use on-chain symbols.
  const syms: string[] = [inSym]
  for (let i = 0; i < hops.length; i++) {
    const isLast = i === hops.length - 1
    const sym = isLast ? outSym : (await resolveToken(hops[i].tokenOut)).symbol
    syms.push(sym)
  }
  return syms.join(' -> ')
}

interface QuoteBody {
  type?: string
  amount?: string
  tokenInChainId?: number
  tokenOutChainId?: number
  tokenIn?: string
  tokenOut?: string
  swapper?: string
  slippageTolerance?: number
}

// A no-route result is NOT an error. The FE fires EXACT_OUTPUT quotes as USD-price probes
// for tokens that often have no fillable pool; a hard 404 there breaks the render and
// triggers react-query retry storms. Instead return a well-formed CLASSIC quote with an
// EMPTY route: the FE's computeRoutes treats `route: []` as "non-null quote, no routes"
// and degrades to a null trade (no price shown), which is the documented graceful path.
// Amounts echo as "0"; tokens round-trip the caller's input (native sentinel preserved).
// Genuine errors still surface as errors: bad input → 400, foreign chain → 404, RPC fault
// → 500 (all handled before/around this).
function noRouteQuote(
  res: Response,
  body: QuoteBody,
  type: TradeType,
  swapper: string,
  slippage: number,
): void {
  res.json({
    requestId: randomUUID(),
    routing: 'CLASSIC',
    permitData: null,
    quote: {
      chainId: CHAIN_ID,
      swapper,
      input: { token: echoToken(body.tokenIn!), amount: '0' },
      output: { token: echoToken(body.tokenOut!), amount: '0', recipient: swapper },
      tradeType: type,
      slippage,
      gasUseEstimate: '0',
      gasFee: '0',
      route: [],
      routeString: '',
      quoteId: randomUUID(),
      blockNumber: '0',
      priceImpact: 0,
    },
  })
}

export async function handleQuote(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as QuoteBody
    const type = body.type === 'EXACT_OUTPUT' ? 'EXACT_OUTPUT' : 'EXACT_INPUT'

    if (!isAddressLike(body.tokenIn)) return badRequest(res, 'tokenIn must be an address')
    if (!isAddressLike(body.tokenOut)) return badRequest(res, 'tokenOut must be an address')
    if (typeof body.amount !== 'string' || !/^\d+$/.test(body.amount)) {
      return badRequest(res, 'amount must be a decimal wei string')
    }
    const amount = BigInt(body.amount)
    if (amount <= 0n) return badRequest(res, 'amount must be > 0')

    if (body.tokenInChainId !== undefined && body.tokenInChainId !== CHAIN_ID) {
      return notFound(res, 'No quotes available')
    }
    if (body.tokenOutChainId !== undefined && body.tokenOutChainId !== CHAIN_ID) {
      return notFound(res, 'No quotes available')
    }

    const swapper = isAddressLike(body.swapper)
      ? getAddress(body.swapper)
      : NATIVE_SENTINEL
    const slippage = typeof body.slippageTolerance === 'number' ? body.slippageTolerance : 0.5

    const wrappedIn = toWrapped(body.tokenIn)
    const wrappedOut = toWrapped(body.tokenOut)
    if (wrappedIn.toLowerCase() === wrappedOut.toLowerCase()) {
      return badRequest(res, 'tokenIn and tokenOut resolve to the same token')
    }

    const route: Route | null = await bestRoute(wrappedIn, wrappedOut, amount, type)
    if (!route || route.hops.length === 0) {
      // No fillable pool for this pair/amount — clean no-route response, not a 404.
      return noRouteQuote(res, body, type, swapper, slippage)
    }

    const [inMeta, outMeta] = await Promise.all([
      resolveToken(wrappedIn),
      resolveToken(wrappedOut),
    ])
    const inSym = isNative(body.tokenIn) ? LUX_NATIVE.symbol : inMeta.symbol
    const outSym = isNative(body.tokenOut) ? LUX_NATIVE.symbol : outMeta.symbol

    // Echo native sentinel back on the boundary hops only.
    const lastIdx = route.hops.length - 1
    const v3Route: V3PoolInRoute[] = []
    for (let i = 0; i < route.hops.length; i++) {
      const echoIn = i === 0 ? body.tokenIn! : null
      const echoOut = i === lastIdx ? body.tokenOut! : null
      v3Route.push(await hopToV3PoolInRoute(route.hops[i], echoIn, echoOut))
    }

    const blockNumber = await getClient().getBlockNumber()
    const routeString = await buildRouteString(route.hops, inSym, outSym)

    const classicQuote = {
      chainId: CHAIN_ID,
      swapper,
      input: {
        token: echoToken(body.tokenIn!),
        amount: route.amountIn.toString(),
      },
      output: {
        token: echoToken(body.tokenOut!),
        amount: route.amountOut.toString(),
        recipient: swapper,
      },
      tradeType: type,
      slippage,
      gasUseEstimate: route.gasUseEstimate.toString(),
      gasFee: '0',
      route: [v3Route],
      routeString,
      quoteId: randomUUID(),
      blockNumber: blockNumber.toString(),
      priceImpact: route.priceImpact,
    }

    res.json({
      requestId: randomUUID(),
      routing: 'CLASSIC',
      permitData: null,
      quote: classicQuote,
    })
  } catch (e) {
    serverError(res, 'quote', e)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/swap
// ─────────────────────────────────────────────────────────────────────────────
//
// Build the SwapRouter02 transaction from the quote's route. Single-hop →
// exactInputSingle / exactOutputSingle; multi-hop → exactInput / exactOutput with an
// encoded path. amountOutMinimum / amountInMaximum derive from the quote amounts and
// slippage. recipient = quote.swapper; deadline = now + 1200s. Native input sets tx
// value = amountIn (SwapRouter02 wraps via msg.value).

const DEADLINE_SECONDS = 1200n

interface QuotePoolInRoute {
  tokenIn?: { address?: string; decimals?: string }
  tokenOut?: { address?: string; decimals?: string }
  fee?: string
  amountIn?: string
  amountOut?: string
}

interface SwapQuote {
  chainId?: number
  swapper?: string
  input?: { token?: string; amount?: string }
  output?: { token?: string; amount?: string; recipient?: string }
  tradeType?: string
  slippage?: number
  route?: QuotePoolInRoute[][]
  gasUseEstimate?: string
}

// Slippage is a percent (e.g. 0.5 == 0.5%). minOut = out * (1 - s/100). Computed in
// integer bps to avoid float drift: out * (10000 - bps) / 10000.
function applySlippageDown(amount: bigint, slippagePct: number): bigint {
  const bps = Math.round(slippagePct * 100) // 0.5% → 50 bps
  const factor = BigInt(Math.max(0, 10000 - bps))
  return (amount * factor) / 10000n
}

function applySlippageUp(amount: bigint, slippagePct: number): bigint {
  const bps = Math.round(slippagePct * 100)
  const factor = BigInt(10000 + bps)
  return (amount * factor) / 10000n
}

export async function handleSwap(req: Request, res: Response): Promise<void> {
  try {
    const quote = (req.body?.quote ?? {}) as SwapQuote
    const path0 = quote.route?.[0]
    if (!Array.isArray(path0) || path0.length === 0) {
      return badRequest(res, 'quote.route must contain at least one hop')
    }
    if (!isAddressLike(quote.swapper)) {
      return badRequest(res, 'quote.swapper must be an address')
    }
    const swapper = getAddress(quote.swapper)
    const type: TradeType = quote.tradeType === 'EXACT_OUTPUT' ? 'EXACT_OUTPUT' : 'EXACT_INPUT'
    const slippage = typeof quote.slippage === 'number' ? quote.slippage : 0.5
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_SECONDS

    // Native input → route via WLUX with msg.value = amountIn.
    const originalIn = quote.input?.token ?? path0[0]?.tokenIn?.address ?? ''
    const nativeIn = isNative(originalIn)

    // Pull amounts from the quote (already wei strings from /v1/quote).
    const totalIn = BigInt(quote.input?.amount ?? '0')
    const totalOut = BigInt(quote.output?.amount ?? '0')
    if (totalIn <= 0n || totalOut <= 0n) {
      return badRequest(res, 'quote input/output amounts must be > 0')
    }

    // On-chain token addresses for each hop (substitute native→WLUX).
    const hopTokens: Address[] = []
    const hopFees: number[] = []
    for (let i = 0; i < path0.length; i++) {
      const h = path0[i]
      const tin = h.tokenIn?.address
      const tout = h.tokenOut?.address
      const fee = h.fee
      if (!tin || !tout || !fee) {
        return badRequest(res, `quote.route hop ${i} is missing tokenIn/tokenOut/fee`)
      }
      if (i === 0) hopTokens.push(toWrapped(tin))
      hopTokens.push(toWrapped(tout))
      hopFees.push(parseInt(fee, 10))
    }

    let data: `0x${string}`
    const singleHop = path0.length === 1

    if (type === 'EXACT_INPUT') {
      const amountOutMinimum = applySlippageDown(totalOut, slippage)
      if (singleHop) {
        data = encodeFunctionData({
          abi: SWAP_ROUTER_02_ABI,
          functionName: 'exactInputSingle',
          args: [
            {
              tokenIn: hopTokens[0],
              tokenOut: hopTokens[1],
              fee: hopFees[0],
              recipient: swapper,
              amountIn: totalIn,
              amountOutMinimum,
              sqrtPriceLimitX96: 0n,
            },
          ],
        })
      } else {
        // exactInput path: tokenIn → ... → tokenOut (forward).
        const path = encodePath(hopTokens, hopFees)
        data = encodeFunctionData({
          abi: SWAP_ROUTER_02_ABI,
          functionName: 'exactInput',
          args: [
            {
              path,
              recipient: swapper,
              amountIn: totalIn,
              amountOutMinimum,
            },
          ],
        })
      }
    } else {
      // EXACT_OUTPUT
      const amountInMaximum = applySlippageUp(totalIn, slippage)
      if (singleHop) {
        data = encodeFunctionData({
          abi: SWAP_ROUTER_02_ABI,
          functionName: 'exactOutputSingle',
          args: [
            {
              tokenIn: hopTokens[0],
              tokenOut: hopTokens[1],
              fee: hopFees[0],
              recipient: swapper,
              amountOut: totalOut,
              amountInMaximum,
              sqrtPriceLimitX96: 0n,
            },
          ],
        })
      } else {
        // exactOutput path is encoded REVERSED (tokenOut → ... → tokenIn).
        const revTokens = [...hopTokens].reverse()
        const revFees = [...hopFees].reverse()
        const path = encodePath(revTokens, revFees)
        data = encodeFunctionData({
          abi: SWAP_ROUTER_02_ABI,
          functionName: 'exactOutput',
          args: [
            {
              path,
              recipient: swapper,
              amountOut: totalOut,
              amountInMaximum,
            },
          ],
        })
      }
    }

    const value = nativeIn ? totalIn.toString() : '0'

    res.json({
      requestId: randomUUID(),
      swap: {
        to: ADDRESSES.V3_SWAP_ROUTER_02,
        from: swapper,
        data,
        value,
        chainId: CHAIN_ID,
        gasLimit: quote.gasUseEstimate ?? undefined,
      },
    })
  } catch (e) {
    serverError(res, 'swap', e)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/check_approval
// ─────────────────────────────────────────────────────────────────────────────
//
// Read ERC20 allowance(walletAddress, SwapRouter02). Native sentinel → no approval.
// allowance >= amount → approval:null. Otherwise build approve(SwapRouter02, MaxUint256).
// Type says approval is non-optional, but the FE handles null when none is needed —
// returning null in that case matches Uniswap's real behavior.

interface ApprovalBody {
  walletAddress?: string
  token?: string
  amount?: string
  chainId?: number
}

export async function handleCheckApproval(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as ApprovalBody
    if (!isAddressLike(body.walletAddress)) return badRequest(res, 'walletAddress must be an address')
    if (typeof body.token !== 'string') return badRequest(res, 'token is required')
    if (typeof body.amount !== 'string' || !/^\d+$/.test(body.amount)) {
      return badRequest(res, 'amount must be a decimal wei string')
    }
    if (body.chainId !== undefined && body.chainId !== CHAIN_ID) {
      return badRequest(res, `unsupported chainId ${body.chainId}`)
    }

    const wallet = getAddress(body.walletAddress)
    const amount = BigInt(body.amount)

    // Native LUX needs no ERC20 approval.
    if (isNative(body.token)) {
      res.json({ requestId: randomUUID(), approval: null })
      return
    }

    const token = getAddress(body.token)
    const allowance = await getAllowance(token, wallet)
    if (allowance >= amount) {
      res.json({ requestId: randomUUID(), approval: null })
      return
    }

    const data = encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: 'approve',
      args: [ADDRESSES.V3_SWAP_ROUTER_02, MAX_UINT256],
    })

    res.json({
      requestId: randomUUID(),
      approval: {
        to: token,
        from: wallet,
        data,
        value: '0',
        chainId: CHAIN_ID,
      },
    })
  } catch (e) {
    serverError(res, 'check_approval', e)
  }
}
