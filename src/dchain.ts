// dchain.ts — the native V4 CLOB (D-Chain) read adapter.
//
// The native Central Limit Order Book lives in the D-Chain VM
// (github.com/luxfi/dex/pkg/dchain). It exposes a JSON READ surface
// (dex/pkg/dchain/read.go) under the chain's own HTTP route group:
//
//   GET <base>/dex/dex_get_markets
//   GET <base>/dex/dex_get_orders?market=<poolIdHex>
//   GET <base>/dex/dex_get_trades?limit=<n>&since=<height>
//   GET <base>/dex/dex_get_book?market=<poolIdHex>&depth=<n>
//
// where <base> is the chain route prefix `http://<luxd>:<port>/ext/bc/D` — the
// SAME base the maker (github.com/luxfi/maker) WRITES orders to over
// `POST <base>/dex/dex_place` (one chain surface: reads + writes). The read
// surface returns COMMITTED chain state, identical on every validator at a given
// accepted height, so it is the authoritative CLOB source.
//
// This module is the single translation seam between the exchange FE's dex-schema
// GraphQL queries ({markets},{orders},{fills}) and that JSON surface: graphql.ts
// routes a dex-root query here (see dexRouting.isDexQuery) instead of to a GraphQL
// subgraph. The response is shaped into the SAME `{data:{...}}` envelope the FE's
// dexSubgraph.ts already consumes, so the FE is unchanged whether the source is
// this native surface or a future settlement subgraph — the exchange-api is the
// stable abstraction.
//
// WHY NOT a GraphQL subgraph: the prior code derived DEX_GRAPH =
// `/v1/graph/cchain/dex/graphql` (the 0x9999 settlement subgraph). That route
// 404s on the deployed explorer AND depends on the 0x9999 settlement+indexer
// chain being fully wired. The D-Chain's own read surface is the source of truth
// and needs no separate indexer.

import fetch from 'node-fetch'
import { ACTIVE } from './networks'
import { leadRootField } from './dexRouting'
import type { RawMarket } from './dexMarkets'

// The D-Chain CLOB read base — the chain route prefix `.../ext/bc/D` (NO trailing
// `/dex`; that namespace + method are appended per call). Per-network default in
// networks.ts (the in-cluster luxd validator RPC); overridable by DEX_DCHAIN_URL
// for explicit in-cluster wiring (e.g. a load-balanced validator service). A
// trailing slash is trimmed so the joined path has exactly one separator.
export const DCHAIN_BASE = (process.env.DEX_DCHAIN_URL || ACTIVE.dexDchainUrl).replace(/\/+$/, '')

// FILL_WINDOW bounds the trade log scan for the "recent trades" panel. The read
// surface returns the GLOBAL fill log ASCENDING from `since` up to `limit`, with
// no newest-first cursor, so "recent N" is the TAIL of a bounded ascending window.
// For a young CLOB (total fills <= this) the tail is exactly the recent set; a
// high-volume market later needs a head-anchored `since` cursor (a read.go
// enhancement — that repo is the source of truth for the read API).
const FILL_WINDOW = 1000

// dexGet is the injectable JSON GET transport: prod hits the node, tests pass a
// fake. `path` is the route under the chain prefix, e.g. '/dex/dex_get_markets'.
export type DexGet = (path: string) => Promise<any>

const httpGet: DexGet = async (path) => {
  const res = await fetch(DCHAIN_BASE + path, {
    method: 'GET',
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) {
    throw new Error(`D-Chain CLOB ${path}: http ${res.status}`)
  }
  return res.json()
}

// ─── Pure mappers: D-Chain read.go JSON → FE dex-schema shapes ───────────────
//
// dex/pkg/dchain/read.go {marketJSON,orderJSON,tradeJSON} → exchange FE
// dexSubgraph.ts {DexMarket,DexOrder,DexFill}. read.go emits prices/sizes as JSON
// NUMBERS; the FE reads bestBid/bestAsk/price/size/remaining as STRINGS, so they
// are stringified here. These are pure (no I/O) and exported for unit tests.

// marketToRaw maps one dex_get_markets row to the RawMarket the dexMarkets gate
// reads AND the extra DexMarket fields the FE renders (openOrders, remaining).
// RawMarket carries an index signature, so the extra fields pass through
// filterRealMarkets (which preserves the row objects) to the FE.
// decodePoolSymbol recovers a human pair symbol from a venue market's `symbol`
// field. A maker-seeded market is keyed by SymbolPoolID(symbol) (dex dex.go): the
// human symbol ascii-packed left-aligned into 32 bytes with byte[31]=0xD0, and
// dex_get_markets returns that poolId hex AS the symbol. So hex-decode and take the
// leading printable-ASCII run (NUL / the 0xD0 marker / any non-printable byte ends
// it) → e.g. "LUX/LUSD". A real keccak poolId (a V4 PoolKey hash) decodes to
// non-printable bytes → '' → the row fails the symbol gate (correct: it carries no
// human pair on this surface). A value that is already a human symbol (contains
// '/', non-hex) is returned unchanged — forward-compatible with a venue that emits
// the human symbol directly.
export function decodePoolSymbol(s: string): string {
  if (!/^[0-9a-fA-F]{2,64}$/.test(s)) return s
  let out = ''
  for (let i = 0; i + 1 < s.length; i += 2) {
    const c = parseInt(s.slice(i, i + 2), 16)
    if (c < 32 || c > 126) break
    out += String.fromCharCode(c)
  }
  return out
}

export function marketToRaw(m: any): RawMarket {
  return {
    id: String(m?.poolId ?? ''),
    symbol: decodePoolSymbol(String(m?.symbol ?? '')),
    bestBid: String(m?.bestBid ?? 0),
    bestAsk: String(m?.bestAsk ?? 0),
    openOrders: Number(m?.orders ?? 0),
    remaining: String(m?.remaining ?? 0),
    // base/quote are present only on a custody (assetsBound) market; an empty ref
    // makes the real-asset gate reject the row (correct for an unbound placeholder).
    baseToken: m?.base ? String(m.base) : '',
    quoteToken: m?.quote ? String(m.quote) : '',
    assetsBound: m?.assetsBound === true,
  }
}

// orderToFe maps one dex_get_orders row to a FE DexOrder, tagging it with the
// market poolId hex so the FE's client-side `o.market === marketId` filter
// resolves (read.go's per-market response carries no market field — it is implied
// by the query param).
export function orderToFe(o: any, market: string): any {
  return {
    id: `${market}-${o?.orderId ?? 0}`,
    market,
    orderId: Number(o?.orderId ?? 0),
    price: String(o?.price ?? 0),
    size: String(o?.size ?? 0),
    remaining: String(o?.remaining ?? 0),
    side: o?.side === 'sell' ? 'sell' : 'buy',
    user: String(o?.user ?? ''),
  }
}

// tradeToFill maps one dex_get_trades row to a FE DexFill. The fill id is the
// `<height>-<seq>` coordinate pair that uniquely keys the trade:<height><seq> row.
export function tradeToFill(t: any): any {
  return {
    id: `${t?.height ?? 0}-${t?.seq ?? 0}`,
    height: Number(t?.height ?? 0),
    price: String(t?.price ?? 0),
    size: String(t?.size ?? 0),
    side: t?.takerSide === 'sell' ? 'sell' : 'buy',
    timestamp: Number(t?.timestamp ?? 0),
    makerOrderId: String(t?.makerOrderId ?? 0),
    takerOrderId: String(t?.takerOrderId ?? 0),
    tradeId: Number(t?.tradeId ?? 0),
  }
}

// firstArg extracts a `first: N` integer argument from a query (e.g.
// `fills(first: 50)`), defaulting when absent and bounding to `max`.
export function firstArg(query: string, def: number, max = FILL_WINDOW): number {
  const m = /\bfirst\s*:\s*(\d+)/.exec(query || '')
  if (!m) return def
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(n, max)
}

// ─── Fetchers (one D-Chain read each; injectable transport) ──────────────────

// fetchMarkets reads every CLOB market. Also the source acceptedMarketIds uses to
// resolve the real-market set for orders/fills gating (graphql.ts).
export async function fetchMarkets(get: DexGet = httpGet): Promise<RawMarket[]> {
  const res = await get('/dex/dex_get_markets')
  const markets = Array.isArray(res?.markets) ? res.markets : []
  return markets.map(marketToRaw)
}

// fetchOrders reads every market's resting book and concatenates, tagging each
// order with its market id. The FE issues a GLOBAL orders query and filters by
// market client-side, but the D-Chain serves orders PER market — so enumerate the
// (few) markets and fan out. Bounded: the canonical venue has 2 markets.
export async function fetchOrders(get: DexGet = httpGet): Promise<any[]> {
  const res = await get('/dex/dex_get_markets')
  const markets = Array.isArray(res?.markets) ? res.markets : []
  const out: any[] = []
  for (const m of markets) {
    const pid = String(m?.poolId ?? '')
    if (!pid) continue
    const ob = await get(`/dex/dex_get_orders?market=${pid}`)
    const orders = Array.isArray(ob?.orders) ? ob.orders : []
    for (const o of orders) out.push(orderToFe(o, pid))
  }
  return out
}

// fetchFills reads recent trades, newest-first. The read surface returns the
// global log ascending from since=0; take the tail of a bounded window and
// reverse so the FE's "Recent Trades" panel shows the latest fill first.
export async function fetchFills(first: number, get: DexGet = httpGet): Promise<any[]> {
  const res = await get(`/dex/dex_get_trades?limit=${FILL_WINDOW}`)
  const trades = Array.isArray(res?.trades) ? res.trades : []
  return trades.slice(-first).reverse().map(tradeToFill)
}

// queryDChain answers a native-CLOB GraphQL body from the D-Chain read surface,
// dispatched by the query's leading root field. Returns the `{data:{...}}`
// envelope the FE consumes (graphql.ts then applies the real-asset gate). Roots
// outside the FE's CLOB surface fail-empty rather than guess a shape.
export async function queryDChain(body: any, get: DexGet = httpGet): Promise<any> {
  const root = leadRootField(body?.query || '')
  switch (root) {
    case 'markets':
      return { data: { markets: await fetchMarkets(get) } }
    case 'orders':
      return { data: { orders: await fetchOrders(get) } }
    case 'fills':
      return { data: { fills: await fetchFills(firstArg(body?.query || '', 50), get) } }
    default:
      return { data: null }
  }
}
