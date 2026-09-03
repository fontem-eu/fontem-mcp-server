#!/usr/bin/env node
/**
 * Dargle MCP Server — gives LLMs access to the EU Knowledge Graph.
 *
 * Resources: widget catalog, graph schema, platform guide
 * Tools: search, company, contracts, graph, paths, fundamentals, validate_widget, web_search
 * Prompts: analyze
 *
 * Transport: stdio (for Claude CLI / Claude Desktop)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { startHttp } from './http-transport.js'
import { z } from 'zod'
import { widgetCatalogMarkdown, validateWidget } from './widgets.js'
import { editActionsCatalogMarkdown, validateEditAction, EDIT_ACTIONS } from './edit-actions.js'
import { sparqlQuery as sparqlProxy } from './sparql.js'

const GMR_API = process.env.GMR_API_URL || 'http://fontem-api'
const VIRTUOSO_SPARQL = process.env.VIRTUOSO_SPARQL_URL
  || 'http://virtuoso.fontem-prod.svc.cluster.local:8890/sparql'

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
      headers: { 'User-Agent': 'Dargle-MCP/1.0 (research assistant)' },
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
  name: 'dargle',
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
      text: `# Dargle Knowledge Graph Schema

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
      text: `# Dargle Platform Guide

Dargle is an EU Enterprise Knowledge Graph for democratic transparency.
It connects companies, public authorities, elected officials, and lobbyists
through procurement contracts, corporate structures, and lobbying declarations.

## The name
The platform is called **Dargle**. Its motto is "Discover. Argue. Learn. Enjoy."

You will see the word "fontem" throughout the plumbing — hostnames like
fontem.eu, entity IRIs under data.fontem.eu, and service names in tool results
and error messages. That is the internal name and it is staying; none of it is
the product's name. Call the platform Dargle when you speak to a user, whatever
the surrounding machinery calls itself, and do not correct or explain the
discrepancy unless asked.

## Data Sources
- **GLEIF**: 3.4M company entities with LEI, parent-subsidiary relationships
- **TED**: EU public procurement contracts (€140K+ services, €5.4M+ works)
- **EDGAR/ESEF**: Financial statements for US and EU listed companies
- **EU Transparency Register**: 17K lobbyist organizations with EP access passes and spending
- **French RNE**: Company directors and officers

## Currency
All contract values are in EUR. Financial data for US companies is in USD.

## Data-story Widgets
Data stories can embed interactive visualizations. See the widget catalog resource for syntax.
When you think a visualization would help the user, write the widget block directly in your response.

## Entity mentions (Fontem IRIs)
Beyond widgets, the editor supports inline @-mentions of graph entities. Each mention is stored as a Fontem IRI:

  http://data.fontem.eu/id/<Class>/<uuid>

where <Class> is one of Company, Authority, Person, Lobbyist, NUTSRegion, CohesionProject, SanctionedEntity and <uuid> is the existing gmr_id (UUID5). When prose names a graph entity, prefer **propose_edit with action=insert_entity_mention** (see edit-actions resource) over plain text — readers get a clickable chip that opens a side panel with the entity's facts. Today only Company chips reliably resolve; other classes will land as the Virtuoso migration normalises ids.

The search_entities tool already includes a constructed \`iri\` on each Company hit; copy it through to the mention.

## Atlas — European Statistics Catalogue
Beyond the procurement graph, the platform exposes a curated catalogue of Eurostat
datasets (population, GDP, unemployment, R&D, migration, crime, etc.) keyed by
NUTS region. Use \`atlas_list_datasets\` to browse available codes and
\`atlas_get_series\` to fetch a slice. The \`atlas_map\` widget renders a
choropleth snapshot inline in a data story.

## SPARQL — federated knowledge bases (read-only)
The platform runs a Virtuoso triple store that mirrors several public
knowledge graphs locally. Use the \`sparql_query\` tool for cross-source
facts that the graph API doesn't expose directly. Available named graphs:

- \`http://data.fontem.eu/graph/sanctions\` — current EU consolidated sanctions
- \`http://data.fontem.eu/graph/financials/edgar\` — SEC EDGAR filings (US)
- \`http://data.fontem.eu/graph/financials/esef\` — ESEF filings (EU listed)
- \`http://data.fontem.eu/graph/wikidata/truthy\` — Wikidata best-value statements (cross-IDs, multilingual labels, geographic + political metadata)
- \`http://data.fontem.eu/graph/eu/eurovoc\` — EuroVoc multilingual subject thesaurus
- \`http://data.fontem.eu/graph/eu/cellar\` — EU legal acts + dossiers from the EU Publications Office (regulations, directives, decisions)
- \`http://data.fontem.eu/graph/eu/cordis\` — EU Horizon / H2020 / FP7 research projects

Read the \`sparql-datasets\` resource for sample queries and prefix
suggestions. **Prefer SPARQL over web search** when a question can be
answered from the local copies — it's faster, doesn't egress, and
gives the user a citable IRI.
`,
    }],
  }),
)

server.resource(
  'sparql-datasets',
  'gmr://sparql/datasets',
  async () => ({
    contents: [{
      uri: 'gmr://sparql/datasets',
      mimeType: 'text/markdown',
      text: `# SPARQL datasets — read-only via \`sparql_query\`

The Virtuoso triple store at the platform's prod endpoint hosts both
**our own data** (sanctions, financial filings, Authority/Company IRIs)
and **mirrored encyclopedic knowledge** (Wikidata, EuroVoc, CELLAR,
CORDIS) so the AI helper can answer most factual questions without
leaving the platform's network.

All graphs share the SPARQL endpoint. Cross-graph joins are first-class
— that's the entire point of having them in one store. Standard prefix
conventions:

\`\`\`sparql
PREFIX wd:      <http://www.wikidata.org/entity/>
PREFIX wdt:     <http://www.wikidata.org/prop/direct/>
PREFIX cellar:  <http://publications.europa.eu/resource/cellar/>
PREFIX eurovoc: <http://eurovoc.europa.eu/>
PREFIX cordis:  <http://cordis.europa.eu/data/>
PREFIX fontem:  <http://data.fontem.eu/id/>
PREFIX fgraph:  <http://data.fontem.eu/graph/>
PREFIX skos:    <http://www.w3.org/2004/02/skos/core#>
PREFIX rdfs:    <http://www.w3.org/2000/01/rdf-schema#>
\`\`\`

## Graphs

### \`fgraph:wikidata/truthy\` — Wikidata best-value statements
Encyclopedic knowledge mirrored locally as N-Triples. The truthy slice
materializes Wikidata's *best* (truthy) statement per (subject, predicate),
filtered to the property whitelist we actually use. License: **CC0 1.0**.

**Predicates we keep** (anything else is filtered out):

| Predicate IRI | Wikidata id | Meaning |
|---|---|---|
| \`wdt:P1278\` | LEI | Legal Entity Identifier (joins Fontem Company.lei) |
| \`wdt:P5531\` | CIK | SEC EDGAR CIK |
| \`wdt:P5285\` | UK Companies House | UK company number |
| \`wdt:P3220\` | KvK NL | Dutch chamber-of-commerce id |
| \`wdt:P3375\` | BCE BE | Belgian VAT/company id |
| \`wdt:P1297\` | US EIN | Federal Employer Identification Number |
| \`wdt:P17\` | country | (object is a wd:Q… country) |
| \`wdt:P31\` | instance of | (object is a wd:Q… class) |
| \`wdt:P127\` | owned by | parent company (wd:Q…) |
| \`wdt:P749\` | parent organization | (wd:Q…) |
| \`wdt:P159\` | headquarters location | (wd:Q…) |
| \`wdt:P571\` | inception | xsd:dateTime |
| \`wdt:P5052\` | subsidiary | (wd:Q…) |
| \`rdfs:label\` | — | filtered to lang en/de/fr/es/it/pt/nl |
| \`skos:altLabel\` | — | same lang filter |
| \`schema:description\` | — | same lang filter |

**Joining onto our procurement graph**: most Companies in Dargle have an
\`lei\` property; \`wdt:P1278\` is the same identifier. The MCP
\`search_entities\` tool returns Company hits including their LEI; feed it
into \`sparql_query\` as in the example below.

Example — Apple by LEI, with EN/DE labels + country + founding date:

\`\`\`sparql
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT ?qid ?label ?country_qid ?inception WHERE {
  GRAPH <http://data.fontem.eu/graph/wikidata/truthy> {
    ?qid wdt:P1278 "HWUPKR0MPOU8FGXBT394" .
    ?qid <http://www.w3.org/2000/01/rdf-schema#label> ?label .
    FILTER(lang(?label) = "en")
    OPTIONAL { ?qid wdt:P17 ?country_qid }
    OPTIONAL { ?qid wdt:P571 ?inception }
  }
} LIMIT 1
\`\`\`

→ Q312 "Apple Inc.", P17→Q30 (USA), inception 1976-04-01.

### \`fgraph:eu/eurovoc\` — EuroVoc thesaurus (EU Publications Office)
Pure SKOS hierarchy of EU subject vocabulary, multilingual.
License: **CC BY 4.0** (Source: EU Publications Office).

**Predicate inventory** (only common ones; SKOS-AP-EU has many):
- \`skos:prefLabel\` — single per-language preferred term (en/fr/de/it/es/pt/nl/…)
- \`skos:altLabel\` — synonyms in each language
- \`skos:broader\` / \`skos:narrower\` — concept tree
- \`skos:related\` — non-hierarchical cross-links
- \`skos:inScheme\` — parent ConceptScheme
- \`skos:topConceptOf\` — top-of-tree marker
- \`skos:scopeNote\` — usage guidance
- \`dct:created\` / \`dct:modified\` — concept versioning metadata

Concept IRIs look like \`http://eurovoc.europa.eu/100142\`.

Example — find the EuroVoc concept for "public procurement" and walk up:

\`\`\`sparql
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
SELECT ?concept ?parent_label WHERE {
  GRAPH <http://data.fontem.eu/graph/eu/eurovoc> {
    ?concept skos:prefLabel "public procurement"@en ;
             skos:broader ?parent .
    ?parent skos:prefLabel ?parent_label .
    FILTER(lang(?parent_label) = "en")
  }
}
\`\`\`

### \`fgraph:eu/cordis\` — EU research projects
Horizon Europe + H2020 + FP7. **82,370 projects, ~200k organization-role
records (deduped to ~70k distinct organizations)**. Custom \`cordis:\`
vocabulary; we generated this RDF ourselves from CORDIS's CSV dump because
CORDIS retired its native RDF distribution. License: **CC BY 4.0**.

**Prefixes**:
\`\`\`
PREFIX c:     <http://data.fontem.eu/ontology/cordis#>
PREFIX cordis: <http://data.fontem.eu/id/cordis/>
\`\`\`

**Node types**:
- \`c:Project\` — IRI \`cordis:project/{project_id}\`
- \`c:Organization\` — IRI \`cordis:organization/{org_id}\`

**Project predicates** (\`c:\` prefix on each):
| Predicate | Type | Meaning |
|---|---|---|
| \`rdf:type c:Project\` | iri | marker |
| \`c:framework\` | string | "HORIZON" / "H2020" / "FP7" |
| \`rdfs:label\` | string | project title |
| \`c:acronym\` | string | short name |
| \`c:status\` | string | SIGNED / CLOSED / etc. |
| \`c:startDate\` | xsd:date | |
| \`c:endDate\` | xsd:date | |
| \`c:totalCostEur\` | xsd:decimal | total project budget in EUR |
| \`c:ecContributionEur\` | xsd:decimal | EU funding portion in EUR |
| \`c:masterCall\` | string | funding call code |
| \`c:fundingScheme\` | string | grant type (RIA / IA / CSA / etc.) |
| \`c:objective\` | string | abstract / scientific objective |
| \`c:hasParticipant\` | iri → c:Organization | |

**Organization predicates**:
| Predicate | Type | Meaning |
|---|---|---|
| \`rdf:type c:Organization\` | iri | marker |
| \`rdfs:label\` | string | legal name |
| \`c:country\` | string | ISO alpha-2 country code |
| \`c:vatNumber\` | string | VAT registration |
| \`c:sme\` | string | "true" / "false" |
| \`c:activityType\` | string | HES / REC / PRC / PUB / OTH |
| \`c:nutsCode\` | string | NUTS-3 region code |
| \`c:roleIn\` | iri → c:Project | reverse of hasParticipant |
| \`c:role\` | string | coordinator / participant / partner |

Example — top-funded Horizon Europe projects + their coordinator:

\`\`\`sparql
PREFIX c: <http://data.fontem.eu/ontology/cordis#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?title ?total_eur ?coord_label WHERE {
  GRAPH <http://data.fontem.eu/graph/eu/cordis> {
    ?p a c:Project ;
       c:framework "HORIZON" ;
       rdfs:label ?title ;
       c:totalCostEur ?total_eur ;
       c:hasParticipant ?coord .
    ?coord c:role "coordinator" ;
           rdfs:label ?coord_label .
  }
} ORDER BY DESC(xsd:decimal(?total_eur)) LIMIT 5
\`\`\`

### Cross-graph join idioms
The point of having everything in one Virtuoso instance is that named-graph
boundaries don't tax queries. A few patterns to internalize:

**Wikidata QID for a Dargle Company by LEI**:
\`\`\`sparql
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT ?company_iri ?qid WHERE {
  # Take the Fontem Company IRI from a search_entities result (its LEI is
  # in the search payload).
  VALUES (?lei) { ("HWUPKR0MPOU8FGXBT394") }
  GRAPH <http://data.fontem.eu/graph/wikidata/truthy> {
    ?qid wdt:P1278 ?lei .
  }
}
\`\`\`

**Tag a CORDIS project with its EuroVoc subject(s)** (when the project's
\`c:objective\` mentions a EuroVoc term — heuristic, not authoritative):
\`\`\`sparql
PREFIX c: <http://data.fontem.eu/ontology/cordis#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
SELECT ?project ?eurovoc_label WHERE {
  GRAPH <http://data.fontem.eu/graph/eu/cordis> {
    ?project a c:Project ; c:objective ?obj .
  }
  GRAPH <http://data.fontem.eu/graph/eu/eurovoc> {
    ?concept skos:prefLabel ?eurovoc_label .
    FILTER(lang(?eurovoc_label) = "en")
    FILTER(CONTAINS(LCASE(?obj), LCASE(?eurovoc_label)))
  }
} LIMIT 10
\`\`\`

### \`fgraph:eu/cellar\` — EU legal acts + dossiers (NOT YET LOADED)
Will hold every Regulation, Directive, Decision from CELLAR with CELEX
ID, publication date, and EuroVoc subjects. Loading is blocked on an EU
Login setup at \`datadump.publications.europa.eu\` — until then this
graph is empty, queries against it will return zero rows. License:
**CC BY 4.0**.

### Read-write guarantee
The MCP \`sparql_query\` tool is **read-only**. Any query containing
\`INSERT\`, \`DELETE\`, \`CLEAR\`, \`LOAD\`, \`CREATE\`, \`DROP\`,
\`COPY\`, \`MOVE\`, or \`ADD\` is rejected client-side before the
request reaches Virtuoso. The Virtuoso role used by the MCP server is
also \`SPARQL_SELECT\` only — defence in depth.

### Result format
SPARQL Results JSON by default. The shape is the W3C standard
\`{head: {vars: [...]}, results: {bindings: [...]}}\` for SELECT, or
RDF/Turtle for CONSTRUCT/DESCRIBE, or \`{boolean: true|false}\` for ASK.
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
  'Propose an edit to the current data story. The user will review and approve before it is applied. Read the edit-actions resource first to see available actions.',
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
  'Search for companies, authorities, persons, or lobbyists by name. Each Company hit is enriched with a graph `iri` field (http://data.fontem.eu/id/Company/<uuid>) — copy it into propose_edit action=insert_entity_mention to create an inline chip.',
  { query: z.string().max(500).describe('Search query'), limit: z.number().int().min(1).max(50).default(5).describe('Max results') },
  async ({ query, limit }) => {
    const raw = await apiCall(`/search?q=${encodeURIComponent(query)}&limit=${limit}`)
    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      // Upstream emitted a non-JSON error envelope; pass it through
      // unchanged so the assistant sees the same surface.
      return { content: [{ type: 'text', text: raw }] }
    }
    if (Array.isArray(payload?.companies)) {
      for (const c of payload.companies) {
        if (c?.gmr_id) {
          c.iri = `http://data.fontem.eu/id/Company/${c.gmr_id}`
        }
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
  },
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
  'Validate a widget JSON config before embedding in a data story. Returns {valid: true} or {valid: false, errors: [...]}',
  { config: z.object({}).passthrough().describe('The widget JSON config to validate') },
  async ({ config }) => ({
    content: [{ type: 'text', text: JSON.stringify(validateWidget(config)) }],
  }),
)

server.tool(
  'atlas_list_datasets',
  'List the Eurostat datasets available in the Atlas catalogue. Returns code, label, theme, supported NUTS levels, last sync, and per-dimension code→label maps. Use these codes with atlas_get_series and atlas_map widgets.',
  {},
  async () => ({
    content: [{ type: 'text', text: await apiCall('/atlas/datasets') }],
  }),
)

server.tool(
  'atlas_get_series',
  'Fetch time-series rows for one Atlas dataset. Use to confirm which years/dimensions exist before embedding an atlas_map widget. Supply EITHER `geo` (one or more NUTS codes) OR `nuts_level` (0..3 for every region at that level).',
  {
    dataset: z.string().describe('Atlas dataset code, e.g. "nama_10r_2gdp"'),
    geo: z.array(z.string()).optional().describe('NUTS codes, e.g. ["DE","FR"]'),
    nuts_level: z.number().int().min(0).max(3).optional().describe('NUTS level 0..3'),
    start: z.number().int().optional().describe('Start year'),
    end: z.number().int().optional().describe('End year'),
    dimensions: z.object({}).passthrough().optional().describe('Dim code filter, e.g. {"unit":"MIO_EUR"}'),
  },
  async ({ dataset, geo, nuts_level, start, end, dimensions }) => {
    const q = new URLSearchParams()
    q.set('dataset', dataset)
    if (Array.isArray(geo)) for (const g of geo) q.append('geo', g)
    if (nuts_level !== undefined) q.set('nuts_level', String(nuts_level))
    if (start !== undefined) q.set('start', String(start))
    if (end !== undefined) q.set('end', String(end))
    if (dimensions && Object.keys(dimensions).length > 0) {
      q.set('dimensions', JSON.stringify(dimensions))
    }
    return { content: [{ type: 'text', text: await apiCall(`/atlas/series?${q.toString()}`) }] }
  },
)

server.tool(
  'web_search',
  'Search the web for supplementary information (news, Wikipedia, public records). Use this to complement graph data with external context. PREFER `sparql_query` for facts about entities, places, regulations, or research projects — the platform already mirrors Wikidata + EuroVoc + CELLAR + CORDIS locally and they answer faster and more reliably than a web fetch.',
  { query: z.string().describe('Search query') },
  async ({ query }) => ({
    content: [{ type: 'text', text: await webSearch(query) }],
  }),
)

server.tool(
  'sparql_query',
  'Run a read-only SPARQL query (SELECT / CONSTRUCT / ASK / DESCRIBE) against the platform\'s Virtuoso triple store. Available named graphs: our own data (sanctions, financials/edgar, financials/esef) plus mirrored encyclopedic knowledge (Wikidata truthy, EuroVoc, CELLAR EU legal acts, CORDIS research projects). Read the `sparql-datasets` resource for the full graph inventory + sample queries. SPARQL UPDATE / INSERT / DELETE / CLEAR / LOAD are blocked. Default response format is SPARQL Results JSON.',
  {
    query: z.string().max(8000).describe('SPARQL query (SELECT/CONSTRUCT/ASK/DESCRIBE)'),
    timeout_ms: z.number().int().min(1000).max(60000).default(30000).describe('Server-side timeout in ms (max 60s)'),
  },
  async ({ query, timeout_ms }) => ({
    content: [{ type: 'text', text: await sparqlProxy(VIRTUOSO_SPARQL, query, { timeout_ms }) }],
  }),
)

// ── Consolidator tools ──────────────────────────────────────────

const CONSOLIDATOR = process.env.CONSOLIDATOR_URL || 'http://gmr-consolidator.gmr.svc.cluster.local:8000'

async function consolidatorCall(method, path, body) {
  try {
    const res = await fetch(`${CONSOLIDATOR}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) return JSON.stringify({ error: `consolidator ${res.status}: ${res.statusText}` })
    return await res.text()
  } catch (e) {
    return JSON.stringify({ error: `consolidator unreachable: ${e.message}` })
  }
}

server.tool(
  'consolidate_entity',
  'Run the consolidation rule pipeline against a Company or Authority. Returns the rules that fired, decisions made, and any merge target. Idempotent — safe to call repeatedly.',
  {
    entity_type: z.enum(['Company', 'Authority']).describe('Entity label'),
    entity_id: z.string().describe('gmr_id (Company) or authority_id (Authority)'),
  },
  async ({ entity_type, entity_id }) => {
    const path = entity_type === 'Company'
      ? `/consolidate/company/${encodeURIComponent(entity_id)}`
      : `/consolidate/authority/${encodeURIComponent(entity_id)}`
    return { content: [{ type: 'text', text: await consolidatorCall('POST', path) }] }
  },
)

server.tool(
  'list_pending_candidates',
  'List :SAME_AS candidates flagged by the consolidator awaiting human review. Each result shows the rule that produced it, confidence, and the two entities being compared.',
  {
    entity_type: z.enum(['Company', 'Authority']).optional().describe('Filter by entity type'),
    limit: z.number().int().min(1).max(200).default(50).describe('Max results'),
  },
  async ({ entity_type, limit }) => {
    const params = new URLSearchParams({ reviewed: 'false', limit: String(limit) })
    if (entity_type) params.set('entity_type', entity_type)
    return { content: [{ type: 'text', text: await consolidatorCall('GET', `/candidates?${params}`) }] }
  },
)

server.tool(
  'consolidator_decisions',
  'Browse the consolidator decision audit log. Useful for debugging why two entities were/were not merged.',
  {
    entity_type: z.enum(['Company', 'Authority']).optional(),
    entity_id: z.string().optional().describe('Filter to one entity'),
    rule_name: z.string().optional().describe('Filter to one rule, e.g. "exact_lei_match"'),
    limit: z.number().int().min(1).max(200).default(50),
  },
  async ({ entity_type, entity_id, rule_name, limit }) => {
    const params = new URLSearchParams({ limit: String(limit) })
    if (entity_type) params.set('entity_type', entity_type)
    if (entity_id) params.set('entity_id', entity_id)
    if (rule_name) params.set('rule_name', rule_name)
    return { content: [{ type: 'text', text: await consolidatorCall('GET', `/decisions?${params}`) }] }
  },
)

// ── Prompts ──────────────────────────────────────────────────────

server.prompt(
  'analyze',
  'Investigate an entity or topic using the Dargle knowledge graph',
  { subject: z.string().describe('Entity name, topic, or question to investigate') },
  ({ subject }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Analyze "${subject}" using the Dargle knowledge graph.

1. Search for the entity and identify it
2. Look up its key data (contracts, financials, connections, lobbying)
3. Explore its network (graph traversal)
4. Search the web for recent news or context
5. Summarize your findings with specific numbers and citations
6. Suggest relevant visualizations to embed in a data story (use the widget syntax from the widget catalog)

Be thorough but concise. Use bullet points. Cite specific entity IDs so the reader can verify.`,
      },
    }],
  }),
)

// ── Start ────────────────────────────────────────────────────────

// Two transports, same tools.
//
//   stdio — a local client spawns this as a subprocess. How it has always
//           run, and how claude-proxy used it.
//   http  — Streamable HTTP, so a user can point their OWN client (Claude
//           Desktop, Claude Code, ChatGPT) at Fontem and have their
//           subscription pay for the inference.
//
// The second exists because the alternative does not: Anthropic prohibited
// subscription OAuth in third-party tools (2026-02-20) and blocked it
// (2026-04-04), and OpenAI never offered API access on a ChatGPT plan. A
// third party cannot spend a user's subscription — but a user's
// first-party client can call a third party's tools. So we expose the
// tools instead of embedding a model.
if ((process.env.MCP_TRANSPORT || 'stdio').toLowerCase() === 'http') {
  await startHttp(server)
} else {
  await server.connect(new StdioServerTransport())
}
