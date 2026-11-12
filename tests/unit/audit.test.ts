import { describe, expect, test } from 'vitest'

import { auditSeo } from '../../src/services/audit.js'
import { parseEditorialProposal } from '../../src/services/editorialValidation.js'
import { buildAppliedGraph } from '../../src/services/graph.js'
import type { EditorialRegistry } from '../../src/types.js'

const approved = {
  meta: { title: 'Titre approuvé', description: 'Description approuvée', canonical: 'https://site.test/fr/article' },
  social: { image: 7, imageAlt: 'Photo approuvée', ogTitle: 'Titre social', ogDescription: 'Description sociale' },
  schema: [{ '@context': 'https://schema.org', '@type': 'Article' }],
  citability: { summary: 'Résumé approuvé' },
}

describe('auditSeo', () => {
  test('scores only approved SEO in the requested locale and reports actionable missing fields', () => {
    const doc = {
      title: 'Source title', description: 'Source description',
      seo: { fr: { meta: { title: 'Titre approuvé' } }, en: approved },
      proposals: [{ locale: 'fr', state: 'draft', output: approved }],
    }
    const before = structuredClone(doc)
    const audit = auditSeo(doc, 'fr')
    expect(audit).toMatchObject({ locale: 'fr', score: expect.any(Number), completeness: 'incomplete', missing: expect.arrayContaining(['meta.description', 'citability.summary']) })
    expect(audit.score).toBeLessThan(100)
    expect(audit.recommendations).toContainEqual(expect.objectContaining({ path: 'meta.description', code: 'missing', message: expect.any(String) }))
    expect(doc).toEqual(before)
    expect(auditSeo(doc, 'en')).toMatchObject({ score: 100, missing: [], invalid: [], completeness: 'complete' })
  })

  test('audits a locale-loaded Payload document with null optional fields and a populated image', () => {
    const seo = {
      ...approved,
      meta: { ...approved.meta, robots: null, focusKeyphrase: null },
      social: { ...approved.social, image: { id: 7, filename: 'photo.jpg', private: 'ignore' }, imageCaption: null, recommendedWidth: null },
      citability: { ...approved.citability, sources: null, claims: null },
      status: { completeness: 'incomplete', warnings: ['Old warning'] },
    }
    expect(auditSeo({ seo }, 'fr')).toMatchObject({ score: 100, completeness: 'complete', missing: [], invalid: [] })
  })

  test('audits an applied editorial graph with supporting Schema.org nodes', () => {
    const registry: EditorialRegistry = { collection: 'posts', exclude: ['content'], relations: {}, fields: [
      { path: 'title', type: 'text', field: { name: 'title', type: 'text', localized: true }, ancestors: [] },
    ] }
    const sourceURL = 'https://site.test/fr/article'
    const articleID = `${sourceURL}#article`
    const personID = 'https://site.test/authors/7'
    const imageID = 'https://site.test/media/7'
    const thingID = 'https://site.test/topics/art'
    const proposal = parseEditorialProposal({
      locale: 'fr', patches: [{ path: 'title', operation: 'set', value: 'Titre approuvé' }], relatedDrafts: [],
      semanticGraph: { '@graph': [
        { '@id': articleID, '@type': 'Article', headline: 'Titre approuvé', author: { '@id': personID }, image: { '@id': imageID }, about: { '@id': thingID } },
        { '@id': personID, '@type': 'Person', name: 'Auteur' },
        { '@id': imageID, '@type': 'ImageObject', contentUrl: 'https://site.test/photo.jpg' },
        { '@id': thingID, '@type': 'Thing', name: 'Art' },
      ] },
      graphBindings: [
        { path: 'title', nodeId: articleID, properties: ['headline', 'author', 'image', 'about'] },
        { path: 'title', nodeId: personID, properties: ['name'] },
        { path: 'title', nodeId: imageID, properties: ['contentUrl'] },
        { path: 'title', nodeId: thingID, properties: ['name'] },
      ],
    }, registry, 'fr', undefined, sourceURL)
    const graph = buildAppliedGraph({ proposal, selectedPatches: ['title'], selectedDrafts: [], sourceURL, registry })
    expect(graph['@graph']).toHaveLength(4)
    expect(auditSeo({ seo: { ...approved, schema: [graph] } }, 'fr')).toMatchObject({
      score: 100, completeness: 'complete', missing: [], invalid: [],
    })
  })

  test('never falls back to another locale and gives absent approved SEO a zero score', () => {
    for (const doc of [{}, { seo: { en: approved } }, { seo: null }]) {
      expect(auditSeo(doc, 'fr')).toMatchObject({ score: 0, completeness: 'incomplete', missing: expect.arrayContaining(['meta.title', 'schema', 'citability.summary']) })
    }
    for (const locale of ['', 'all', '*']) expect(() => auditSeo({}, locale)).toThrow(/locale/i)
  })

  test.each([
    ['meta.canonical', { ...approved, meta: { ...approved.meta, canonical: 'javascript:alert(1)' } }],
    ['social.recommendedWidth', { ...approved, social: { ...approved.social, recommendedWidth: -1 } }],
    ['schema', { ...approved, schema: [{ '@type': 'Article', url: 'javascript:alert(1)' }] }],
    ['citability.summary', { ...approved, citability: { summary: 'x'.repeat(2001) } }],
  ])('reports concrete invalid approved values at %s', (path, seo) => {
    const audit = auditSeo({ seo }, 'fr')
    expect(audit.invalid).toContainEqual(expect.objectContaining({ path: expect.stringContaining(path), message: expect.any(String) }))
    expect(audit.recommendations).toContainEqual(expect.objectContaining({ path: expect.stringContaining(path), message: expect.stringContaining('Correct approved') }))
    expect(audit.completeness).toBe('incomplete')
    expect(audit.score).toBeLessThan(100)
    expect(audit.score).toBeGreaterThanOrEqual(0)
  })

  test('reports whitespace-only required values as missing', () => {
    const seo = { ...approved, meta: { ...approved.meta, description: '   ' }, citability: { summary: '\n' } }
    expect(auditSeo({ seo }, 'fr').missing).toEqual(['meta.description', 'citability.summary'])
  })
})
