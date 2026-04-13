#!/usr/bin/env node
/**
 * GMR MCP Server — gives LLMs access to the EU Knowledge Graph.
 *
 * Resources: widget catalog, graph schema, platform guide
 * Tools: search, company, contracts, graph, paths, fundamentals, validate_widget, web_search
 * Prompts: analyze
 *
 * Transport: stdio (for Claude CLI / Claude Desktop)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { widgetCatalogMarkdown, validateWidget } from './widgets.js'
import { editActionsCatalogMarkdown, validateEditAction, EDIT_ACTIONS } from './edit-actions.js'

const GMR_API = process.env.GMR_API_URL || 'http://gmr-api.gmr.svc.cluster.local'

// ── Helpers ──────────────────────────────────────────────────────

async function apiCall(path) {
  const res = await fetch(`${GMR_API}${path}`)
  if (!res.ok) return JSON.stringify({ error: `API ${res.status}: ${res.statusText}` })
  return await res.text()
}

async function webSearch(query) {
  // Use DuckDuckGo HTML search (no API key needed)
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'GMR-MCP/1.0 (research assistant)' },
    })
    const html = await res.text()
    // Extract result snippets from the HTML
    const results = []
    const regex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>(.+?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>(.+?)<\/a>/g
    let match
    while ((match = regex.exec(html)) !== null && results.length < 5) {
      results.push({
        url: match[1],
        title: match[2].replace(/<[^>]+>/g, ''),
        snippet: match[3].replace(/<[^>]+>/g, ''),
      })
    }
    return JSON.stringify(results.length ? results : [{ note: 'No results found' }])
  } catch (err) {
    return JSON.stringify({ error: err.message })
  }
}

// ── MCP Server ───────────────────────────────────────────────────

const server = new McpServer({
  name: 'gmr',
  version: '1.0.0',
})

// ── Resources ────────────────────────────────────────────────────

server.resource(
  'widget-catalog',
  'gmr://widgets/catalog',
  async () => ({
    contents: [{
      uri: 'gmr://widgets/catalog',
      mimeType: 'text/markdown',
      text: widgetCatalogMarkdown(),
    }],
  }),
)

server.resource(
  'graph-schema',
  'gmr://schema/graph',
  async () => ({
    contents: [{
      uri: 'gmr://schema/graph',
      mimeType: 'text/markdown',
      text: `# GMR Knowledge Graph Schema

## Node Types
- **Company** (gmr_id) — 3.4M entities from GLEIF, EDGAR, ESEF. Properties: name, country, lei, vat, active
- **Authority** (authority_id) — public procurement authorities. Properties: name, country
- **Contract** (ted_notice_id) — EU procurement awards. Properties: title, value_eur, cpv_main, publication_date, award_date
- **Person** (person_id) — company directors/officers. Properties: name, first_name, birth_year, nationality
- **Listing** (ticker) — stock exchange tickers. Properties: ticker, exchange, currency, active
- **FinancialYear** — annual financials. Properties: year, revenue, net_income, total_assets, equity
- **Lobbyist** (tr_id) — EU Transparency Register entities. Properties: name, country, category, ep_passes, cost_min, cost_max
- **LobbyInterest** — lobbying topics. Properties: name
- **CPV** (code) — procurement classification codes

## Relationship Types
- SUBSIDIARY_OF — Company → Company (corporate group)
- AWARDED — Authority → Contract
- AWARDED_TO — Contract → Company
- CLIENT_OF — Authority → Company (summary: total contracts + EUR)
- SUPPLIER_OF — Company → Authority (reverse summary)
- DIRECTS — Person → Company (role, current)
- LISTED_AS — Company → Listing
- REPORTED — Company → FinancialYear
- INTERESTED_IN — Lobbyist → LobbyInterest
- REPRESENTS — Lobbyist → Company

## ID Formats
- Company: UUID (e.g., "ef69a162-e55c-5d6b-a497-f6436c4e050c")
- Authority: prefixed string (e.g., "ORG-0001234-FRA")
- Lobbyist: TR ID (e.g., "12345678-90")
- Contract: TED notice UUID
`,
    }],
  }),
)

server.resource(
  'platform-guide',
  'gmr://guide/platform',
  async () => ({
    contents: [{
      uri: 'gmr://guide/platform',
      mimeType: 'text/markdown',
      text: `# GMR Platform Guide

GMR is an EU Enterprise Knowledge Graph for democratic transparency.
It connects companies, public authorities, elected officials, and lobbyists
through procurement contracts, corporate structures, and lobbying declarations.

## Data Sources
- **GLEIF**: 3.4M company entities with LEI, parent-subsidiary relationships
- **TED**: EU public procurement contracts (€140K+ services, €5.4M+ works)
- **EDGAR/ESEF**: Financial statements for US and EU listed companies
- **EU Transparency Register**: 17K lobbyist organizations with EP access passes and spending
- **French RNE**: Company directors and officers

## Currency
All contract values are in EUR. Financial data for US companies is in USD.

## Report Widgets
Reports can embed interactive visualizations. See the widget catalog resource for syntax.
When you think a visualization would help the user, write the widget block directly in your response.
`,
    }],
  }),
)

server.resource(
  'edit-actions',
  'gmr://actions/edit',
  async () => ({
    contents: [{
      uri: 'gmr://actions/edit',
      mimeType: 'text/markdown',
      text: editActionsCatalogMarkdown(),
    }],
  }),
)

// ── Tools ────────────────────────────────────────────────────────

server.tool(
  'propose_edit',
  'Propose an edit to the current report. The user will review and approve before it is applied. Read the edit-actions resource first to see available actions.',
  { action: z.string().describe('Edit action name'), params: z.object({}).passthrough().describe('Action parameters') },
  async ({ action, params }) => {
    const proposal = { action, ...params }
    const validation = validateEditAction(proposal)
    if (!validation.valid) {
      return { content: [{ type: 'text', text: JSON.stringify({ proposed: false, errors: validation.errors }) }] }
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          proposed: true,
          action: validation.action,
          params: validation.params,
          description: EDIT_ACTIONS[action]?.description || '',
        }),
      }],
    }
  },
)

server.tool(
  'search_entities',
  'Search for companies, authorities, persons, or lobbyists by name',
  { query: z.string().max(500).describe('Search query'), limit: z.number().int().min(1).max(50).default(5).describe('Max results') },
  async ({ query, limit }) => ({
    content: [{ type: 'text', text: await apiCall(`/search?q=${encodeURIComponent(query)}&limit=${limit}`) }],
  }),
)

server.tool(
  'get_company',
  'Get full company profile including contracts, directors, and corporate group',
  { gmr_id: z.string().describe('Company GMR UUID') },
  async ({ gmr_id }) => ({
    content: [{ type: 'text', text: await apiCall(`/companies/${encodeURIComponent(gmr_id)}`) }],
  }),
)

server.tool(
  'get_contracts',
  'Get procurement contracts for a company or authority',
  { entity_id: z.string().describe('Company or Authority ID'), limit: z.number().int().min(1).max(200).default(20) },
  async ({ entity_id, limit }) => {
    let result = await apiCall(`/companies/${encodeURIComponent(entity_id)}/contracts?limit=${limit}`)
    if (result.includes('"error"') || result.includes('404')) {
      result = await apiCall(`/authorities/${encodeURIComponent(entity_id)}/contracts?limit=${limit}`)
    }
    return { content: [{ type: 'text', text: result }] }
  },
)

server.tool(
  'get_authority',
  'Get authority profile with awarded contracts summary',
  { authority_id: z.string().describe('Authority ID') },
  async ({ authority_id }) => ({
    content: [{ type: 'text', text: await apiCall(`/authorities/${encodeURIComponent(authority_id)}`) }],
  }),
)

server.tool(
  'explore_graph',
  'Traverse the entity relationship graph from a starting node. Returns connected nodes and edges.',
  { entity_id: z.string().describe('Starting entity UUID'), depth: z.number().int().min(1).max(3).default(1).describe('Traversal depth 1-3') },
  async ({ entity_id, depth }) => ({
    content: [{ type: 'text', text: await apiCall(`/graph/${encodeURIComponent(entity_id)}?depth=${depth}`) }],
  }),
)

server.tool(
  'find_paths',
  'Find connections (shortest paths) between two entities',
  { from_id: z.string().describe('Source entity UUID'), to_id: z.string().describe('Target entity UUID') },
  async ({ from_id, to_id }) => ({
    content: [{ type: 'text', text: await apiCall(`/graph/paths/find?from=${encodeURIComponent(from_id)}&to=${encodeURIComponent(to_id)}`) }],
  }),
)

server.tool(
  'get_fundamentals',
  'Get financial fundamentals (revenue, margins, ratios) for a listed company',
  { ticker: z.string().max(20).describe('Ticker symbol (e.g., AAPL, ASML.AS)'), years: z.number().int().min(1).max(20).default(5) },
  async ({ ticker, years }) => ({
    content: [{ type: 'text', text: await apiCall(`/${encodeURIComponent(ticker)}/fundamentals?years=${years}`) }],
  }),
)

server.tool(
  'validate_widget',
  'Validate a widget JSON config before embedding in a report. Returns {valid: true} or {valid: false, errors: [...]}',
  { config: z.object({}).passthrough().describe('The widget JSON config to validate') },
  async ({ config }) => ({
    content: [{ type: 'text', text: JSON.stringify(validateWidget(config)) }],
  }),
)

server.tool(
  'web_search',
  'Search the web for supplementary information (news, Wikipedia, public records). Use this to complement graph data with external context.',
  { query: z.string().describe('Search query') },
  async ({ query }) => ({
    content: [{ type: 'text', text: await webSearch(query) }],
  }),
)

// ── Prompts ──────────────────────────────────────────────────────

server.prompt(
  'analyze',
  'Investigate an entity or topic using the GMR knowledge graph',
  { subject: z.string().describe('Entity name, topic, or question to investigate') },
  ({ subject }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Analyze "${subject}" using the GMR knowledge graph.

1. Search for the entity and identify it
2. Look up its key data (contracts, financials, connections, lobbying)
3. Explore its network (graph traversal)
4. Search the web for recent news or context
5. Summarize your findings with specific numbers and citations
6. Suggest relevant visualizations to embed in a report (use the widget syntax from the widget catalog)

Be thorough but concise. Use bullet points. Cite specific entity IDs so the reader can verify.`,
      },
    }],
  }),
)

// ── Start ────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
