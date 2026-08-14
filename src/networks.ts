// networks.ts — per-network config for the LX_API, selected at boot by the
// `NETWORK` env (mainnet | testnet | devnet | localnet), or by `CHAIN_ID`.
//
// ONE source of truth for "which chain + which DEX contracts + which graph".
// dexRouter, subgraph and the token primitives all read from ACTIVE — nothing
// else hardcodes a chain id, RPC, or contract address. Adding a network = one
// entry here; the same image serves any of them via env.
//
// Mainnet defaults are byte-identical to the previous hardcoded values, so the
// live deployment (which leaves NETWORK unset → mainnet) is unchanged. Any field
// is still overridable by env (LUX_RPC_URL, SUBGRAPH_URL, DEX_DCHAIN_URL) for
// in-cluster wiring.
//
// V3 contracts that are not yet deployed on a network are the zero address; the
// router treats a zero QuoterV2/Factory as "no V3 venue" and simply returns no
// quote (the token list still serves from the graph). Fill these in as the V3
// deploy lands per network.

import { getAddress, type Address } from 'viem'
import { LUX_TOKENS, ZOO_TOKENS, type TokenMeta } from './lux-tokens'

const ZERO = '0x0000000000000000000000000000000000000000' as Address
const MULTICALL3 = getAddress('0xd25F88CBdAe3c2CCA3Bb75FC4E723b44C0Ea362F')

export interface NetworkContracts {
  WLUX: Address
  LUSD: Address
  V3_QUOTER_V2: Address
  V3_SWAP_ROUTER_02: Address
  V3_FACTORY: Address
  MULTICALL3: Address
}

// The chain's own coin, at the zero-address sentinel. It is a property of the
// NETWORK, not a constant: the curated list in lux-tokens.ts opens with Lux's,
// so reading position 0 there labelled every deployment's native coin "LUX" —
// zoo.exchange's token list led with a row called LUX on chain ZOO.
export interface NativeCoin {
  symbol: string
  name: string
  logoUrl: string | null
}

export interface NetworkConfig {
  name: string
  chainId: number
  coin: NativeCoin
  // The curated registry for THIS chain — what the token surfaces fall back to
  // when the graph has indexed nothing yet. It used to read LUX_TOKENS
  // unconditionally, so a Zoo deployment with an empty graph listed Lux's WLUX,
  // LETH, LBTC and seventeen more as ZOO-chain tokens, every one priced at zero.
  tokens: TokenMeta[]
  rpcUrl: string
  subgraphUrl: string
  // dexDchainUrl is the native V4 CLOB (D-Chain) read base — the chain route
  // prefix `.../v1/bc/D` whose dex_get_* JSON endpoints the dchain.ts adapter
  // reads (markets/orders/fills). The in-cluster luxd validator RPC; override via
  // DEX_DCHAIN_URL. The D-Chain is NOT publicly exposed (api.lux.network/v1/bc/D
  // 404s), so this is an in-cluster address, reachable only from a cluster pod.
  dexDchainUrl: string
  contracts: NetworkContracts
}

export const NETWORKS: Record<string, NetworkConfig> = {
  mainnet: {
    name: 'mainnet',
    chainId: 96369,
    coin: { symbol: 'LUX', name: 'Lux', logoUrl: 'https://cdn.lux.network/exchange/icon-png/lux.png' },
    tokens: LUX_TOKENS,
    rpcUrl: 'https://api.lux.network/v1/bc/C/rpc',
    subgraphUrl: 'http://explorer.lux-mainnet.svc:8090/v1/graph/cchain/amm/graphql',
    dexDchainUrl: 'http://luxd-0.luxd-headless.lux-mainnet.svc:9630/v1/bc/D',
    contracts: {
      WLUX: getAddress('0x4888e4a2ee0f03051c72d2bd3acf755ed3498b3e'),
      LUSD: getAddress('0x848Cff46eb323f323b6Bbe1Df274E40793d7f2c2'),
      V3_QUOTER_V2: getAddress('0x15C729fdd833Ba675edd466Dfc63E1B737925A4c'),
      V3_SWAP_ROUTER_02: getAddress('0x939bC0Bca6F9B9c52E6e3AD8A3C590b5d9B9D10E'),
      V3_FACTORY: getAddress('0x80bBc7C4C7a59C899D1B37BC14539A22D5830a84'),
      MULTICALL3,
    },
  },
  testnet: {
    name: 'testnet',
    chainId: 96368,
    coin: { symbol: 'LUX', name: 'Lux', logoUrl: 'https://cdn.lux.network/exchange/icon-png/lux.png' },
    tokens: LUX_TOKENS,
    rpcUrl: 'https://api.lux-test.network/v1/bc/C/rpc',
    subgraphUrl: 'http://explorer.lux-testnet.svc:8090/v1/graph/cchain/amm/graphql',
    dexDchainUrl: 'http://luxd-0.luxd-headless.lux-testnet.svc:9640/v1/bc/D',
    contracts: {
      WLUX: getAddress('0xf3a126C12EE4f413573B8a32a36953Bd43719E30'),
      // DLUX is testnet's Lux Dollar — the stable hub (mainnet calls it LUSD).
      LUSD: getAddress('0x97c265001EB088E1dE2F77A13a62B708014c9e68'),
      // V3 is deployed on testnet at the canonical (deterministic) addresses,
      // same as mainnet. Verified on-chain via api.lux-test.network.
      V3_QUOTER_V2: getAddress('0x15C729fdd833Ba675edd466Dfc63E1B737925A4c'),
      V3_SWAP_ROUTER_02: getAddress('0x939bC0Bca6F9B9c52E6e3AD8A3C590b5d9B9D10E'),
      V3_FACTORY: getAddress('0x80bBc7C4C7a59C899D1B37BC14539A22D5830a84'),
      MULTICALL3,
    },
  },
  devnet: {
    name: 'devnet',
    chainId: 96367,
    coin: { symbol: 'LUX', name: 'Lux', logoUrl: 'https://cdn.lux.network/exchange/icon-png/lux.png' },
    tokens: LUX_TOKENS,
    rpcUrl: 'https://api.lux-dev.network/v1/bc/C/rpc',
    subgraphUrl: 'http://explorer.lux-devnet.svc:8090/v1/graph/cchain/amm/graphql',
    dexDchainUrl: 'http://luxd-0.luxd-headless.lux-devnet.svc:9650/v1/bc/D',
    contracts: {
      WLUX: getAddress('0xc65ea8882020Af7CDa7854d590C6Fcd34BF364ec'),
      LUSD: ZERO,
      V3_QUOTER_V2: ZERO, // V3 deploy pending
      V3_SWAP_ROUTER_02: ZERO,
      V3_FACTORY: ZERO,
      MULTICALL3,
    },
  },
  // Zoo's own chain. Not a Lux network — a sovereign L1 with its own primary
  // network — but it is a network this image serves, which is what this table
  // is for. zoo.exchange ran against NETWORK=mainnet before this entry existed,
  // which meant chainId 96369 on Zoo's RPC: the markets gate's chainId assertion
  // fired on every poll, and the router quoted against Lux's V3 addresses.
  //
  // Contracts are zero because Zoo's AMM is mid-deploy. The router reads a zero
  // QuoterV2/Factory as "no V3 venue" and returns no quote, which is the honest
  // answer until they land — fill them in then, the way testnet's were.
  zoo: {
    name: 'zoo',
    chainId: 200200,
    coin: { symbol: 'ZOO', name: 'Zoo', logoUrl: 'https://cdn.lux.network/bridge/currencies/zoo.svg' },
    tokens: ZOO_TOKENS,
    // Zoo's node runs in zoo-k8s, so there is no in-cluster name for it from
    // lux-k8s and the raw :9630 LB is firewalled to non-DigitalOcean sources.
    // Answers eth_chainId 0x30e08.
    rpcUrl: 'https://api.zoo.network/v1/bc/C/rpc',
    subgraphUrl: 'http://explorer.lux-mainnet.svc:8090/v1/graph/zoo/amm/graphql',
    // Zoo has no D-Chain; this 404s and the CLOB surface renders "No active
    // markets". Named anyway, because the alternative to a wrong answer here is
    // Lux's order book showing up on a Zoo site.
    dexDchainUrl: 'https://api.zoo.network/v1/bc/D',
    contracts: {
      // Zoo's wrapped native and its dollar. These were the zero sentinel, so
      // the coin's own page could not find the row its supply is published on
      // and printed a dash where a valuation belongs.
      WLUX: '0x4888E4a2Ee0F03051c72D2BD3ACf755eD3498B3E',
      LUSD: '0x848Cff46eb323f323b6Bbe1Df274E40793d7f2c2',
      V3_QUOTER_V2: ZERO,
      V3_SWAP_ROUTER_02: ZERO,
      V3_FACTORY: ZERO,
      MULTICALL3,
    },
  },
  localnet: {
    name: 'localnet',
    chainId: 31337,
    coin: { symbol: 'LUX', name: 'Lux', logoUrl: 'https://cdn.lux.network/exchange/icon-png/lux.png' },
    tokens: LUX_TOKENS,
    rpcUrl: 'http://127.0.0.1:9650/v1/bc/C/rpc',
    subgraphUrl: 'http://127.0.0.1:8090/v1/graph/cchain/amm/graphql',
    dexDchainUrl: 'http://127.0.0.1:9650/v1/bc/D',
    contracts: {
      WLUX: ZERO, // deterministic local deploy fills these in
      LUSD: ZERO,
      V3_QUOTER_V2: ZERO,
      V3_SWAP_ROUTER_02: ZERO,
      V3_FACTORY: ZERO,
      MULTICALL3,
    },
  },
}

function resolveActive(): NetworkConfig {
  const sel = (process.env.NETWORK || '').toLowerCase().trim()
  if (sel && NETWORKS[sel]) return NETWORKS[sel]
  const cid = Number(process.env.CHAIN_ID)
  if (Number.isFinite(cid) && cid > 0) {
    const match = Object.values(NETWORKS).find((n) => n.chainId === cid)
    if (match) return match
  }
  return NETWORKS.mainnet
}

// The active network for this process. Resolved once at boot.
export const ACTIVE: NetworkConfig = resolveActive()

// A token's metadata, from THIS network's registry.
//
// One process serves one network, and that is what makes the answer unambiguous.
// Lux and Zoo were deployed from the same account in the same order, so they
// share addresses AND bytecode: 0x848cff46 is LUSD on Lux and ZUSD on Zoo,
// 0x4888e4a2 is WLUX on one and WZOO on the other. Merged into one map by
// address, whichever list was added last answered for both chains — a quote on
// Lux came back routed "CYRUS -> ZUSD -> WZOO".
const tokensByAddress = new Map<string, TokenMeta>(
  ACTIVE.tokens.map((t) => [t.address.toLowerCase(), t]),
)

export function getTokenMeta(address: string): TokenMeta | undefined {
  return tokensByAddress.get(address.toLowerCase())
}
