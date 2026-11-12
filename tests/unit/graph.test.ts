import { describe, expect, test } from 'vitest'

import { buildAppliedGraph as buildGraph, type AppliedGraphArgs } from '../../src/services/graph.js'
import { parseEditorialProposal } from '../../src/services/editorialValidation.js'
import { parseProposalOutput } from '../../src/services/validation.js'
import type { EditorialProposalPayload, EditorialRegistry } from '../../src/types.js'

const registry: EditorialRegistry = { collection: 'posts', exclude: ['content'], relations: {}, fields: [
  { path: 'title', type: 'text', field: { name: 'title', type: 'text', localized: true }, ancestors: [] },
  { path: 'excerpt', type: 'textarea', field: { name: 'excerpt', type: 'textarea', localized: true }, ancestors: [] },
  { path: 'tags', type: 'relationship', field: { name: 'tags', type: 'relationship', relationTo: 'tags', localized: true, hasMany: true }, relation: { relationTo: 'tags', allowCreate: true }, ancestors: [] },
] }
const tags: EditorialRegistry = { collection: 'tags', exclude: ['content'], relations: { related: { relationTo: 'tags', allowCreate: true } }, fields: [
  { path: 'name', type: 'text', field: { name: 'name', type: 'text', localized: true }, ancestors: [] },
  { path: 'related', type: 'relationship', field: { name: 'related', type: 'relationship', relationTo: 'tags', localized: true }, relation: { relationTo: 'tags', allowCreate: true }, ancestors: [] },
] }
const sourceID = 'https://site.test/fr/post#article'
const sourceURL = 'https://site.test/fr/post'
const buildAppliedGraph = (args: AppliedGraphArgs) => buildGraph({ sourceURL, ...args })
const raw = () => ({ locale: 'fr', patches: [
  { path: 'title', operation: 'set', value: 'Titre' }, { path: 'excerpt', operation: 'set', value: 'Résumé' },
  { path: 'tags', operation: 'set', value: [{ localId: 'tag-1' }] },
], relatedDrafts: [{ collection: 'tags', localId: 'tag-1', locale: 'fr', fields: { name: 'Art' }, graphNodeId: 'draft:tag-1' }],
semanticGraph: { '@graph': [
  { '@id': sourceID, '@type': 'Article', headline: 'Titre', description: 'Résumé', about: { '@id': 'draft:tag-1' } },
  { '@id': 'draft:tag-1', '@type': 'Thing', name: 'Art' },
] }, graphBindings: [
  { path: 'title', nodeId: sourceID, properties: ['headline'] },
  { path: 'excerpt', nodeId: sourceID, properties: ['description'] },
  { path: 'tags', nodeId: sourceID, properties: ['about'] },
] })
const parsed = () => parseEditorialProposal(raw(), registry, 'fr', { posts: registry, tags }, sourceURL)

describe('editorial semantic graph reconciliation', () => {
  test('retains only selected properties and removes unselected drafts and edges', () => {
    expect(buildAppliedGraph({ proposal: parsed(), selectedPatches: ['title'], selectedDrafts: [] })).toEqual({
      '@context': 'https://schema.org', '@graph': [{ '@id': sourceID, '@type': 'Article', headline: 'Titre' }],
    })
  })

  test('resolves selected local IDs into public graph IDs without mutating the proposal', () => {
    const proposal = parsed()
    const graph = buildAppliedGraph({ proposal, selectedPatches: ['tags'], selectedDrafts: ['tag-1'], resolvedDrafts: { 'tag-1': 'https://site.test/fr/tags/23#thing' } })
    expect(graph).toEqual({ '@context': 'https://schema.org', '@graph': [
      { '@id': sourceID, '@type': 'Article', about: { '@id': 'https://site.test/fr/tags/23#thing' } },
      { '@id': 'https://site.test/fr/tags/23#thing', '@type': 'Thing', name: 'Art' },
    ] })
    expect(JSON.stringify(proposal)).toContain('draft:tag-1')
  })

  test('rejects unselected dependencies, unresolved drafts and unexpected selections', () => {
    const proposal = parsed()
    for (const args of [
      { selectedPatches: ['tags'], selectedDrafts: [] },
      { selectedPatches: ['tags'], selectedDrafts: ['tag-1'] },
      { selectedPatches: ['missing'], selectedDrafts: [] },
      { selectedPatches: ['content'], selectedDrafts: [] },
      { selectedPatches: ['title'], selectedDrafts: ['tag-1'], resolvedDrafts: { 'tag-1': 'https://site.test/tag' } },
      { selectedPatches: ['title', 'title'], selectedDrafts: [] },
    ]) expect(() => buildAppliedGraph({ proposal, ...args })).toThrow(/graph/i)
  })

  test('supports legacy editorial output without a semantic graph', () => {
    const proposal: EditorialProposalPayload = { locale: 'fr', patches: [], relatedDrafts: [] }
    expect(buildAppliedGraph({ proposal, selectedPatches: [], selectedDrafts: [] })).toEqual({ '@context': 'https://schema.org', '@graph': [] })
  })

  test('does not retain unselected helper nodes or dangling edges to them', () => {
    const value = raw()
    value.semanticGraph['@graph'].push({ '@id': 'https://site.test/person', '@type': 'Person', name: 'Auteur' } as never)
    Object.assign(value.semanticGraph['@graph'][0], { author: { '@id': 'https://site.test/person' } })
    value.graphBindings.push({ path: 'excerpt', nodeId: sourceID, properties: ['author'] }, { path: 'excerpt', nodeId: 'https://site.test/person', properties: ['name'] })
    const proposal = parseEditorialProposal(value, registry, 'fr', { tags }, sourceURL)
    expect(JSON.stringify(buildAppliedGraph({ proposal, selectedPatches: ['title'], selectedDrafts: [] }))).not.toContain('person')
    expect(buildAppliedGraph({ proposal, selectedPatches: ['excerpt'], selectedDrafts: [] })['@graph']).toHaveLength(2)
  })
})

describe('semantic graph validation before persistence', () => {
  test('canonicalizes one root context and returns a detached graph', () => {
    const value = raw()
    const proposal = parseEditorialProposal(value, registry, 'fr', { tags }, sourceURL)
    expect(proposal.semanticGraph?.['@context']).toBe('https://schema.org')
    value.semanticGraph['@graph'][0].headline = 'Changed'
    expect(proposal.semanticGraph?.['@graph'][0].headline).toBe('Titre')
  })

  test('rejects unbound or multiply bound properties and non-configured paths', () => {
    for (const mutate of [
      (value: ReturnType<typeof raw>) => { value.graphBindings = value.graphBindings.slice(1) },
      (value: ReturnType<typeof raw>) => { value.graphBindings.push(value.graphBindings[0]) },
      (value: ReturnType<typeof raw>) => { value.graphBindings[0].path = 'content' },
      (value: ReturnType<typeof raw>) => { value.graphBindings[0].properties = ['@id'] },
      (value: ReturnType<typeof raw>) => { value.graphBindings[0].properties = ['unknownSchemaProperty'] },
      (value: ReturnType<typeof raw>) => { value.graphBindings[0].nodeId = 'https://site.test/unknown' },
      (value: ReturnType<typeof raw>) => { delete (value as Partial<ReturnType<typeof raw>>).graphBindings },
    ]) {
      const value = raw(); mutate(value)
      expect(() => parseEditorialProposal(value, registry, 'fr', { tags }, sourceURL)).toThrow(/graph/i)
    }
  })

  test('rejects unsafe contexts, types, aliases, IDs, nested declarations and executable values', () => {
    for (const property of [
      { '@type': 'Product' }, { '@id': 'javascript:alert(1)' }, { '@id': 'https://user:secret@site.test/' },
      { '@context': 'https://foreign.test' }, { type: 'Article' }, { headline: '<script>bad</script>' },
      { headline: { '@graph': [{ '@type': 'Article' }] } }, { headline: { '@id': 'draft:unknown' } },
    ]) {
      const value = raw(); Object.assign(value.semanticGraph['@graph'][0], property)
      expect(() => parseEditorialProposal(value, registry, 'fr', { tags }, sourceURL)).toThrow()
    }
    for (const replacement of ['javascript:bad', 'https://user:secret@site.test', 'draft:unresolved', sourceID]) {
      expect(() => buildAppliedGraph({ proposal: parsed(), selectedPatches: ['tags'], selectedDrafts: ['tag-1'], resolvedDrafts: { 'tag-1': replacement } })).toThrow(/graph/i)
    }
  })

  test('rejects duplicate IDs, undeclared graph drafts and local graph cycles', () => {
    for (const mutate of [
      (value: ReturnType<typeof raw>) => { value.semanticGraph['@graph'].push(value.semanticGraph['@graph'][0]) },
      (value: ReturnType<typeof raw>) => { value.semanticGraph['@graph'][1]['@id'] = 'draft:missing' },
      (value: ReturnType<typeof raw>) => { Object.assign(value.semanticGraph['@graph'][1], { subjectOf: { '@id': sourceID } }) },
    ]) {
      const value = raw(); mutate(value)
      expect(() => parseEditorialProposal(value, registry, 'fr', { tags }, sourceURL)).toThrow(/graph/i)
    }
  })

  test('rejects connected cycles in related document local references without any semantic graph', () => {
    const value = raw()
    value.relatedDrafts[0].fields = { name: 'Art', related: { localId: 'tag-1' } } as never
    const { semanticGraph: _graph, graphBindings: _bindings, ...withoutGraph } = value
    expect(() => parseEditorialProposal(withoutGraph, registry, 'fr', { tags })).toThrow(/graph/i)
  })

  test('requires the trusted localized source URL for page graph nodes and matching source IDs', () => {
    for (const url of [undefined, 'javascript:bad', 'https://user:secret@site.test/', 'https://site.test/en/post']) {
      expect(() => parseEditorialProposal(raw(), registry, 'fr', { tags }, url)).toThrow(/graph/i)
      expect(() => buildAppliedGraph({ proposal: parsed(), selectedPatches: ['title'], selectedDrafts: [], sourceURL: url })).toThrow(/graph/i)
    }
    const value = raw()
    value.semanticGraph['@graph'][0]['@id'] = 'https://site.test/fr/other#article'
    expect(() => parseEditorialProposal(value, registry, 'fr', { tags }, sourceURL)).toThrow(/graph/i)
  })

  test('preserves non-page graph compatibility when no public source URL exists', () => {
    const proposal = parseEditorialProposal({ patches: [{ path: 'title', operation: 'set', value: 'Site' }],
      semanticGraph: { '@graph': [{ '@id': 'https://site.test/#organization', '@type': 'Organization', name: 'Site' }] },
      graphBindings: [{ path: 'title', nodeId: 'https://site.test/#organization', properties: ['name'] }],
    }, registry, 'fr')
    expect(buildAppliedGraph({ proposal, selectedPatches: ['title'], selectedDrafts: [], sourceURL: undefined })['@graph']).toHaveLength(1)
  })

  test('passes the trusted source URL through complete SEO parsing and preserves strict SEO checks', () => {
    const value = { meta: { title: 'Titre', description: 'Résumé' }, social: {}, schema: [], citability: { summary: '' }, editorial: raw() }
    const context = { registry, registries: { tags }, locale: 'fr' }
    expect(parseProposalOutput(value, { url: sourceURL, selectedMedia: [] }, context).editorial?.semanticGraph?.['@graph']).toHaveLength(2)
    expect(() => parseProposalOutput(value, { selectedMedia: [] }, context)).toThrow(/graph/i)
    expect(() => parseProposalOutput({ ...value, meta: { ...value.meta, title: 3 } }, { url: sourceURL, selectedMedia: [] }, context)).toThrow(/meta/i)
  })

  test('rejects excessive graph nesting before recursive JSON-LD validation', () => {
    const value = raw()
    let nested: unknown = 'Too deep'
    for (let depth = 0; depth < 40; depth++) nested = { name: nested }
    Object.assign(value.semanticGraph['@graph'][0], { headline: nested })
    expect(() => parseEditorialProposal(value, registry, 'fr', { tags }, sourceURL)).toThrow(/limit/i)
  })
})
