// Side-effect-only: pin SUBGRAPH_URL to the PUBLIC AMM read endpoint for tests, unless
// an operator already set it. The production default (explorer.lux-mainnet.svc) is an
// in-cluster address unreachable from outside, so live discovery tests need the public
// host. This module MUST be imported before ./subgraph (transitively before ./trading),
// because subgraph.ts captures SUBGRAPH_URL at module-load time. In CommonJS, import
// statements compile to ordered require() calls, so importing this first runs it first.
if (!process.env.SUBGRAPH_URL) {
  process.env.SUBGRAPH_URL = 'https://explore.lux.network/v1/graph/cchain/amm/graphql'
}

export const PUBLIC_GRAPH = 'https://explore.lux.network/v1/graph/cchain/amm/graphql'
