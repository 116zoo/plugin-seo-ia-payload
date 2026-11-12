import { describe, expect, test } from 'vitest'

import type { GenerationInput } from '../../src/services/content.js'
import { parseProposalOutput, ProposalValidationError } from '../../src/services/validation.js'

const input: GenerationInput = {
  collection: 'posts', sourceID: '12', locale: 'fr', title: 'Bonjour', content: 'Texte',
  url: 'https://site.test/fr/x', fingerprint: 'fixture',
  site: { defaultLocale: 'fr', organization: { name: 'Site', url: 'https://site.test' } },
  selectedMedia: [{ id: 7, filename: 'photo.jpg' }],
}
const validOutput = () => ({
  meta: { title: 'Titre', description: 'Description', canonical: 'https://site.test/fr/x', robots: 'index,follow', focusKeyphrase: 'mot-clé' },
  social: { image: 7, imageAlt: 'Une photo', imageFilename: 'photo.jpg', imageCaption: 'Légende', recommendedWidth: 1200, recommendedHeight: 630, ogTitle: 'Titre OG', ogDescription: 'Description OG', twitterCard: 'summary_large_image' },
  schema: [{ '@context': 'https://schema.org', '@type': 'Article', headline: 'Titre', url: 'https://site.test/fr/x', author: { '@type': 'Person', name: 'Auteur' } }],
  citability: { summary: 'Résumé', sources: ['https://site.test/source'], claims: ['Fait', 'Fait'] },
})

describe('parseProposalOutput', () => {
  test('parses complete JSON proposals and deduplicates repeated structured values without mutation', () => {
    const value = validOutput()
    value.schema.push({ ...value.schema[0] })
    const original = structuredClone(value)
    const parsed = parseProposalOutput(JSON.stringify(value), input)
    expect(parsed.meta).toEqual(value.meta)
    expect(parsed.social).toEqual(value.social)
    expect(parsed.schema).toHaveLength(1)
    expect(parsed.citability).toEqual({ summary: 'Résumé', sources: ['https://site.test/source'], claims: ['Fait'] })
    expect(value).toEqual(original)
  })

  test('accepts exactly 2,000 characters and rejects 2,001 with safe field diagnostics', () => {
    const value = validOutput()
    value.citability.summary = 'x'.repeat(2000)
    expect(parseProposalOutput(value, input).citability.summary).toHaveLength(2000)
    value.citability.summary += 'x'
    expect(() => parseProposalOutput(value, input)).toThrow(/2000/)
    try {
      parseProposalOutput(value, input)
      expect.fail('Expected proposal validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ProposalValidationError)
      expect((error as ProposalValidationError).diagnostics).toContainEqual(expect.objectContaining({ path: 'citability.summary', code: expect.any(String), message: expect.stringMatching(/2000/) }))
      expect(JSON.stringify(error)).not.toContain('x'.repeat(2001))
    }
  })

  test.each(['not JSON', '```json\n{}\n```', null, [], 42])('rejects malformed proposals safely (%s)', (value) => {
    expect(() => parseProposalOutput(value, input)).toThrow(/proposal/i)
  })

  test.each(['meta', 'social', 'schema', 'citability'])('requires the generated %s group', (group) => {
    const value: Record<string, unknown> = validOutput()
    delete value[group]
    expect(() => parseProposalOutput(value, input)).toThrow(/proposal/i)
  })

  test.each([
    { meta: { title: 7, description: 'Description' } },
    { social: { recommendedWidth: 0 } },
    { social: { recommendedHeight: 1.5 } },
    { social: { twitterCard: 'invalid' } },
    { meta: { title: 'Titre', description: 'Description', slug: 'invented' } },
    { citability: { summary: 'Résumé', sources: ['not-a-url'] } },
  ])('strictly validates every generated group (%j)', (replacement) => {
    expect(() => parseProposalOutput({ ...validOutput(), ...replacement }, input)).toThrow(/proposal/i)
  })

  test('rejects images that the editor has not selected', () => {
    const value = validOutput()
    value.social.image = 99
    expect(() => parseProposalOutput(value, input)).toThrow(/social.image/)
    expect(() => parseProposalOutput(value, { ...input, selectedMedia: [] })).toThrow(/social.image/)
  })

  test.each(['javascript:alert(1)', '/relative', 'https://user:secret@site.test/x'])('rejects unsafe canonical and nested schema URLs (%s)', (url) => {
    expect(() => parseProposalOutput({ ...validOutput(), meta: { ...validOutput().meta, canonical: url } }, input)).toThrow(/meta.canonical/)
    expect(() => parseProposalOutput({ ...validOutput(), schema: [{ '@type': 'Article', author: { '@type': 'Person', url } }] }, input)).toThrow(/schema/)
  })

  test.each([
    { '@type': 'Product', name: 'Unsupported' },
    { '@type': ['Article', 'Product'] },
    { '@type': 'Article', author: { '@type': 'MaliciousType' } },
    { '@context': 'https://attacker.test/context', '@type': 'Article' },
    { '@type': 'Article', text: '</script><script>alert(1)</script>' },
    { '@type': 'Article', author: { '@id': 'javascript:alert(1)' } },
    { '@type': 'Article', unexpected: () => 'not JSON' },
    JSON.parse('{"@type":"Article","__proto__":{"polluted":true}}'),
  ])('rejects unsafe or unapproved JSON-LD (%j)', (graph) => {
    expect(() => parseProposalOutput({ ...validOutput(), schema: [graph] }, input)).toThrow(/schema/)
  })

  test.each([
    { '@context': 'https://schema.org', '@type': 'Article', type: 'Product', id: 'javascript:alert(1)' },
    { '@type': 'Article', type: 'Article' },
    { '@type': 'Article', id: 'https://site.test/fr/x' },
    { '@type': 'Article', author: { '@type': 'Person', type: 'Product' } },
    { '@type': 'Article', author: { '@type': 'Person', id: 'javascript:alert(1)' } },
    { '@context': 'https://schema.org', '@graph': [{ '@type': 'Article', author: { '@type': 'Person', type: 'Person', id: 'https://site.test/author' } }] },
  ])('rejects Schema.org keyword aliases consistently at root and nested depths (%j)', (graph) => {
    expect(() => parseProposalOutput({ ...validOutput(), schema: [graph] }, input)).toThrow(/schema/)
  })

  test.each([
    { '@context': 'https://schema.org', '@type': 'Organization', type: 'Article' },
    { '@type': 'Organization', subjectOf: { '@type': 'Organization', type: 'Article' } },
  ])('rejects aliased page types before no-public-URL filtering (%j)', (graph) => {
    expect(() => parseProposalOutput({ ...validOutput(), schema: [graph] }, { ...input, url: undefined })).toThrow(/schema/)
  })

  test('accepts each allowed root schema type and safe graph containers', () => {
    for (const type of ['WebPage', 'Article', 'BlogPosting', 'BreadcrumbList', 'Organization', 'WebSite', 'FAQPage']) {
      expect(parseProposalOutput({ ...validOutput(), schema: [{ '@context': 'https://schema.org', '@type': type }] }, input).schema).toHaveLength(1)
    }
    const schema = [{ '@context': 'https://schema.org', '@graph': [{ '@type': 'Article', url: input.url }, { '@type': 'Organization', url: 'https://site.test' }] }]
    expect(parseProposalOutput({ ...validOutput(), schema }, input).schema).toEqual(schema)
  })

  test('omits canonical and page URL-required schema without inventing a public URL', () => {
    const schema = [
      { '@type': 'Article', url: 'https://invented.test/article' },
      { '@type': 'WebPage' },
      { '@type': 'Organization', url: 'https://site.test' },
      { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite' }, { '@type': 'Organization', name: 'Site' }] },
    ]
    const value = { ...validOutput(), schema }
    const parsed = parseProposalOutput(value, { ...input, url: undefined })
    expect(parsed.meta.canonical).toBeUndefined()
    expect(parsed.schema).toEqual([
      { '@type': 'Organization', url: 'https://site.test' },
      { '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization', name: 'Site' }] },
    ])
    expect(value.meta.canonical).toBe('https://site.test/fr/x')
  })

  test('also accepts a complete proposal without canonical or schema when no public URL exists', () => {
    const value = validOutput()
    const { canonical: _, ...meta } = value.meta
    const parsed = parseProposalOutput({ ...value, meta, schema: [] }, { ...input, url: undefined })
    expect(parsed.meta.canonical).toBeUndefined()
    expect(parsed.schema).toEqual([])
  })

  test('removes nested page schema when the host cannot resolve a public URL', () => {
    const schema = [{ '@type': 'Organization', name: 'Site', subjectOf: { '@type': 'Article', url: 'https://invented.test/page' } }]
    expect(parseProposalOutput({ ...validOutput(), schema }, { ...input, url: undefined }).schema).toEqual([{ '@type': 'Organization', name: 'Site' }])
  })

  test.each([
    { '@type': 'Article', url: 12 },
    { '@type': 'Article', sameAs: [false] },
    { '@type': 'Article', '@id': { url: 'https://site.test' } },
    { '@type': ['Article', 12] },
    { '@graph': [] },
  ])('rejects malformed JSON-LD structural and URL values (%j)', (graph) => {
    expect(() => parseProposalOutput({ ...validOutput(), schema: [graph] }, input)).toThrow(/schema/)
  })

  test('deduplicates graphs regardless of object key order', () => {
    const schema = [{ '@type': 'Organization', name: 'Site' }, { name: 'Site', '@type': 'Organization' }]
    expect(parseProposalOutput({ ...validOutput(), schema }, input).schema).toHaveLength(1)
  })

  test('rejects cycles with safe diagnostics rather than recursing indefinitely', () => {
    const graph: Record<string, unknown> = { '@type': 'Article' }
    graph.author = graph
    expect(() => parseProposalOutput({ ...validOutput(), schema: [graph] }, input)).toThrow(/proposal/i)
  })
})
