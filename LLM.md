# Lux Exchange API

Express/TypeScript proxy that serves the Uniswap-shaped surfaces the Lux exchange FE
expects, backed by the native Lux graph (discovery/reads) and on-chain QuoterV2/SwapRouter02
(live quotes/swaps) on the Lux C-Chain (chainId **96369**).

## Tech Stack
- TypeScript (strict, CommonJS target), Express 4, viem 2.53.1, node-fetch 2.
- Tests: `node:test` + `node:assert/strict`, run via `tsx --test`.

## Build & Run
```bash
npm install && npm run build      # tsc, zero-error gate; excludes *.test.ts + test-graph-env.ts
npm test                          # full suite (incl. LIVE mainnet asserts, guarded/skippable)
PORT=4000 SUBGRAPH_URL=https://explore.lux.network/v1/graph/cchain/amm/graphql node dist/index.js
```

## Endpoints (src/index.ts)
| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| ANY (CORS) / GET | `/health` | inline | `{status:"ok"}` |
| POST | `/v1/graphql` | graphql.ts | split by lead root: AMM (pools/swaps/tokens) → explorer amm graph; CLOB (markets/orders/fills) → D-Chain read surface (dchain.ts) |
| GET | `/v1/swappable_tokens` | trading.ts | native LUX first + token0/token1 union across pairs/pools; `decimals` is a **number** |
| POST | `/v1/quote` | trading.ts | `routing:"CLASSIC"`, `permitData:null`, `quote.route:[[V3PoolInRoute…]]`; `TokenInRoute.decimals` is a **string**; 404 `QUOTE_ERROR` on no pool |
| POST | `/v1/swap` | trading.ts | SwapRouter02 calldata: single→`exactInputSingle`/`exactOutputSingle`, multi→`exactInput`/`exactOutput` (path reversed for exactOutput); native in → `value=amountIn` |
| POST | `/v1/check_approval` | trading.ts | ERC20 `allowance(wallet, SwapRouter02)`; native or allowance≥amount → `approval:null`; else `approve(SwapRouter02, MaxUint256)` |
| GET+POST | `/uniswap.explore.v1.ExploreStatsService/TokenRankings` | explore.ts | Connect-RPC unary (JSON). The token selector's default list. |

Responses conform to the generated OpenAPI models in
`~/work/lux/exchange/pkgs/api/src/clients/trading/__generated__/models` (trading-api) and
the protobufs in `@luxamm/client-explore/dist/lx/explore/v1/service_pb` (TokenRankings).

## Native DEX (CLOB) data source — the D-Chain read surface (dchain.ts + dexRouting.ts)

The FE's CLOB surface (markets / order book / recent trades) issues three GraphQL
queries to `/v1/graphql` — `{ markets {…} }`, `{ orders(first:500){…} }`,
`{ fills(first:N){…} }` (see exchange `apps/web/src/state/explore/dexSubgraph.ts`).
The exchange-api is the STABLE ABSTRACTION: the FE never knows the source.

- **Routing** (`dexRouting.ts`): `isDexQuery(body)` is true iff the query's LEADING
  top-level field is a CLOB root (`markets/orders/fills/orderbook/…`). `graphql.ts`
  routes those to the D-Chain adapter; everything else to the AMM graph
  (`AMM_GRAPH`/`SUBGRAPH_URL`). Lead-root only — a sibling/nested/aliased/in-string
  `markets` never mis-routes (`leadRootField`).
- **Source** (`dchain.ts`): the native V4 CLOB lives in the **D-Chain VM**
  (`luxfi/dex/pkg/dchain`), which exposes a JSON READ surface
  (`dex/pkg/dchain/read.go`) under the chain route group — the SAME base the maker
  WRITES orders to (`POST .../dex/dex_place`). It returns committed chain state,
  identical on every validator at a height — the authoritative source, no indexer.

  | FE GraphQL query | D-Chain read (GET) | mapper (`dchain.ts`) |
  |---|---|---|
  | `{ markets {…} }` | `<base>/dex/dex_get_markets` | `marketToRaw` (poolId→id, base/quote→baseToken/quoteToken, numbers→strings) |
  | `{ orders(first){…} }` | per market: `<base>/dex/dex_get_orders?market=<poolIdHex>` | `orderToFe` (tags each order with its market id; FE filters client-side) |
  | `{ fills(first:N){…} }` | `<base>/dex/dex_get_trades?limit=1000` | `tradeToFill` (takerSide→side; tail+reverse → newest-first) |

  `<base>` = `DEX_DCHAIN_URL` or `ACTIVE.dexDchainUrl` (networks.ts), the chain
  route prefix `http://<luxd>:<port>/ext/bc/D`. Per-network in-cluster luxd RPC:
  mainnet `:9630`, testnet `:9640`, devnet/localnet `:9650`. The real-asset gate
  (`dexMarkets.ts` `filterRealMarkets`) runs on the mapped rows before serving, so
  synthetic-seed / phantom-asset markets are stripped at the source.

- **Why not the `cchain/dex` subgraph**: the old `DEX_GRAPH` derived
  `…/v1/graph/cchain/dex/graphql` (the 0x9999 settlement subgraph). That route
  **404s** on the deployed explorer (`amm` returns 200; `dex` 404 — verified live),
  AND it depends on the 0x9999 settlement+indexer chain being wired. The D-Chain's
  own read surface is the source of truth and needs no separate indexer. When a
  settlement subgraph later lands, the source swaps INSIDE this adapter — the FE and
  these queries are unchanged.

- **Verification**: live-verifiable only from a cluster pod — the D-Chain is NOT
  publicly exposed (`api.lux.network/ext/bc/D` 404s). From a pod:
  `curl http://<luxd>:<port>/ext/bc/D/dex/dex_get_markets` should return
  `{height,…,markets:[…]}`, and the maker (github.com/luxfi/maker) must be seeding
  for the list to be non-empty. The mapping itself is unit-tested offline
  (`dchain.test.ts`, injected transport).

## explore.ts — Connect-RPC data-api (3rd backend the FE needs)
The FE token selector loads its default list from `ExploreStatsService.TokenRankings` via the
generated `@luxamm/client-explore` client over a Connect transport (`useHttpGet:true`,
base = `lxUrls.apiBaseUrlV2` ← `API_BASE_URL_V2_OVERRIDE`). This was the missing third backend
(GraphQL + trading-api already served); without it the selector showed "Couldn't load tokens".

- **Path** = `package.Service/Method` = `/uniswap.explore.v1.ExploreStatsService/TokenRankings`.
- **Both Connect-unary forms** served: `GET ?connect=v1&encoding=json&message=<url-enc req JSON>`
  AND `POST` (`Content-Type: application/json`, body = req JSON). Non-`json` encoding → 404
  `unimplemented`; bad JSON → 400 `invalid_argument` (Connect error envelope `{code,message}`).
- **Request** `TokenRankingsRequest {chainId,...}`: accepts `"96369"`, `"ALL_NETWORKS"`, or unset
  (FE prefetches before brand config resolves the chain). Any **other** concrete chain → empty
  ranking + HTTP 200 (single-chain venue; never error → no selector toast).
- **Response** `TokenRankingsResponse { tokenRankings: map<CustomRankingType, {tokens:[]}> }`.
  Keys = `TRENDING` / `PRICE_PERCENT_CHANGE_1_DAY_ASC` / `PRICE_PERCENT_CHANGE_1_DAY_DESC`
  (`pkgs/api/src/clients/content/types.ts`); the selector reads `tokenRankings["TRENDING"].tokens`.
- **CRITICAL — mapper drops bad stats**: `tokenRankingsStatToCurrencyInfo`
  (`pkgs/lx/src/data/rest/tokenRankings.ts`) discards any `TokenRankingsStat` missing
  `chain`/`symbol`/`name`/`decimals`, and resolves chain via `fromGraphQLChain`. So `chain` MUST
  be the GraphQL enum **string `"LUX"`** (→ `UniverseChainId.Lux` = 96369), NEVER the numeric id;
  symbol/name/decimals are always emitted. `Amount` = `{currency:"USD", value:<double>}`, emitted
  only when > 0 (proto3 `optional` omitted otherwise).
- **No price-history source yet** → 1-day %-change ranks equal the volume-ranked TRENDING set
  (same tokens under those keys). When a series lands, sort the ASC/DESC lists by
  `pricePercentChange1Day` in `buildRankingsResponse`.

## getRankedTokens (subgraph.ts) — single source of truth for "tradeable tokens + stats"
Both the GraphQL `topTokens` shaper and the Connect `TokenRankings` shaper now project FROM this
one primitive (decomplected; the old `handleTopTokens` discovery/merge/derivation body was
deleted). It returns `RankedToken[]` (address, symbol, name, decimals, priceUSD, volumeUSD,
tvlUSD, logoUrl): native LUX first, then volume desc. Carries the swappable filter (token must be
token0/token1 of a real pool — excludes LP/position/vault tokens) and the USD derivation
(stablecoin pin to $1, decimal-overflow caps at 1e12). Falls back to the curated `LUX_TOKENS`
list (unpriced) when the native graph has not indexed tokens. `graphql.ts.buildTokenResponse`
and `tokenResponseFromUsd` are the shared GraphQL-Token shapers (one output literal).

## dexRouter.ts — pure routing/quoting core (no Express; reusable by luxfi/broker)
- `getClient()` — viem public client bound to `LUX_RPC_URL` (default `https://api.lux.network/ext/bc/C/rpc`), chain 96369.
- `quoteExactInputSingle / quoteExactOutputSingle(tokenIn,tokenOut,amount,fee)` → QuoterV2 via `readContract` (nonpayable funcs run as `eth_call`); `null` on revert.
- `bestSingleHop(...)` → enumerate fee tiers `[500,3000,10000]`, tolerate per-tier reverts, pick max-out / min-in.
- `bestRoute(tokenIn,tokenOut,amount,tradeType)` → best single-hop vs 2-hop through hubs `[WLUX, LUSD]`; structured `{hops[], amountIn, amountOut, gasUseEstimate, priceImpact}`; never throws on partial pool state, `null` only when no route produces output.
- `encodePath(tokens,fees)` → V3 `tokenIn|fee(3 bytes)|token|…|tokenOut`.
- `getPoolState(a,b,fee)` → factory `getPool` + pool `slot0`/`liquidity` for V3PoolInRoute fields.
- Native sentinel `0x00…00` is substituted to WLUX for math, echoed back in token fields.
- Token meta: `resolveToken` prefers curated `lux-tokens.ts`, falls back to on-chain ERC20 `decimals()/symbol()`.

### Hardcoded constants (the ONLY hardcoded values; everything else is on-chain)
- Addresses (`ADDRESSES`): WLUX `0x4888…8b3e`, QuoterV2 `0x15C7…5A4c`, SwapRouter02 `0x939b…D10E`, V3Factory `0x80bB…0a84`, LUSD `0x848C…f2c2`.
- Fee tiers `[500,3000,10000]`; routing hubs `[WLUX, LUSD]`.

## Gotchas (live-verified, do not regress)
- **Multicall3 `aggregate3` REVERTS on this chain** (top-level CALL fails even with per-call `allowFailure`), though the contract is deployed. We do **not** wire `contracts.multicall3` and never call viem's `multicall`; batched reads go through the http transport's JSON-RPC batching (`http(url,{batch:true})`) as parallel `readContract`s.
- **The AMM graph silently drops unknown fields and returns empty reserves/prices.** It is **discovery-only** (which token addresses are tradeable). Never compute price/amountOut from graph data — quotes come from QuoterV2.
- **CYRUS (`0x0A78…95c5`) only pairs with LUSD**; CYRUS↔WLUX is a forced 2-hop via LUSD. CYRUS/LUSD and WLUX/LUSD exist **only at fee 3000** (500/10000 revert).
- **Native sentinel collides in `getTokenMeta`** (both LUX and ZOO use `0x00…00`); use `LUX_NATIVE` from `lux-tokens.ts` for native LUX, never `getTokenMeta(sentinel)`.
- **`priceImpact`** is computed from the **marginal quoter rate** (a tiny reference quote per leg) vs the actual average rate, composed across hops, clamped 0..100 — NOT from `slot0` sqrtPriceX96 (that model is provably inconsistent with the quoter on these pools: pool spot ≈ 5.8e7 LUSD/CYRUS vs quoter 0.51, because active liquidity sits outside the current tick). The CYRUS/LUSD pool currently caps output at ~0.51 LUSD for any input → high impact on non-dust trades is **real**.
- **No Permit2 on Lux.** SwapRouter02 uses direct ERC20 approval, so `permitData` is always `null` and `/v1/swap` consumes a plain approval.

## Test infra
- `src/test-graph-env.ts` (excluded from build) pins `SUBGRAPH_URL` to the public AMM endpoint before `./subgraph` captures it; imported first in `trading.test.ts`.
- LIVE asserts probe RPC/graph reachability and skip cleanly (warn + return) when unreachable, so CI never flakes; they pass when the mainnet RPC + public graph are up.
