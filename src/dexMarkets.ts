// Native DEX (CLOB) markets — real-asset validation gate.
//
// The `dex` subgraph (luxfi/indexer + luxfi/graph) is fed by the D-Chain matcher.
// While the chain is being stood up it can also carry SYNTHETIC SEED rows (test
// pairs, phantom asset ids, crossed books) that are NOT backed by accepted chain
// state. The public exchange-api must NEVER surface those: the markets display is
// allowed to show ONLY real, accepted-chain-state markets backed by real assets.
//
// This module is that gate. It REJECTS (strips from the response — not merely
// hides) any market that is not provably real. A market survives iff:
//
//   1. assetsBound — the subgraph bound real tokens to the market (necessary).
//   2. symbol is a clean BASE/QUOTE pair (no hex-blob symbols, no mock/test/
//      synthetic tokens, no Liquidity* white-label leakage).
//   3. NOT crossed — a real matched order book can never have bestBid >= bestAsk
//      (those orders would already have matched). A crossed book is a tell-tale
//      of injected synthetic depth.
//   4. Every token reference is a REAL asset:
//        • EVM: a 20-byte address whose contract has code AND a working decimals()
//          on THIS network's C-Chain (verified live, cached). A phantom address
//          such as 0x…004c555344000001 (the ascii of "LUSD" embedded in a 32-byte
//          id) has no code and is rejected.
//        • Native: the all-zero sentinel (native LUX/coin) is real by definition.
//
// The on-chain verification is the load-bearing check: on a network whose real
// asset contracts are not yet deployed (e.g. a fresh devnet), every EVM market
// fails verification and the surface is correctly EMPTY ("No active markets") —
// no per-network special-casing, the policy falls straight out of chain state.
//
// Forward-compat: this validates the SUBGRAPH RESPONSE SHAPE (markets/orders/
// fills), not the indexer source, so it is unchanged when the 0x9999 settlement
// model replaces the source feeding the subgraph.

import { createPublicClient, http, isAddress, getAddress, type Address, type PublicClient } from 'viem'
import { cacheGet, cacheSet, TTL } from './cache'
import { ACTIVE } from './networks'

// ─── Network C-Chain RPC (for live asset verification) ──────────────────────
//
// The exchange-api is deployed PER NETWORK; LUX_RPC_URL is that deployment's own
// C-Chain RPC. The default is ACTIVE.rpcUrl — the one source of truth in
// networks.ts for the NETWORK this process serves — NOT a hardcoded mainnet URL,
// so a devnet/testnet deploy that forgets LUX_RPC_URL verifies against its OWN
// chain, not mainnet. An explicit LUX_RPC_URL still wins (in-cluster wiring), and
// assertRpcChainId() below proves at first use that it actually points at NETWORK.
const RPC_URL = process.env.LUX_RPC_URL || ACTIVE.rpcUrl

let _client: PublicClient | null = null
function client(): PublicClient {
  if (!_client) {
    // No pinned chain object: verification needs only eth_getCode / eth_call and
    // must work on devnet(96370)/testnet(96368)/mainnet(96369) alike. Batching
    // folds the per-token getCode+decimals into the http transport's JSON-RPC
    // batch (this chain's multicall3 reverts — see dexRouter notes — so we never
    // use viem multicall).
    _client = createPublicClient({ transport: http(RPC_URL, { batch: true }) })
  }
  return _client
}

const DECIMALS_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const

// ─── chainID guard (red M1) ─────────────────────────────────────────────────
//
// The gate verifies every token against RPC_URL, so the whole policy is only
// correct if RPC_URL points at NETWORK's own chain. If LUX_RPC_URL is overridden
// to the wrong network (or the mainnet default leaks into a devnet deploy), every
// real token "has no code" on that chain and is stripped — the surface goes
// silently EMPTY and looks like "no markets yet" rather than a misconfig. Prove
// eth_chainId === ACTIVE.chainId on first use and fail LOUD on mismatch (mirrors
// the SUBGRAPH_URL fail-fast in graphql.ts). A transient RPC error is NOT memoized,
// so it simply retries on the next poll; only a real mismatch throws.
// checkChainId is the pure assertion (no network, no memo) — testable in isolation.
export function checkChainId(actual: number): void {
  if (actual !== ACTIVE.chainId) {
    throw new Error(
      `exchange-api RPC chainId mismatch: LUX_RPC_URL (${RPC_URL}) reports chainId ${actual}, ` +
        `but NETWORK=${ACTIVE.name} expects ${ACTIVE.chainId}. The markets gate would verify token ` +
        `contracts against the WRONG chain and strip every real market ("No active markets"). Point ` +
        `LUX_RPC_URL at ${ACTIVE.name}'s own C-Chain RPC, or unset it to use the ${ACTIVE.name} default.`,
    )
  }
}

let _chainIdVerified = false
export async function assertRpcChainId(): Promise<void> {
  if (_chainIdVerified) return
  checkChainId(await client().getChainId())
  _chainIdVerified = true
}

// ─── Subgraph row shapes (only the fields the gate reads) ───────────────────

export interface RawMarket {
  id: string
  symbol: string
  bestBid?: string
  bestAsk?: string
  baseToken?: string
  quoteToken?: string
  assetsBound?: boolean
  [k: string]: unknown
}

// ─── Symbol policy ──────────────────────────────────────────────────────────

// A clean pair symbol: BASE/QUOTE, each 2–12 chars of [A-Z0-9], exactly one slash.
// Rejects hex-blob ids used as symbols by uninitialized/placeholder markets.
const PAIR_SYMBOL = /^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/

// Token names that betray non-real (synthetic/mock/test) or wrong-brand listings.
// Liquidity* is a white-label brand that must NEVER appear on a Lux public surface.
const FORBIDDEN_TOKEN = /^(MOCK|TEST|FAKE|SYNTH|SYNTHETIC|DEMO|SAMPLE|LIQUIDITY|LIQUID)/

function symbolIsClean(symbol: string): boolean {
  if (!PAIR_SYMBOL.test(symbol)) {
    return false
  }
  return symbol.split('/').every((side) => !FORBIDDEN_TOKEN.test(side))
}

// ─── Asset-reference parsing ────────────────────────────────────────────────

const NATIVE_32 = '0'.repeat(64)

/**
 * Resolve a subgraph token reference to what it claims to be:
 *   - 'native'                — the all-zero sentinel (native LUX/coin), real.
 *   - { address }             — a 20-byte EVM address candidate (must be verified
 *                               on-chain before it counts as real).
 *   - null                    — unparseable / not a real-asset shape (UTXO assetIDs
 *                               that are not registered, garbage, etc.) → reject.
 *
 * A 32-byte id counts as an EVM-address candidate ONLY if its high 12 bytes are
 * zero (a left-padded 20-byte address). Note this is necessary, not sufficient:
 * the synthetic ascii-of-symbol ids ALSO left-pad to a tiny address, so the
 * on-chain code/decimals check is what actually rejects them.
 */
export function parseTokenRef(ref: string | undefined): 'native' | { address: Address } | null {
  if (!ref) {
    return null
  }
  const hex = ref.startsWith('0x') ? ref.slice(2) : ref
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    return null
  }
  if (hex.length === 64) {
    if (hex.toLowerCase() === NATIVE_32) {
      return 'native'
    }
    // left-padded 20-byte address?  high 12 bytes (24 hex) must be zero.
    if (hex.slice(0, 24) !== '0'.repeat(24)) {
      return null
    }
    const addr = '0x' + hex.slice(24)
    return isAddress(addr) ? { address: getAddress(addr) } : null
  }
  if (hex.length === 40) {
    const addr = '0x' + hex
    if (!isAddress(addr)) {
      return null
    }
    return addr.toLowerCase() === '0x' + '0'.repeat(40)
      ? 'native'
      : { address: getAddress(addr) }
  }
  return null
}

// ─── On-chain real-asset verification ───────────────────────────────────────

/**
 * Is this address a real ERC-20 on the network's C-Chain — contract code present
 * AND decimals() returns a uint8? Cached (TTL.LONG): asset existence is stable.
 * Verifier is injectable so the validator is testable without a live RPC.
 */
export type AssetVerifier = (address: Address) => Promise<boolean>

export async function verifyEvmAsset(address: Address): Promise<boolean> {
  const key = `dexasset:${RPC_URL}:${address.toLowerCase()}`
  const cached = cacheGet(key)
  if (cached !== null) {
    return cached as boolean
  }
  let real = false
  try {
    const code = await client().getCode({ address })
    if (code && code !== '0x') {
      // decimals() must return a value (a non-token contract or phantom address
      // either has no code, above, or reverts here).
      const d = (await client().readContract({ address, abi: DECIMALS_ABI, functionName: 'decimals' })) as number
      real = Number.isInteger(d) && d >= 0 && d <= 36
    }
  } catch {
    real = false
  }
  cacheSet(key, real, TTL.LONG)
  return real
}

// ─── The gate ───────────────────────────────────────────────────────────────

/**
 * Reject every market that is not provably real (see module header). Returns the
 * surviving markets AND the set of accepted market ids (callers strip orders/fills
 * that reference a rejected market).
 *
 * Structural checks (synchronous, no network) run first and eliminate crossed and
 * mis-shaped rows for free; only structurally-plausible EVM tokens are verified
 * on-chain, and the per-address result is cached so repeated polls are cheap.
 */
export async function filterRealMarkets(
  markets: RawMarket[],
  verify: AssetVerifier = verifyEvmAsset,
): Promise<{ markets: RawMarket[]; acceptedIds: Set<string> }> {
  // Prove RPC_URL points at NETWORK before verifying anything against it (red M1).
  // Only when using the real on-chain verifier — an injected mock (tests) needs no
  // live RPC and bypasses the guard.
  if (verify === verifyEvmAsset) {
    await assertRpcChainId()
  }
  const survivors: RawMarket[] = []
  for (const m of markets) {
    if (!isStructurallyReal(m)) {
      continue
    }
    const base = parseTokenRef(m.baseToken)
    const quote = parseTokenRef(m.quoteToken)
    if (base === null || quote === null) {
      continue
    }
    // Verify each EVM token reference on-chain; native needs no verification.
    const evm: Address[] = []
    if (base !== 'native') {
      evm.push(base.address)
    }
    if (quote !== 'native') {
      evm.push(quote.address)
    }
    const checks = await Promise.all(evm.map((a) => verify(a)))
    if (checks.every(Boolean)) {
      survivors.push(m)
    }
  }
  return { markets: survivors, acceptedIds: new Set(survivors.map((m) => m.id)) }
}

/** Synchronous, network-free real-market checks: bound assets, clean symbol, not crossed. */
export function isStructurallyReal(m: RawMarket): boolean {
  if (m.assetsBound !== true) {
    return false
  }
  if (typeof m.symbol !== 'string' || !symbolIsClean(m.symbol)) {
    return false
  }
  return !isCrossed(m.bestBid, m.bestAsk)
}

/** A book is crossed when both sides are priced and bestBid >= bestAsk. */
export function isCrossed(bestBid: string | undefined, bestAsk: string | undefined): boolean {
  const bid = parseFloat(bestBid ?? '')
  const ask = parseFloat(bestAsk ?? '')
  if (!(bid > 0) || !(ask > 0)) {
    return false // one side empty → not crossed (just thin/one-sided)
  }
  return bid >= ask
}
