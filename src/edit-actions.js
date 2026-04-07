/**
 * Report edit action schemas — SINGLE SOURCE OF TRUTH.
 *
 * Used by:
 *   1. MCP server → tells Claude what edits are possible (propose_edit tool)
 *   2. Frontend   → validates proposed edits before executing with user's auth
 *
 * Each action defines:
 *   - description: what it does (for the LLM)
 *   - params: parameter schema (validated on both sides)
 *   - example: example invocation (for the LLM)
 */

export const EDIT_ACTIONS = {
  add_section: {
    description: 'Add a new section to the report with the given HTML content.',
    params: {
      content: { type: 'string', required: true, description: 'HTML content for the new section' },
    },
    example: { action: 'add_section', content: '<p>Analysis of procurement patterns...</p>' },
  },

  update_section: {
    description: 'Replace the content of an existing section by its index (0-based).',
    params: {
      section_index: { type: 'number', required: true, description: 'Section index (0-based)' },
      content: { type: 'string', required: true, description: 'New HTML content' },
    },
    example: { action: 'update_section', section_index: 0, content: '<p>Updated analysis...</p>' },
  },

  update_title: {
    description: 'Change the report title.',
    params: {
      title: { type: 'string', required: true, description: 'New report title' },
    },
    example: { action: 'update_title', title: 'VINCI Procurement Analysis 2024' },
  },

  update_abstract: {
    description: 'Change the report abstract/summary.',
    params: {
      abstract: { type: 'string', required: true, description: 'New abstract text' },
    },
    example: { action: 'update_abstract', abstract: 'An investigation into...' },
  },

  insert_widget: {
    description: 'Insert an interactive visualization widget into a section. The widget renders live data from the graph.',
    params: {
      section_index: { type: 'number', required: true, description: 'Section to insert into (0-based). Use -1 for last section.' },
      widget_type: { type: 'string', required: true, description: 'One of: graph_explorer, contracts_table, entity_profile' },
      entityId: { type: 'string', required: true, description: 'Entity UUID or ticker to visualize' },
      depth: { type: 'number', required: false, description: 'Graph depth (for graph_explorer only, default 1)' },
    },
    example: { action: 'insert_widget', section_index: -1, widget_type: 'graph_explorer', entityId: 'abc-123', depth: 2 },
  },
}

/**
 * Validate a proposed edit action.
 * Returns { valid: true, action, params } or { valid: false, errors: [...] }.
 */
export function validateEditAction(proposal) {
  const errors = []

  if (!proposal || typeof proposal !== 'object') {
    return { valid: false, errors: ['Proposal must be a JSON object'] }
  }

  const { action, ...params } = proposal
  if (!action) {
    errors.push('Missing required field: action')
    return { valid: false, errors }
  }

  const spec = EDIT_ACTIONS[action]
  if (!spec) {
    errors.push(`Unknown action: "${action}". Valid actions: ${Object.keys(EDIT_ACTIONS).join(', ')}`)
    return { valid: false, errors }
  }

  for (const [name, meta] of Object.entries(spec.params)) {
    if (meta.required && (params[name] === undefined || params[name] === null)) {
      errors.push(`Missing required parameter: ${name}`)
    }
    if (params[name] !== undefined && meta.type === 'number' && typeof params[name] !== 'number') {
      errors.push(`Parameter ${name} must be a number`)
    }
    if (params[name] !== undefined && meta.type === 'string' && typeof params[name] !== 'string') {
      errors.push(`Parameter ${name} must be a string`)
    }
  }

  return errors.length
    ? { valid: false, errors }
    : { valid: true, action, params }
}

/**
 * Generate markdown documentation of all edit actions for the LLM resource.
 */
export function editActionsCatalogMarkdown() {
  let md = '# Report Edit Actions\n\n'
  md += 'Use the `propose_edit` tool to suggest changes to the current report.\n'
  md += 'Each proposal must include an `action` field and the required parameters.\n\n'

  for (const [key, spec] of Object.entries(EDIT_ACTIONS)) {
    md += `## \`${key}\`\n\n${spec.description}\n\n`
    md += '**Parameters:**\n'
    for (const [name, meta] of Object.entries(spec.params)) {
      const req = meta.required ? ' (required)' : ''
      md += `- \`${name}\` (${meta.type}${req}): ${meta.description}\n`
    }
    md += `\n**Example:**\n\`\`\`json\n${JSON.stringify(spec.example, null, 2)}\n\`\`\`\n\n`
  }

  return md
}
