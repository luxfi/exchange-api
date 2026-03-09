import express from 'express'
import { handleGraphQL } from './graphql'

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Exchange API proxy listening on :${PORT}`)
})
