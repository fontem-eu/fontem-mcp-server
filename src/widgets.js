/**
 * Widget catalog — describes the embeddable visualizations available
 * in the GMR report editor. The LLM reads this as a resource and writes
 * widget blocks directly in its responses.
 *
 * Syntax in reports:
 *   ```widget
 *   {"widget_type": "graph_explorer", "entityId": "...", ...}
 *   ```
 */

export const WIDGET_TYPES = {
  graph_explorer: {
    label: 'Graph Explorer',
    description: 'Interactive entity relationship graph centered on a node. Shows companies, authorities, persons, contracts, and lobbyists with their connections.',
    schema: {
      widget_type: { type: 'string', const: 'graph_explorer' },
      schema_version: { type: 'number', const: 1 },
      entityId: { type: 'string', description: 'GMR UUID or authority_id to center the graph on' },
      depth: { type: 'number', description: 'Traversal depth (1-3)', default: 1 },
      typeFilters: { type: 'object', description: 'Which node types to show, e.g. {Company: true, Contract: false}' },
      timeRange: { type: 'string', description: 'Filter by time: "12m", "3y", "5y", "all"', default: '12m' },
      summaryEdges: { type: 'boolean', description: 'Show CLIENT_OF/SUPPLIER_OF summary edges', default: true },
    },
    required: ['widget_type', 'entityId'],
    example: '```widget\n{"widget_type": "graph_explorer", "schema_version": 1, "entityId": "ef69a162-e55c-5d6b-a497-f6436c4e050c", "depth": 2}\n```',
  },
  contracts_table: {
    label: 'Contracts Table',
    description: 'Sortable table of EU public procurement contracts for a company or authority. Shows date, title, value in EUR, authority, CPV sector.',
    schema: {
      widget_type: { type: 'string', const: 'contracts_table' },
      schema_version: { type: 'number', const: 1 },
      entityId: { type: 'string', description: 'GMR UUID or authority_id' },
    },
    required: ['widget_type', 'entityId'],
    example: '```widget\n{"widget_type": "contracts_table", "schema_version": 1, "entityId": "ef69a162-e55c-5d6b-a497-f6436c4e050c"}\n```',
  },
  entity_profile: {
    label: 'Entity Profile',
    description: 'Full profile card for a company: financials, directors, corporate group, procurement summary.',
    schema: {
      widget_type: { type: 'string', const: 'entity_profile' },
      schema_version: { type: 'number', const: 1 },
      entityId: { type: 'string', description: 'GMR UUID or ticker symbol' },
    },
    required: ['widget_type', 'entityId'],
    example: '```widget\n{"widget_type": "entity_profile", "schema_version": 1, "entityId": "AAPL"}\n```',
  },
}

/**
 * Validate a widget config JSON.
 * Returns { valid: true } or { valid: false, errors: [...] }.
 */
export function validateWidget(config) {
  const errors = []

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Config must be a JSON object'] }
  }

  const { widget_type } = config
  if (!widget_type) {
    errors.push('Missing required field: widget_type')
    return { valid: false, errors }
  }

  const spec = WIDGET_TYPES[widget_type]
  if (!spec) {
    errors.push(`Unknown widget_type: "${widget_type}". Valid types: ${Object.keys(WIDGET_TYPES).join(', ')}`)
    return { valid: false, errors }
  }

  for (const field of spec.required) {
    if (config[field] === undefined || config[field] === null || config[field] === '') {
      errors.push(`Missing required field: ${field}`)
    }
  }

  return errors.length ? { valid: false, errors } : { valid: true }
}

/**
 * Generate the full widget catalog as a markdown document for the LLM resource.
 */
export function widgetCatalogMarkdown() {
  let md = '# GMR Widget Catalog\n\n'
  md += 'Embed interactive visualizations in reports using this syntax:\n\n'
  md += '````\n```widget\n{"widget_type": "...", "schema_version": 1, ...}\n```\n````\n\n'

  for (const [key, spec] of Object.entries(WIDGET_TYPES)) {
    md += `## ${spec.label} (\`${key}\`)\n\n`
    md += `${spec.description}\n\n`
    md += '**Fields:**\n'
    for (const [field, meta] of Object.entries(spec.schema)) {
      const req = spec.required.includes(field) ? ' (required)' : ''
      md += `- \`${field}\`: ${meta.description || meta.type}${req}\n`
    }
    md += `\n**Example:**\n\n${spec.example}\n\n`
  }

  return md
}
