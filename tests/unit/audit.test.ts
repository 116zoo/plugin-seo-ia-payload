import { describe, expect, test } from 'vitest'

import { auditSeo } from '../../src/services/audit.js'

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
