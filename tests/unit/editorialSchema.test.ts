import type { Config, Field } from 'payload'
import { describe, expect, test } from 'vitest'

import { validatePluginOptions } from '../../src/plugin.js'
import { resolveEditorialRegistry } from '../../src/services/editorialSchema.js'
import type { EditorialFieldOptions, NimSeoPluginOptions } from '../../src/types.js'

const fixture = (editorialFields: EditorialFieldOptions = { include: ['title'] }) => {
  const options: NimSeoPluginOptions = {
    collections: { posts: {
      titleField: 'title', localizedSourceFields: ['title', 'content'], editorialFields,
      extractContent: () => '', resolveURL: () => null, mediaCollection: 'media',
    }, tags: {
      titleField: 'name', localizedSourceFields: ['name'],
      editorialFields: { include: ['name'] },
      extractContent: () => '', resolveURL: () => null, mediaCollection: 'media',
    } },
    locales: ['fr', 'en'], nim: { baseURL: 'https://example.test/v1', apiKey: 'fixture', model: 'fixture' },
    site: { defaultLocale: 'fr', organization: { name: 'Fixture', url: 'https://example.test' } },
    permissions: { generate: () => true, apply: () => true, manage: () => true },
  }
  const config: Config = {
    secret: 'fixture', db: {} as Config['db'], localization: { locales: ['fr', 'en'], defaultLocale: 'fr' },
    blocks: [{ slug: 'shared', fields: [{ name: 'heading', type: 'text', localized: true }] }],
    collections: [{ slug: 'posts', fields: [
      { name: 'title', type: 'text', localized: true },
      { name: 'content', type: 'textarea', localized: true },
      { name: 'slug', type: 'text', localized: true },
      { name: 'shared', type: 'text' },
      { name: 'faq', type: 'array', localized: true, fields: [
        { name: 'question', type: 'text', localized: true }, { name: 'answer', type: 'textarea' },
      ] },
      { name: 'cta', type: 'group', localized: true, fields: [{ name: 'label', type: 'text', localized: true }] },
      { type: 'tabs', tabs: [
        { label: 'Unnamed', fields: [{ type: 'row', fields: [{ type: 'collapsible', label: 'Details', fields: [{ name: 'intro', type: 'textarea', localized: true }] }] }] },
        { name: 'details', localized: true, fields: [{ name: 'subtitle', type: 'text', localized: true }] },
      ] },
      { name: 'layout', type: 'blocks', localized: true, blocks: [{ slug: 'hero', fields: [{ name: 'heading', type: 'text', localized: true }] }] },
      { name: 'referenced', type: 'blocks', blocks: [], blockReferences: ['shared'] },
      { name: 'tags', type: 'relationship', relationTo: 'tags', hasMany: true, localized: true },
      { name: 'image', type: 'upload', relationTo: 'media', localized: true },
    ] }, { slug: 'tags', fields: [{ name: 'name', type: 'text', localized: true }] }, { slug: 'media', upload: true, fields: [] }],
  }
  return { options, config, resolve: () => resolveEditorialRegistry(options, 'posts', config) }
}

describe('editorial field registry', () => {
  test('resolves explicit nested paths and layout wrappers without mutating config', () => {
    const f = fixture({ include: ['title', 'faq.question', 'cta.label', 'intro', 'details.subtitle', 'layout.hero.heading', 'referenced.shared.heading'] })
    const before = JSON.stringify(f.config)
    const registry = f.resolve()
    expect(registry.collection).toBe('posts')
    expect(registry.fields).toContainEqual(expect.objectContaining({ path: 'faq.question', type: 'text', ancestors: [expect.objectContaining({ path: 'faq', type: 'array' })] }))
    expect(registry.fields.map(({ path }) => path)).toEqual(f.options.collections.posts.editorialFields!.include)
    expect(JSON.stringify(f.config)).toBe(before)
  })

  test('supports localized whole containers with validated child descriptors', () => {
    const { resolve } = fixture({ include: ['faq', 'cta', 'details', 'layout'] })
    expect(resolve().fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'faq', type: 'array', children: [expect.objectContaining({ path: 'faq.question' }), expect.objectContaining({ path: 'faq.answer' })] }),
      expect.objectContaining({ path: 'details', type: 'group' }),
      expect.objectContaining({ path: 'layout', children: [expect.objectContaining({ path: 'layout.hero.heading' })] }),
    ]))
  })

  test.each(['content', 'faq.content', 'slug', 'seo', '_status', 'id', 'createdAt', 'updatedAt', 'roles', 'permissions', 'password', 'author', 'payment', '__proto__'])('rejects forbidden path %s even when explicitly included', (path) => {
    const f = fixture({ include: [path] })
    expect(f.resolve).toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  })

  test('rejects forbidden children through a whole-container include', () => {
    const f = fixture({ include: ['cta'] })
    ;(f.config.collections![0].fields.find((field) => 'name' in field && field.name === 'cta') as Extract<Field, { type: 'group' }>).fields.push({ name: 'content', type: 'text' })
    expect(f.resolve).toThrow(/cta.content/i)
  })

  test.each(['missing', 'faq.missing', 'layout.heading', 'layout.other.heading', 'faq.0.question'])('rejects unknown or document-index paths: %s', (path) => {
    expect(fixture({ include: [path] }).resolve).toThrow(/exist|path/i)
  })

  test('requires explicit localization on the selected path', () => {
    expect(fixture({ include: ['shared'] }).resolve).toThrow(/shared.*localized/i)
    expect(fixture({ include: ['faq.answer'] }).resolve).toThrow(/faq.answer.*localized/i)
  })

  test('applies exclusions to explicitly included fields and descendants', () => {
    expect(fixture({ include: ['title', 'faq.question'], exclude: ['content', 'faq'] }).resolve().fields.map(({ path }) => path)).toEqual(['title'])
    expect(fixture({ include: ['faq'], exclude: ['faq.answer'] }).resolve).toThrow(/exclude|overlap/i)
    expect(fixture({ include: ['title'], exclude: ['typo'] }).resolve).toThrow(/typo.*exist/i)
  })

  test.each([[''], ['title', 'title'], ['faq', 'faq.question'], [' title'], ['faq..question']].map((include) => ({ include })))('rejects malformed, duplicate or overlapping includes: $include', ({ include }) => {
    expect(fixture({ include }).resolve).toThrow(/path|duplicate|overlap/i)
  })

  test('requires and resolves matching explicit relation policies', () => {
    expect(fixture({ include: ['tags'] }).resolve).toThrow(/tags.*relation/i)
    const { resolve } = fixture({ include: ['tags', 'image'], relations: {
      tags: { relationTo: 'tags', allowCreate: true }, image: { relationTo: 'media', allowCreate: false },
    } })
    expect(resolve().fields).toContainEqual(expect.objectContaining({ path: 'tags', relation: { relationTo: 'tags', allowCreate: true } }))
    expect(resolve().relations.tags.allowCreate).toBe(true)
  })

  test('rejects a relation policy on scalar, undeclared or mismatched targets', () => {
    expect(fixture({ include: ['title'], relations: { title: { relationTo: 'tags', allowCreate: false } } }).resolve).toThrow(/title.*relation/i)
    expect(fixture({ include: ['title'], relations: { tags: { relationTo: 'tags', allowCreate: false } } }).resolve).toThrow(/tags.*include/i)
    expect(fixture({ include: ['tags'], relations: { tags: { relationTo: 'media', allowCreate: false } } }).resolve).toThrow(/tags.*relationTo/i)
  })

  test('creation requires an existing target with its own editorial registry', () => {
    const f = fixture({ include: ['tags'], relations: { tags: { relationTo: 'tags', allowCreate: true } } })
    delete f.options.collections.tags.editorialFields
    expect(f.resolve).toThrow(/tags.*editorialFields/i)
    const missing = fixture({ include: ['tags'], relations: { tags: { relationTo: 'tags', allowCreate: false } } })
    missing.config.collections = missing.config.collections!.filter(({ slug }) => slug !== 'tags')
    expect(missing.resolve).toThrow(/tags.*exist/i)
  })

  test('rejects unsupported field adapters and non-explicit creation policy', () => {
    const f = fixture({ include: ['code'] })
    f.config.collections![0].fields.push({ name: 'code', type: 'code', localized: true })
    expect(f.resolve).toThrow(/code.*type/i)
    const relation = fixture({ include: ['tags'], relations: { tags: { relationTo: 'tags' } as never } })
    expect(relation.resolve).toThrow(/allowCreate/i)
  })

  test('rejects null option maps rather than silently enabling defaults', () => {
    expect(fixture({ include: ['title'], exclude: null as never }).resolve).toThrow(/exclude/i)
    expect(fixture({ include: ['title'], relations: null as never }).resolve).toThrow(/relations/i)
  })

  test('rejects hidden and read-only containers even when only a child is selected', () => {
    for (const admin of [{ hidden: true }, { readOnly: true }]) {
      const f = fixture({ include: ['cta.label'] })
      const group = f.config.collections![0].fields.find((field) => 'name' in field && field.name === 'cta')!
      group.admin = admin
      expect(f.resolve).toThrow(/cta.*hidden|cta.*read-only/i)
    }
  })

  test('rejects FieldBase.hidden on fields and named ancestor groups', () => {
    const direct = fixture({ include: ['title'] })
    Object.assign(direct.config.collections![0].fields[0], { hidden: true })
    expect(direct.resolve).toThrow(/title.*hidden/i)
    const nested = fixture({ include: ['cta.label'] })
    Object.assign(nested.config.collections![0].fields.find((field) => 'name' in field && field.name === 'cta')!, { hidden: true })
    expect(nested.resolve).toThrow(/cta.*hidden/i)
  })

  test.each([{ hidden: true }, { virtual: true }, { virtual: 'other.title' }])('preserves named tab restrictions: %j', (restriction) => {
    for (const path of ['details', 'details.subtitle']) {
      const f = fixture({ include: [path] })
      const tabs = f.config.collections![0].fields.find((field) => field.type === 'tabs')! as Extract<Field, { type: 'tabs' }>
      Object.assign(tabs.tabs[1], restriction)
      expect(f.resolve).toThrow(/details.*hidden|details.*virtual/i)
    }
  })

  test.each(['tabs', 'unnamed tab', 'row', 'collapsible', 'unnamed group'])('propagates restrictions of %s without adding path segments', (wrapper) => {
    for (const restriction of [{ hidden: true }, { admin: { hidden: true } }, { admin: { readOnly: true } }]) {
      const f = fixture({ include: ['wrapped.heading'] })
      const children: Field[] = [{ name: 'wrapped', type: 'group', fields: [{ name: 'heading', type: 'text', localized: true }] }]
      let field: Field
      if (wrapper === 'tabs') field = { type: 'tabs', tabs: [{ label: 'Visible', fields: children }], ...restriction }
      else if (wrapper === 'unnamed tab') field = { type: 'tabs', tabs: [{ label: 'Restricted', fields: children, ...restriction }] }
      else if (wrapper === 'row') field = { type: 'row', fields: children, ...restriction }
      else if (wrapper === 'collapsible') field = { type: 'collapsible', label: 'Restricted', fields: children, ...restriction }
      else field = { type: 'group', fields: children, ...restriction }
      f.config.collections![0].fields.push(field)
      expect(f.resolve).toThrow(/wrapped.heading.*hidden|wrapped.heading.*read-only/i)
      // The rejection must be scoped to that wrapper, not a global schema veto.
      f.options.collections.posts.editorialFields!.include = ['title']
      expect(f.resolve().fields.map(({ path }) => path)).toEqual(['title'])
    }
  })

  test('resolves full polymorphic relation policy without assuming a single collection', () => {
    const f = fixture({ include: ['related'], relations: { related: { relationTo: ['tags', 'media'], allowCreate: false } } })
    f.config.collections![0].fields.push({ name: 'related', type: 'relationship', relationTo: ['media', 'tags'], localized: true })
    expect(f.resolve().relations.related.relationTo).toEqual(['tags', 'media'])
    f.options.collections.posts.editorialFields!.relations!.related.relationTo = ['tags']
    expect(f.resolve).toThrow(/related.*relationTo/i)
  })

  test('caches validated registries at startup and preserves opt-out behavior', () => {
    const f = fixture()
    const validated = validatePluginOptions(f.options, f.config)
    expect(resolveEditorialRegistry(validated, 'posts')).toBe(validated.editorialRegistries.posts)
    delete f.options.collections.posts.editorialFields
    expect(validatePluginOptions(f.options, f.config).editorialRegistries.posts.fields).toEqual([])
    expect(() => resolveEditorialRegistry(f.options, 'posts')).toThrow(/validated|config/i)
  })

  test('validates editorial configuration during plugin startup', () => {
    const f = fixture({ include: ['content'] })
    expect(() => validatePluginOptions(f.options, f.config)).toThrow(/content/i)
  })
})
