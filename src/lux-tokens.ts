// Known Lux mainnet tokens with metadata
// All addresses are bridge-era (verified on-chain via the Lux explorer)

export interface TokenMeta {
  address: string
  symbol: string
  name: string
  decimals: number
  logoUrl: string | null
  /**
   * The asset this one stands for, off this chain — a CoinGecko id.
   *
   * Set it and the token takes that asset's live price instead of what its
   * pools say. The pools here were seeded at round token ratios and several
   * have never traded, so LETH/LUSD quotes 0.75 and LBTC/LUSD quotes 1.5 —
   * ether at seventy-five cents and bitcoin at a dollar fifty. An empty pool
   * still sets a price; it sets the one it was seeded at.
   *
   * Leave it unset for anything that only trades here. LUX and LZOO have no
   * upstream, and their pools are the true and only answer for them.
   */
  upstream?: string
}

export const LUX_TOKENS: TokenMeta[] = [
  {
    address: '0x0000000000000000000000000000000000000000',
    symbol: 'LUX',
    name: 'Lux',
    decimals: 18,
    logoUrl: 'https://cdn.lux.network/exchange/icon-png/lux.png',
  },
  {
    address: '0x4888E4a2Ee0F03051c72D2BD3ACf755eD3498B3E',
    symbol: 'WLUX',
    name: 'Wrapped LUX',
    decimals: 18,
    logoUrl: 'https://cdn.lux.network/exchange/icon-png/lux.png',
  },
  {
    address: '0xF85CF66Fd0189C435033056edeC5e525F39374a6',
    symbol: 'USDC',
    name: 'Bridged USDC',
    decimals: 6,
    logoUrl: 'https://coin-images.coingecko.com/coins/images/6319/large/USDC.png?1769615602',
    upstream: 'usd-coin',
  },
  {
    address: '0x60E0a8167FC13dE89348978860466C9ceC24B9ba',
    symbol: 'ETH',
    name: 'Ethereum',
    decimals: 18,
    logoUrl: 'https://coin-images.coingecko.com/coins/images/279/large/ethereum.png?1696501628',
    upstream: 'ethereum',
  },
  {
    address: '0x1E48D32a4F5e9f08DB9aE4959163300FaF8A6C8e',
    symbol: 'BTC',
    name: 'Bitcoin',
    decimals: 8,
    logoUrl: 'https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png?1696501400',
    upstream: 'bitcoin',
  },
  {
    address: '0x26B40f650156C7EbF9e087Dd0dca181Fe87625B7',
    symbol: 'SOL',
    name: 'Solana',
    decimals: 18,
    logoUrl: 'https://coin-images.coingecko.com/coins/images/4128/large/solana.png?1718769756',
    upstream: 'solana',
  },
  {
    address: '0x848Cff46eb323f323b6Bbe1Df274E40793d7f2c2',
    symbol: 'LUSD',
    name: 'Lux Dollar',
    decimals: 18,
    logoUrl: 'https://cdn.lux.network/exchange/icon-png/lusd.png',
  },
  {
    address: '0x5E5290f350352768bD2bfC59c2DA15DD04A7cB88',
    symbol: 'LZOO',
    name: 'Lux ZOO',
    decimals: 18,
    logoUrl: 'https://cdn.lux.network/exchange/icon-png/lzoo.png',
  },
  {
    address: '0x0e4bD0DD67c15dECfBBBdbbE07FC9d51D737693D',
    symbol: 'AVAX',
    name: 'Avalanche',
    decimals: 18,
    logoUrl: 'https://coin-images.coingecko.com/coins/images/12559/large/Avalanche_Circle_RedWhite_Trans.png?1696512369',
    upstream: 'avalanche-2',
  },
  {
    address: '0x94f49D0F4C62bbE4238F4AaA9200287bea9F2976',
    symbol: 'BLAST',
    name: 'Blast',
    decimals: 18,
    logoUrl: 'https://cdn.lux.network/bridge/currencies/blast.svg',
    upstream: 'blast',
  },
  {
    address: '0x6EdcF3645DeF09DB45050638c41157D8B9FEa1cf',
    symbol: 'BNB',
    name: 'BNB',
    decimals: 18,
    logoUrl: 'https://coin-images.coingecko.com/coins/images/825/large/bnb-icon2_2x.png?1696501970',
    upstream: 'binancecoin',
  },
  {
    address: '0xDF7740fCC9B244c192CfFF7b6553a3eEee0f4898',
    symbol: 'BOME',
    name: 'Book of Meme',
    decimals: 18,
    logoUrl: 'https://coin-images.coingecko.com/coins/images/36071/large/bome.png?1710407255',
    upstream: 'book-of-meme',
  },
  {
    address: '0xEf770a556430259d1244F2A1384bd1A672cE9e7F',
    symbol: 'BONK',
    name: 'Bonk',
    decimals: 18,
    logoUrl: 'https://coin-images.coingecko.com/coins/images/28600/large/bonk.jpg?1696527587',
    upstream: 'bonk',
  },
  {
    address: '0x3078847F879A33994cDa2Ec1540ca52b5E0eE2e5',
    symbol: 'CELO',
    name: 'Celo',
    decimals: 18,
    logoUrl: 'https://cdn.lux.network/bridge/currencies/celo.svg',
    upstream: 'celo',
  },
  {
    address: '0xC7bDfc60267649C99a86a701Fc3418b7f0C3D043',
    symbol: 'DOGS',
    name: 'Dogs',
    decimals: 18,
    logoUrl: 'https://cdn.lux.network/bridge/currencies/dogs.svg',
    upstream: 'dogs-2',
  },
  {
    address: '0x28BfC5DD4B7E15659e41190983e5fE3df1132bB9',
    symbol: 'POL',
    name: 'Polygon',
    decimals: 18,
    logoUrl: 'https://coin-images.coingecko.com/coins/images/32440/large/pol.png?1759114181',
    upstream: 'polygon-ecosystem-token',
  },
  {
    address: '0x3141b94b89691009b950c96e97Bff48e0C543E3C',
    symbol: 'TON',
    name: 'Toncoin',
    decimals: 9,
    logoUrl: 'https://coin-images.coingecko.com/coins/images/17980/large/Gram_Circular_Badge.png?1781524778',
    upstream: 'the-open-network',
  },
  {
    address: '0x0A78f7Ce8D65e0FD4D6B78848483bA3C4fb895c5',
    symbol: 'CYRUS',
    name: 'Cyrus AI',
    decimals: 18,
    logoUrl: null,
  },
  {
    address: '0x14F48A55722ecBa725aA83a294a8d3E8bE47DE46',
    symbol: 'MELANIA',
    name: 'Melania Meme',
    decimals: 18,
    logoUrl: 'https://coin-images.coingecko.com/coins/images/53775/large/melania-meme.png?1737329885',
    upstream: 'melania-meme',
  },
  {
    address: '0x768972Ee4038a23b20B3beD3848027460172D897',
    symbol: 'TRUMP',
    name: 'OFFICIAL TRUMP',
    decimals: 18,
    logoUrl: 'https://coin-images.coingecko.com/coins/images/53746/large/trump.png?1737171561',
    upstream: 'official-trump',
  },
  {
    address: '0xA69E6612B525474CB893500b70FD7Ec374CbF9a3',
    symbol: 'Z',
    name: 'Z',
    decimals: 18,
    logoUrl: null,
  },
]

// Zoo mainnet (200200). Every address and every decimals here was read off the
// chain, and so were the symbols — except the wrapper's.
//
// Lux and Zoo were deployed from the same account in the same order, so their
// contracts share addresses AND bytecode, and bytecode carries the name string:
// the wrapped native at 0x4888e4a2 answers symbol() with "WLUX" and name() with
// "Wrapped LUX" on the ZOO chain. Zoo's exchange was printing Lux's name for
// Zoo's own coin. The chain is wrong about this one and the list is right.
//
// Zoo had ONE entry here — its native coin — and the curated list is the gate
// every token surface passes through, so nothing else on the chain could reach
// the exchange at all.
export const ZOO_TOKENS: TokenMeta[] = [
  {
    address: '0x0000000000000000000000000000000000000000',
    symbol: 'ZOO',
    name: 'Zoo',
    decimals: 18,
    logoUrl: 'https://cdn.lux.network/bridge/currencies/zoo.svg',
  },
  {
    address: '0x4888E4a2Ee0F03051c72D2BD3ACf755eD3498B3E',
    symbol: 'WZOO',
    name: 'Wrapped ZOO',
    decimals: 18,
    logoUrl: 'https://cdn.lux.network/bridge/currencies/zoo.svg',
  },
  {
    address: '0x5E5290f350352768bD2bfC59c2DA15DD04A7cB88',
    symbol: 'ZLUX',
    name: 'Zoo LUX',
    decimals: 18,
    logoUrl: 'https://cdn.lux.network/exchange/icon-png/lux.png',
  },
  {
    address: '0x848Cff46eb323f323b6Bbe1Df274E40793d7f2c2',
    symbol: 'ZUSD',
    name: 'Zoo Dollar',
    decimals: 18,
    logoUrl: 'https://cdn.lux.network/bridge/currencies/zoo/zusd.svg',
  },
  {
    address: '0x1E48D32a4F5e9f08DB9aE4959163300FaF8A6C8e',
    symbol: 'ZBTC',
    name: 'Zoo BTC',
    decimals: 18,
    logoUrl: 'https://cdn.lux.network/bridge/currencies/zoo/zbtc.svg',
    upstream: 'bitcoin',
  },
  {
    address: '0x60E0a8167FC13dE89348978860466C9ceC24B9ba',
    symbol: 'ZETH',
    name: 'Zoo ETH',
    decimals: 18,
    logoUrl: 'https://cdn.lux.network/bridge/currencies/zoo/zeth.svg',
    upstream: 'ethereum',
  },
  {
    address: '0x8031e9B0d02a792cfEfaa2BdCA6E1289D385426F',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 18,
    logoUrl: 'https://coin-images.coingecko.com/coins/images/6319/large/USDC.png?1769615602',
    upstream: 'usd-coin',
  },
  {
    address: '0xdf1De693c31E2A5eb869c329529623556b20AbF3',
    symbol: 'USDT',
    name: 'Tether',
    decimals: 18,
    logoUrl: 'https://coin-images.coingecko.com/coins/images/325/large/Tether.png?1696501661',
    upstream: 'tether',
  },
  {
    address: '0x768972Ee4038a23b20B3beD3848027460172D897',
    symbol: 'TRUMP',
    name: 'OFFICIAL TRUMP',
    decimals: 6,
    logoUrl: 'https://coin-images.coingecko.com/coins/images/53746/large/trump.png?1737171561',
    upstream: 'official-trump',
  },
  {
    address: '0x14F48A55722ecBa725aA83a294a8d3E8bE47DE46',
    symbol: 'MELANIA',
    name: 'Melania Meme',
    decimals: 6,
    logoUrl: 'https://coin-images.coingecko.com/coins/images/53775/large/melania-meme.png?1737329885',
    upstream: 'melania-meme',
  },
  {
    address: '0xed15C23b27a69b5bd50b1EeF5b8F1c8D849462b7',
    symbol: 'SLOG',
    name: 'Slog',
    decimals: 6,
    logoUrl: null,
  },
  {
    address: '0x0A78f7Ce8D65e0FD4D6B78848483bA3C4fb895c5',
    symbol: 'CYRUS',
    name: 'Cyrus AI',
    decimals: 6,
    logoUrl: null,
  },
  {
    address: '0xA69E6612B525474CB893500b70FD7Ec374CbF9a3',
    symbol: 'Z',
    name: 'Z',
    decimals: 6,
    logoUrl: null,
  },
]

// Native LUX (the zero sentinel on chainId 96369). Exported explicitly because the
// generic address map below collides at 0x0..0 (both LUX and ZOO use the sentinel for
// their native coin); a sentinel lookup is therefore ambiguous and must NOT be used to
// resolve native LUX. The trading API is C-Chain-only, where native == LUX.
export const LUX_NATIVE: TokenMeta = LUX_TOKENS[0]

// One process serves one network, so a lookup answers from THAT network's
// registry.
//
// Merging every chain's tokens into one map by address cannot work here: Lux and
// Zoo were deployed from the same account in the same order, so they share
// addresses AND bytecode. 0x848cff46 is LUSD on Lux and ZUSD on Zoo; 0x4888e4a2
// is WLUX on one and WZOO on the other. Whichever list was merged last won, for
// both chains — a quote on Lux came back routed "CYRUS -> ZUSD -> WZOO".
// The lookup lives in networks.ts, beside the registry it reads.
