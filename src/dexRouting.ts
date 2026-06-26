// dexRouting.ts — the pure routing decision: does a GraphQL body target the native
// DEX (CLOB) surface, or the AMM (uniswap-v2/v3) graph? It is a pure function of
// the query TEXT (its leading top-level field) with NO I/O and NO endpoint
// knowledge, so both the AMM proxy (graphql.ts) and the native-CLOB adapter
// (dchain.ts) import it WITHOUT a cycle, and it is unit-tested in isolation
// (dexRouting.test.ts).
//
// The decision is a pure function of the query text and one server-side constant
// set (dexRootFields) — the client never supplies the target — so it cannot be
// turned into an SSRF/open-proxy.

// dexRootFields are the root query fields that ONLY the native DEX (CLOB) surface
// resolves. A query whose LEADING top-level field is one of these is a CLOB query
// (routed to the D-Chain adapter); everything else (AMM pools/swaps/tokens/
// factories, and any raw subgraph query) is an AMM query.
export const dexRootFields = new Set([
  'markets', 'market', 'fills', 'fill', 'orders', 'order', 'orderbook',
  'perpPositions', 'perpPosition', 'fundingRates', 'fundingRate',
  'liquidations', 'liquidation', 'marketDayDatas',
])

// isNameStart / isNameChar implement the GraphQL Name production /[_A-Za-z][_0-9A-Za-z]*/.
const isNameStart = (c: string) => /[_A-Za-z]/.test(c)
const isNameChar = (c: string) => /[_0-9A-Za-z]/.test(c)

// leadRootField returns the name of the FIRST field in the operation's top-level
// selection set, or null if there is none. It is the routing key: only the leading
// root field decides amm-vs-dex, so a mixed document `{ pools ... markets ... }`
// routes by `pools` (its lead root), and trigger words that appear only as NESTED
// fields, ALIASES' targets aside, inside string literals, or inside comments never
// mis-route. This replaces a whole-document substring scan, which false-positived on
// all of the above.
//
// The scan skips, in order to find the top-level `{`: `#` comments, `"..."`/`"""..."""`
// string literals (so trigger words inside them don't count), and a balanced `(...)`
// variable-definitions group (whose default values may themselves contain `{ }`). The
// first `{` seen at paren-depth 0 opens the top-level selection set; the first Name
// token after it is the lead field, unless it is an alias (`alias: field`), in which
// case the Name after the `:` is the real field. A leading `...` (fragment spread /
// inline fragment) yields null (routed to the AMM default).
export function leadRootField(query: string): string | null {
  const n = query.length
  let i = 0
  let parenDepth = 0
  let inSelectionSet = false

  const skipString = () => {
    if (query.startsWith('"""', i)) {
      i += 3
      while (i < n && !query.startsWith('"""', i)) i++
      i += 3
      return
    }
    i++ // opening quote
    while (i < n && query[i] !== '"') {
      if (query[i] === '\\') i++ // skip escaped char
      i++
    }
    i++ // closing quote
  }

  const readName = (): string => {
    const start = i
    i++ // first char already known to be a name start
    while (i < n && isNameChar(query[i])) i++
    return query.slice(start, i)
  }

  // Phase 1: advance to the top-level selection-set opener `{` (paren-depth 0).
  while (i < n && !inSelectionSet) {
    const c = query[i]
    if (c === '#') {
      while (i < n && query[i] !== '\n') i++
    } else if (c === '"') {
      skipString()
    } else if (c === '(') {
      parenDepth++
      i++
    } else if (c === ')') {
      if (parenDepth > 0) parenDepth--
      i++
    } else if (c === '{' && parenDepth === 0) {
      inSelectionSet = true
      i++
    } else {
      i++
    }
  }
  if (!inSelectionSet) return null

  // Phase 2: read the first field name in the top-level selection set, skipping
  // comments/strings/whitespace; resolve an `alias: field` to `field`.
  let firstName: string | null = null
  while (i < n) {
    const c = query[i]
    if (c === '#') {
      while (i < n && query[i] !== '\n') i++
    } else if (c === '"') {
      skipString()
    } else if (c === '.') {
      // A leading `...` (fragment spread / inline fragment) is not a routable field.
      return null
    } else if (isNameStart(c)) {
      const name = readName()
      if (firstName === null) {
        firstName = name
        continue // peek ahead for an alias colon
      }
      // We already have a candidate and just read a SECOND name without an
      // intervening colon — the first was the real field (no alias).
      return firstName
    } else if (c === ':') {
      // The name we read was an alias; the real field is the next Name token.
      firstName = null
      i++
    } else {
      // Any other punctuation (e.g. `(`, `{`, `@`) terminates the field name —
      // whatever we have is the lead field.
      if (firstName !== null) return firstName
      i++
    }
  }
  return firstName
}

// isDexQuery reports whether a GraphQL body is a native-CLOB query: its LEADING
// top-level field is one of dexRootFields. CLOB queries are served by the D-Chain
// adapter (dchain.ts); everything else is forwarded to the AMM graph (graphql.ts).
export function isDexQuery(body: any): boolean {
  const root = leadRootField(body?.query || '')
  return root !== null && dexRootFields.has(root)
}
