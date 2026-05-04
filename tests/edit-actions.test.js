import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateEditAction, editActionsCatalogMarkdown, EDIT_ACTIONS } from '../src/edit-actions.js'

describe('validateEditAction', () => {
  it('accepts valid add_section', () => {
    const result = validateEditAction({ action: 'add_section', content: '<p>Hello</p>' })
    assert.deepStrictEqual(result, { valid: true, action: 'add_section', params: { content: '<p>Hello</p>' } })
  })

  it('accepts valid update_section', () => {
    const result = validateEditAction({ action: 'update_section', section_index: 0, content: '<p>New</p>' })
    assert.strictEqual(result.valid, true)
    assert.strictEqual(result.params.section_index, 0)
  })

  it('accepts valid update_title', () => {
    const result = validateEditAction({ action: 'update_title', title: 'New Title' })
    assert.deepStrictEqual(result, { valid: true, action: 'update_title', params: { title: 'New Title' } })
  })

  it('accepts valid update_abstract', () => {
    const result = validateEditAction({ action: 'update_abstract', abstract: 'Summary' })
    assert.strictEqual(result.valid, true)
  })

  it('accepts valid insert_widget', () => {
    const result = validateEditAction({
      action: 'insert_widget', section_index: 0,
      widget_type: 'graph_explorer', entityId: 'abc-123',
    })
    assert.strictEqual(result.valid, true)
  })

  it('rejects unknown action', () => {
    const result = validateEditAction({ action: 'delete_everything' })
    assert.strictEqual(result.valid, false)
    assert.ok(result.errors.some(e => e.includes('Unknown action')))
  })

  it('rejects missing required params', () => {
    const result = validateEditAction({ action: 'add_section' })
    assert.strictEqual(result.valid, false)
    assert.ok(result.errors.some(e => e.includes('content')))
  })

  it('rejects wrong param types', () => {
    const result = validateEditAction({ action: 'update_section', section_index: 'zero', content: '<p>X</p>' })
    assert.strictEqual(result.valid, false)
    assert.ok(result.errors.some(e => e.includes('number')))
  })

  it('rejects null proposal', () => {
    const result = validateEditAction(null)
    assert.strictEqual(result.valid, false)
  })

  it('rejects missing action field', () => {
    const result = validateEditAction({ content: 'hello' })
    assert.strictEqual(result.valid, false)
  })
})

describe('EDIT_ACTIONS', () => {
  it('has six action types', () => {
    assert.strictEqual(Object.keys(EDIT_ACTIONS).length, 6)
  })

  it('insert_entity_mention requires iri + label', () => {
    const ok = validateEditAction({
      action: 'insert_entity_mention',
      iri: 'http://data.fontem.eu/id/Company/ef69a162-e55c-5d6b-a497-f6436c4e050c',
      label: 'Siemens AG',
    })
    assert.strictEqual(ok.valid, true)

    const noLabel = validateEditAction({
      action: 'insert_entity_mention',
      iri: 'http://data.fontem.eu/id/Company/ef69a162-e55c-5d6b-a497-f6436c4e050c',
    })
    assert.strictEqual(noLabel.valid, false)
  })

  it('each action has description, params, example', () => {
    for (const [key, spec] of Object.entries(EDIT_ACTIONS)) {
      assert.ok(spec.description, `${key} missing description`)
      assert.ok(spec.params, `${key} missing params`)
      assert.ok(spec.example, `${key} missing example`)
    }
  })
})

describe('editActionsCatalogMarkdown', () => {
  it('includes all action names', () => {
    const md = editActionsCatalogMarkdown()
    for (const key of Object.keys(EDIT_ACTIONS)) {
      assert.ok(md.includes(key), `Missing ${key}`)
    }
  })

  it('includes examples', () => {
    const md = editActionsCatalogMarkdown()
    assert.ok(md.includes('```json'))
  })
})
