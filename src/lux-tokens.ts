// Known Lux mainnet tokens with metadata
// All addresses are bridge-era (verified on-chain via the Lux explorer)

export interface TokenMeta {
  address: string
  symbol: string
  name: string
  decimals: number
  logoUrl: string | null
}

export const LUX_TOKENS: TokenMeta[] = [
  {
    address: '0x0000000000000000000000000000000000000000',
    symbol: 'LUX',
    name: 'Lux',
    decimals: 18,
    logoUrl: 'https://lux.exchange/assets/lux_app_logo-4TeLXZ7D.svg',
  },
  {
    address: '0x4888E4a2Ee0F03051c72D2BD3ACf755eD3498B3E',
    symbol: 'WLUX',
    name: 'Wrapped LUX',
    decimals: 18,
    logoUrl: 'https://lux.exchange/assets/lux_app_logo-4TeLXZ7D.svg',
  },
  {
    address: '0xF85CF66Fd0189C435033056edeC5e525F39374a6',
    symbol: 'USDC',
    name: 'Bridged USDC',
    decimals: 6,
    logoUrl: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
  },
  {
    address: '0x60E0a8167FC13dE89348978860466C9ceC24B9ba',
    symbol: 'LETH',
    name: 'Lux ETH',
    decimals: 18,
    logoUrl: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
  },
  {
    address: '0x1E48D32a4F5e9f08DB9aE4959163300FaF8A6C8e',
    symbol: 'LBTC',
    name: 'Lux BTC',
    decimals: 8,
    logoUrl: 'https://assets.coingecko.com/coins/images/1/small/bitcoin.png',
  },
  {
    address: '0x26B40f650156C7EbF9e087Dd0dca181Fe87625B7',
    symbol: 'LSOL',
    name: 'Lux Solana',
    decimals: 18,
    logoUrl: 'https://assets.coingecko.com/coins/images/4128/small/solana.png',
  },
  {
    address: '0x848Cff46eb323f323b6Bbe1Df274E40793d7f2c2',
    symbol: 'LUSD',
    name: 'Lux Dollar',
    decimals: 18,
    logoUrl: null,
  },
  {
    address: '0x5E5290f350352768bD2bfC59c2DA15DD04A7cB88',
    symbol: 'LZOO',
    name: 'Lux ZOO',
    decimals: 18,
    logoUrl: null,
  },
  {
    address: '0x0e4bD0DD67c15dECfBBBdbbE07FC9d51D737693D',
    symbol: 'LAVAX',
    name: 'Lux AVAX',
    decimals: 18,
    logoUrl: 'https://assets.coingecko.com/coins/images/12559/small/Avalanche_Circle_RedWhite_Trans.png',
  },
  {
    address: '0x94f49D0F4C62bbE4238F4AaA9200287bea9F2976',
    symbol: 'LBLAST',
    name: 'Lux BLAST',
    decimals: 18,
    logoUrl: null,
  },
  {
    address: '0x6EdcF3645DeF09DB45050638c41157D8B9FEa1cf',
    symbol: 'LBNB',
    name: 'Lux BNB',
    decimals: 18,
    logoUrl: 'https://assets.coingecko.com/coins/images/825/small/bnb-icon2_2x.png',
  },
  {
    address: '0xDF7740fCC9B244c192CfFF7b6553a3eEee0f4898',
    symbol: 'LBOME',
    name: 'Lux BOME',
    decimals: 18,
    logoUrl: null,
  },
  {
    address: '0xEf770a556430259d1244F2A1384bd1A672cE9e7F',
    symbol: 'LBONK',
    name: 'Lux BONK',
    decimals: 18,
    logoUrl: null,
  },
  {
    address: '0x3078847F879A33994cDa2Ec1540ca52b5E0eE2e5',
    symbol: 'LCELO',
    name: 'Lux CELO',
    decimals: 18,
    logoUrl: null,
  },
  {
    address: '0xC7bDfc60267649C99a86a701Fc3418b7f0C3D043',
    symbol: 'LDOGS',
    name: 'Lux DOGS',
    decimals: 18,
    logoUrl: null,
  },
  {
    address: '0x28BfC5DD4B7E15659e41190983e5fE3df1132bB9',
    symbol: 'LPOL',
    name: 'Lux POL',
    decimals: 18,
    logoUrl: 'https://assets.coingecko.com/coins/images/4713/small/polygon.png',
  },
  {
    address: '0x3141b94b89691009b950c96e97Bff48e0C543E3C',
    symbol: 'LTON',
    name: 'Lux Toncoin',
    decimals: 9,
    logoUrl: 'https://assets.coingecko.com/coins/images/17980/small/ton_symbol.png',
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
    logoUrl: null,
  },
  {
    address: '0x768972Ee4038a23b20B3beD3848027460172D897',
    symbol: 'TRUMP',
    name: 'OFFICIAL TRUMP',
    decimals: 18,
    logoUrl: null,
  },
  {
    address: '0xA69E6612B525474CB893500b70FD7Ec374CbF9a3',
    symbol: 'Z',
    name: 'Z',
    decimals: 18,
    logoUrl: null,
  },
]

export const ZOO_TOKENS: TokenMeta[] = [
  {
    address: '0x0000000000000000000000000000000000000000',
    symbol: 'ZOO',
    name: 'Zoo',
    decimals: 18,
    logoUrl: null,
  },
]

const tokensByAddress = new Map<string, TokenMeta>()
for (const t of [...LUX_TOKENS, ...ZOO_TOKENS]) {
  tokensByAddress.set(t.address.toLowerCase(), t)
}

export function getTokenMeta(address: string): TokenMeta | undefined {
  return tokensByAddress.get(address.toLowerCase())
}
