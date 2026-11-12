import type { Field, PayloadRequest } from 'payload'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createNimClient } from '../../src/services/nim.js'
import { createProposal } from '../../src/services/proposals.js'
import { parseProposalOutput } from '../../src/services/validation.js'
import type { GenerationInput } from '../../src/services/content.js'
import { parseEditorialProposal } from '../../src/services/editorialValidation.js'
import type { EditorialField, EditorialRegistry, ValidatedPluginOptions } from '../../src/types.js'

const descriptor = (path: string, field: Field): EditorialField => ({ path, type: field.type as EditorialField['type'], field, ancestors: [] })
const title = descriptor('title', { name: 'title', type: 'text', localized: true, required: true, maxLength: 50 })
const registry: EditorialRegistry = { collection: 'posts', exclude: ['content'], relations: {
  tags: { relationTo: 'tags', allowCreate: true }, image: { relationTo: 'media', allowCreate: false },
}, fields: [title,
  descriptor('count', { name: 'count', type: 'number', min: 0, max: 10 }),
  descriptor('enabled', { name: 'enabled', type: 'checkbox' }),
  descriptor('date', { name: 'date', type: 'date' }),
  descriptor('choices', { name: 'choices', type: 'select', hasMany: true, options: ['one', 'two'] }),
  { ...descriptor('tags', { name: 'tags', type: 'relationship', relationTo: 'tags', hasMany: true }), relation: { relationTo: 'tags', allowCreate: true } },
  { ...descriptor('image', { name: 'image', type: 'upload', relationTo: 'media' }), relation: { relationTo: 'media', allowCreate: false } },
] }
const tags: EditorialRegistry = { collection: 'tags', fields: [{ ...title, path: 'name', field: { name: 'name', type: 'text', required: true } }], exclude: ['content'], relations: {} }
const caches = { posts: registry, tags }
const valid = () => ({ locale: 'fr', patches: [{ path: 'title', operation: 'set', value: 'Titre' }, { path: 'tags', operation: 'set', value: [{ localId: 'tag-1' }] }], relatedDrafts: [{ collection: 'tags', localId: 'tag-1', locale: 'fr', fields: { name: 'Art' }, graphNodeId: 'draft:tag-1' }] })

describe('parseEditorialProposal', () => {
  test('validates patches and declared drafts without retaining caller references', () => {
    const input = valid()
    const parsed = parseEditorialProposal(input, registry, 'fr', caches)
    expect(parsed.patches).toHaveLength(2)
    expect(parsed.relatedDrafts).toHaveLength(1)
    input.relatedDrafts[0].fields.name = 'Changed'
    expect(parsed.relatedDrafts[0].fields.name).toBe('Art')
  })

  test.each(['content', 'nested.content', 'slug', 'missing', 'title.fr', 'title.0', '__proto__'])('rejects content and undeclared paths (%s)', (path) => {
    expect(() => parseEditorialProposal({ patches: [{ path, operation: 'set', value: 'x' }] }, registry, 'fr')).toThrow(/content|path/i)
  })

  test.each([
    { path: 'title', operation: 'remove', value: 'x' },
    { path: 'title', operation: 'set', value: { fr: 'Titre', en: 'Title' } },
    { path: 'title', operation: 'set', value: null },
    { path: 'title', operation: 'set', value: '<script>x</script>' },
    { path: 'count', operation: 'set', value: '3' },
    { path: 'count', operation: 'set', value: 11 },
    { path: 'enabled', operation: 'set', value: 1 },
    { path: 'date', operation: 'set', value: 'tomorrow' },
    { path: 'choices', operation: 'set', value: ['three'] },
    { path: 'choices', operation: 'set', value: 'one' },
    { path: 'image', operation: 'set', value: { id: 1, private: 'populated' } },
  ])('rejects invalid operations and values without coercion (%j)', (patch) => {
    expect(() => parseEditorialProposal({ patches: [patch] }, registry, 'fr')).toThrow()
  })

  test('accepts compatible scalar, select and existing relation values', () => {
    const patches = [['title', 'Titre'], ['count', 3], ['enabled', false], ['date', '2026-11-12T10:00:00.000Z'], ['choices', ['one']], ['tags', [12, 'tag-id']], ['image', 7]].map(([path, value]) => ({ path, value, operation: 'set' }))
    expect(parseEditorialProposal({ patches }, registry, 'fr').patches).toHaveLength(7)
  })

  test('rejects cross-locale envelopes, patches and drafts, including missing draft locale', () => {
    for (const output of [ { ...valid(), locale: 'en' }, { ...valid(), patches: [{ path: 'title', operation: 'set', value: 'Title', locale: 'en' }] }, { ...valid(), relatedDrafts: [{ ...valid().relatedDrafts[0], locale: 'en' }] }, { ...valid(), relatedDrafts: [{ ...valid().relatedDrafts[0], locale: null }] } ]) {
      expect(() => parseEditorialProposal(output, registry, 'fr', caches)).toThrow(/locale/i)
    }
  })

  test('rejects draft collection policy bypass, forbidden draft fields, and undeclared targets', () => {
    for (const draft of [ { ...valid().relatedDrafts[0], collection: 'media' }, { ...valid().relatedDrafts[0], fields: { content: 'forbidden' } }, { ...valid().relatedDrafts[0], fields: { name: 4 } }, { ...valid().relatedDrafts[0], fields: { name: 'Art', slug: 'art' } } ]) {
      expect(() => parseEditorialProposal({ ...valid(), relatedDrafts: [draft] }, registry, 'fr', caches)).toThrow()
    }
    expect(() => parseEditorialProposal(valid(), registry, 'fr')).toThrow(/registry/i)
  })

  test('rejects duplicate, unresolved, cross-collection or malformed local identifiers', () => {
    for (const output of [ { ...valid(), relatedDrafts: [...valid().relatedDrafts, ...valid().relatedDrafts] }, { ...valid(), relatedDrafts: [] }, { ...valid(), relatedDrafts: [{ ...valid().relatedDrafts[0], graphNodeId: 'https://wrong.test' }] }, { ...valid(), relatedDrafts: [{ ...valid().relatedDrafts[0], localId: '../tag' }] }, { ...valid(), patches: [{ path: 'image', operation: 'set', value: { localId: 'tag-1' } }] } ]) {
      expect(() => parseEditorialProposal(output, registry, 'fr', caches)).toThrow()
    }
  })

  test('rejects duplicate or overlapping patches and unexpected metadata', () => {
    const patch = { path: 'title', operation: 'set', value: 'Titre' }
    for (const output of [{ patches: [patch, patch] }, { patches: [{ ...patch, _status: 'published' }] }, { patches: [patch], content: 'x' }]) expect(() => parseEditorialProposal(output, registry, 'fr')).toThrow()
  })
})

const singleField = (field: EditorialField): EditorialRegistry => ({ collection: 'posts', fields: [field], relations: {}, exclude: ['content'] })
const onePatch = (path: string, value: unknown) => ({ patches: [{ path, operation: 'set', value }] })

describe('Payload container and rich-text adapters', () => {
  test('validates nested groups, arrays and blocks and rejects unknown or technical row fields', () => {
    const question = descriptor('faq.question', { name: 'question', type: 'text', required: true })
    const faq = { ...descriptor('faq', { name: 'faq', type: 'array', fields: [question.field], maxRows: 2 }), children: [question] }
    expect(parseEditorialProposal(onePatch('faq', [{ question: 'Why?' }]), singleField(faq), 'fr').patches).toHaveLength(1)
    for (const value of [[{ content: 'forbidden' }], [{ question: 12 }], [{ question: 'Q', id: 'invented' }], [{ question: { en: 'Cross locale' } }]]) {
      expect(() => parseEditorialProposal(onePatch('faq', value), singleField(faq), 'fr')).toThrow()
    }
    const label = descriptor('cta.label', { name: 'label', type: 'text' })
    const group = { ...descriptor('cta', { name: 'cta', type: 'group', fields: [label.field] }), children: [label] }
    expect(parseEditorialProposal(onePatch('cta', { label: 'Contact' }), singleField(group), 'fr').patches).toHaveLength(1)
    const heading = descriptor('layout.hero.heading', { name: 'heading', type: 'text' })
    const blocks = { ...descriptor('layout', { name: 'layout', type: 'blocks', blocks: [{ slug: 'hero', fields: [heading.field] }] }), children: [heading] }
    expect(parseEditorialProposal(onePatch('layout', [{ blockType: 'hero', heading: 'Hello' }]), singleField(blocks), 'fr').patches).toHaveLength(1)
    expect(() => parseEditorialProposal(onePatch('layout', [{ blockType: 'unknown', heading: 'Hello' }]), singleField(blocks), 'fr')).toThrow()
  })

  test('supports hasMany text and number fields and enforces their row/value limits', () => {
    for (const field of [descriptor('values', { name: 'values', type: 'text', hasMany: true, minRows: 1, maxRows: 2 }), descriptor('values', { name: 'values', type: 'number', hasMany: true, min: 0, max: 5, minRows: 1, maxRows: 2 })]) {
      const valid = field.type === 'text' ? ['one', 'two'] : [1, 2]
      expect(parseEditorialProposal(onePatch('values', valid), singleField(field), 'fr').patches).toHaveLength(1)
      for (const value of [[], [...valid, ...valid], field.type === 'text' ? [3] : ['3'], field.type === 'text' ? [{ fr: 'x' }] : [6]]) {
        expect(() => parseEditorialProposal(onePatch('values', value), singleField(field), 'fr')).toThrow()
      }
    }
  })

  test('accepts inert Lexical rich text and rejects links, scripts, custom nodes and malformed roots', () => {
    const rich = singleField(descriptor('intro', { name: 'intro', type: 'richText' }))
    const node = { root: { type: 'root', version: 1, children: [{ type: 'paragraph', version: 1, children: [{ type: 'text', text: 'Safe introduction', version: 1 }] }] } }
    expect(parseEditorialProposal(onePatch('intro', node), rich, 'fr').patches).toHaveLength(1)
    for (const value of ['<p>HTML</p>', { root: { type: 'root', version: 1, children: [{ type: 'link', url: 'javascript:alert(1)', version: 1 }] } }, { root: { type: 'root', version: 1, children: [{ type: 'text', text: '<script>x</script>', version: 1 }] } }, { root: { type: 'root', version: 1, children: [{ type: 'heading', tag: 'script', version: 1, children: [] }] } }]) {
      expect(() => parseEditorialProposal(onePatch('intro', value), rich, 'fr')).toThrow()
    }
  })

  test('rejects cycles, excessive trees, non-JSON values and prototype pollution safely', () => {
    const cycle: Record<string, unknown> = {}
    cycle.value = cycle
    for (const value of [cycle, () => 'x', Infinity, new Date(), JSON.parse('{"__proto__":{"polluted":true}}')]) {
      expect(() => parseEditorialProposal(onePatch('title', value), registry, 'fr')).toThrow()
    }
    let deep: unknown = 'x'
    for (let index = 0; index < 40; index++) deep = [deep]
    expect(() => parseEditorialProposal(onePatch('title', deep), registry, 'fr')).toThrow(/limit/)
    expect(() => parseEditorialProposal(onePatch('date', '2026-02-31T10:00:00Z'), registry, 'fr')).toThrow()
  })

  test('checks polymorphic relation collection and local references', () => {
    const relation = { ...descriptor('related', { name: 'related', type: 'relationship', relationTo: ['tags', 'media'] }), relation: { relationTo: ['tags', 'media'], allowCreate: true } }
    const poly = singleField(relation)
    expect(parseEditorialProposal(onePatch('related', { relationTo: 'tags', value: 3 }), poly, 'fr').patches).toHaveLength(1)
    expect(parseEditorialProposal({ ...valid(), patches: [{ path: 'related', operation: 'set', value: { relationTo: 'tags', value: { localId: 'tag-1' } } }] }, poly, 'fr', caches).relatedDrafts).toHaveLength(1)
    for (const value of [3, { relationTo: 'users', value: 3 }, { relationTo: 'media', value: { localId: 'tag-1' } }]) {
      expect(() => parseEditorialProposal({ ...valid(), patches: [{ path: 'related', operation: 'set', value }] }, poly, 'fr', caches)).toThrow()
    }
  })
})


const seo = () => ({ meta: { title: 'Titre', description: 'Description' }, social: {}, schema: [], citability: { summary: 'Résumé' } })
const generationInput: GenerationInput = { collection: 'posts', sourceID: '1', locale: 'fr', title: 'Titre', content: 'Source', fingerprint: 'fixture', selectedMedia: [], site: { defaultLocale: 'fr', organization: { name: 'Site', url: 'https://site.test' } } }
const context = { registry, registries: caches, locale: 'fr' }
afterEach(() => vi.unstubAllGlobals())

describe('SEO validation and persistence integration', () => {
  test('requires trusted registry context for editorial output without relaxing SEO schemas', () => {
    const output = { ...seo(), editorial: valid() }
    expect(parseProposalOutput(output, generationInput, context).editorial?.patches).toHaveLength(2)
    expect(() => parseProposalOutput(output, generationInput)).toThrow()
    expect(() => parseProposalOutput({ ...output, meta: { title: 12, description: 'Description' } }, generationInput, context)).toThrow(/meta/)
    expect(() => parseProposalOutput({ ...output, schema: [{ '@type': 'Product' }] }, generationInput, context)).toThrow(/schema/)
    expect(() => parseProposalOutput(output, generationInput, { ...context, locale: 'en' })).toThrow(/locale/)
    expect(parseProposalOutput(seo(), generationInput)).not.toHaveProperty('editorial')
  })

  test('default NIM transport validates optional editorial output using trusted cached context', async () => {
    const output = { ...seo(), editorial: valid() }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }))))
    const nim = { baseURL: 'https://nim.test/v1', apiKey: 'fixture', model: 'fixture' }
    expect((await createNimClient(nim, context).generate(generationInput)).output.editorial?.patches).toHaveLength(2)
    await expect(createNimClient(nim).generate(generationInput)).rejects.toMatchObject({ code: 'invalid_output' })
  })

  test('persistence revalidates custom transport output and stores safe errors for forbidden values', async () => {
    const create = vi.fn(async ({ data }: { data: unknown }) => ({ id: 1, ...data as object }))
    const req = { user: { collection: 'users', id: 1 }, payload: { create } } as unknown as PayloadRequest
    const options: ValidatedPluginOptions = {
      collections: { posts: { titleField: 'title', localizedSourceFields: ['title', 'content'], mediaCollection: 'media', editorialFields: { include: ['title', 'tags'] }, extractContent: () => 'Source', resolveURL: () => null } },
      editorialRegistries: caches, locales: ['fr', 'en'], bulk: false,
      nim: { baseURL: 'https://nim.test/v1', apiKey: 'fixture', model: 'fixture' }, site: generationInput.site,
      permissions: { generate: () => true, apply: () => true, manage: () => true },
    }
    const args = { options, req, collection: 'posts', locale: 'fr', doc: { id: 1, title: 'Titre' }, client: { generate: async () => ({ output: { ...seo(), editorial: valid() } as never }) } }
    expect(await createProposal(args)).toMatchObject({ state: 'draft', output: { editorial: { locale: 'fr' } } })
    args.client.generate = async () => ({ output: { ...seo(), editorial: { patches: [{ path: 'content', operation: 'set', value: 'secret-model-body' }] } } as never })
    const failed = await createProposal(args)
    expect(failed).toMatchObject({ state: 'failed', errors: [expect.objectContaining({ code: 'invalid_editorial' })] })
    expect(failed.output).toBeUndefined()
    expect(JSON.stringify(failed)).not.toContain('secret-model-body')
    expect(create).toHaveBeenCalledTimes(2)
  })
})
