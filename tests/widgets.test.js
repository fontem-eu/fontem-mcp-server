import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateWidget, widgetCatalogMarkdown, WIDGET_TYPES } from '../src/widgets.js'

describe('validateWidget', () => {
  it('accepts valid graph_explorer config', () => {
    const result = validateWidget({
      widget_type: 'graph_explorer',
      schema_version: 1,
      entityId: 'abc-123',
    })
    assert.deepStrictEqual(result, { valid: true })
  })

  it('accepts valid contracts_table config', () => {
    const result = validateWidget({
      widget_type: 'contracts_table',
      schema_version: 1,
      entityId: 'abc-123',
    })
    assert.deepStrictEqual(result, { valid: true })
  })

  it('accepts valid entity_profile config', () => {
    const result = validateWidget({
      widget_type: 'entity_profile',
      schema_version: 1,
      entityId: 'AAPL',
    })
    assert.deepStrictEqual(result, { valid: true })
  })

  it('rejects missing widget_type', () => {
    const result = validateWidget({ entityId: 'abc' })
    assert.strictEqual(result.valid, false)
    assert.ok(result.errors.some(e => e.includes('widget_type')))
  })

  it('rejects unknown widget_type', () => {
    const result = validateWidget({ widget_type: 'pie_chart', entityId: 'abc' })
    assert.strictEqual(result.valid, false)
    assert.ok(result.errors.some(e => e.includes('Unknown')))
  })

  it('rejects missing entityId for graph_explorer', () => {
    const result = validateWidget({ widget_type: 'graph_explorer' })
    assert.strictEqual(result.valid, false)
    assert.ok(result.errors.some(e => e.includes('entityId')))
  })

  it('rejects null config', () => {
    const result = validateWidget(null)
    assert.strictEqual(result.valid, false)
  })

  it('rejects non-object config', () => {
    const result = validateWidget('not an object')
    assert.strictEqual(result.valid, false)
  })
})

describe('WIDGET_TYPES', () => {
  it('has three widget types', () => {
    assert.strictEqual(Object.keys(WIDGET_TYPES).length, 3)
  })

  it('each type has required fields', () => {
    for (const [key, spec] of Object.entries(WIDGET_TYPES)) {
      assert.ok(spec.label, `${key} missing label`)
      assert.ok(spec.description, `${key} missing description`)
      assert.ok(spec.schema, `${key} missing schema`)
      assert.ok(spec.required, `${key} missing required`)
      assert.ok(spec.example, `${key} missing example`)
    }
  })
})

describe('widgetCatalogMarkdown', () => {
  it('returns a non-empty markdown string', () => {
    const md = widgetCatalogMarkdown()
    assert.ok(md.length > 100)
    assert.ok(md.includes('# GMR Widget Catalog'))
  })

  it('includes all widget types', () => {
    const md = widgetCatalogMarkdown()
    assert.ok(md.includes('graph_explorer'))
    assert.ok(md.includes('contracts_table'))
    assert.ok(md.includes('entity_profile'))
  })

  it('includes examples', () => {
    const md = widgetCatalogMarkdown()
    assert.ok(md.includes('```widget'))
  })
})
