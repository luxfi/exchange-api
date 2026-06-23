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
// is still overridable by env (LUX_RPC_URL, SUBGRAPH_URL, DEX_SUBGRAPH_URL) for
// in-cluster wiring.
//
// V3 contracts that are not yet deployed on a network are the zero address; the
// router treats a zero QuoterV2/Factory as "no V3 venue" and simply returns no
// quote (the token list still serves from the graph). Fill these in as the V3
// deploy lands per network.

import { getAddress, type Address } from 'viem'

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

export interface NetworkConfig {
  name: string
  chainId: number
  rpcUrl: string
  subgraphUrl: string
  dexSubgraphUrl: string
  contracts: NetworkContracts
}

export const NETWORKS: Record<string, NetworkConfig> = {
  mainnet: {
    name: 'mainnet',
    chainId: 96369,
    rpcUrl: 'https://api.lux.network/ext/bc/C/rpc',
    subgraphUrl: 'http://explorer.lux-mainnet.svc:8090/v1/graph/cchain/amm/graphql',
    dexSubgraphUrl: 'http://explorer.lux-mainnet.svc:8090/v1/graph/cchain/dex/graphql',
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
    rpcUrl: 'https://api.lux-test.network/ext/bc/C/rpc',
    subgraphUrl: 'http://explorer.lux-testnet.svc:8090/v1/graph/cchain/amm/graphql',
    dexSubgraphUrl: 'http://explorer.lux-testnet.svc:8090/v1/graph/cchain/dex/graphql',
    contracts: {
      WLUX: getAddress('0xf3a126C12EE4f413573B8a32a36953Bd43719E30'),
      LUSD: ZERO, // not yet deployed on testnet
      V3_QUOTER_V2: ZERO, // V3 deploy pending
      V3_SWAP_ROUTER_02: ZERO,
      V3_FACTORY: ZERO,
      MULTICALL3,
    },
  },
  devnet: {
    name: 'devnet',
    chainId: 96370,
    rpcUrl: 'https://api.lux-dev.network/ext/bc/C/rpc',
    subgraphUrl: 'http://explorer.lux-devnet.svc:8090/v1/graph/cchain/amm/graphql',
    dexSubgraphUrl: 'http://explorer.lux-devnet.svc:8090/v1/graph/cchain/dex/graphql',
    contracts: {
      WLUX: getAddress('0xc65ea8882020Af7CDa7854d590C6Fcd34BF364ec'),
      LUSD: ZERO,
      V3_QUOTER_V2: ZERO, // V3 deploy pending
      V3_SWAP_ROUTER_02: ZERO,
      V3_FACTORY: ZERO,
      MULTICALL3,
    },
  },
  localnet: {
    name: 'localnet',
    chainId: 1337,
    rpcUrl: 'http://127.0.0.1:9650/ext/bc/C/rpc',
    subgraphUrl: 'http://127.0.0.1:8090/v1/graph/cchain/amm/graphql',
    dexSubgraphUrl: 'http://127.0.0.1:8090/v1/graph/cchain/dex/graphql',
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
