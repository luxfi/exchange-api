import express from 'express'
import { handleGraphQL } from './graphql'
import { handleSwappableTokens, handleQuote, handleSwap, handleCheckApproval } from './trading'
import {
  handleTokenRankings,
  TOKEN_RANKINGS_PATH,
  handleExploreStats,
  EXPLORE_STATS_PATH,
  handleProtocolStats,
  PROTOCOL_STATS_PATH,
} from './explore'

const app = express()
const PORT = parseInt(process.env.PORT || '4000')

app.use(express.json({ limit: '1mb' }))

// CORS
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.header('Access-Control-Allow-Headers', '*')
  if (_req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

// Health
app.get('/health', (_req, res) => res.json({ status: 'ok' }))

// GraphQL endpoint — matches Uniswap's path
app.post('/v1/graphql', handleGraphQL)

// Trading-api REST surface — on-chain quotes/swaps via dexRouter (QuoterV2 + SwapRouter02)
app.get('/v1/swappable_tokens', handleSwappableTokens)
app.post('/v1/quote', handleQuote)
app.post('/v1/swap', handleSwap)
app.post('/v1/check_approval', handleCheckApproval)

// Connect-RPC data-api — ExploreStatsService.TokenRankings, the token selector's
// default list. Connect unary over HTTP/JSON: GET (?connect=v1&encoding=json
// &message=…) and POST (application/json body). Path = package.Service/Method.
app.get(TOKEN_RANKINGS_PATH, handleTokenRankings)
app.post(TOKEN_RANKINGS_PATH, handleTokenRankings)
// ExploreStatsService.ExploreStats (token/pool tables) + .ProtocolStats (TVL/volume
// charts) — the explore page. Same Connect-RPC JSON transport as TokenRankings.
app.get(EXPLORE_STATS_PATH, handleExploreStats)
app.post(EXPLORE_STATS_PATH, handleExploreStats)
app.get(PROTOCOL_STATS_PATH, handleProtocolStats)
app.post(PROTOCOL_STATS_PATH, handleProtocolStats)

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Exchange API proxy listening on :${PORT}`)
})
