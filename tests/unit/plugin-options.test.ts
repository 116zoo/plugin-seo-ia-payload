import type { Config, Field } from 'payload'
import { describe, expect, test } from 'vitest'

import { nimSeoPlugin, validatePluginOptions } from '../../src/index.js'
import type { NimSeoPluginOptions } from '../../src/index.js'

const makeOptions = (): NimSeoPluginOptions => ({
  collections: {
    posts: {
      titleField: 'title',
      extractContent: ({ doc }) => String(doc.content ?? ''),
      resolveURL: ({ doc, locale }) => `https://example.test/${locale}/${String(doc.slug)}`,
      mediaCollection: 'media',
    },
  },
  locales: ['fr', 'en'],
  nim: {
    baseURL: 'https://integrate.api.nvidia.com/v1',
    apiKey: 'fixture-key-not-a-secret',
    model: 'fixture-model',
  },
  site: {
    defaultLocale: 'fr',
    organization: { name: 'Fixture', url: 'https://example.test' },
  },
  permissions: { generate: () => false, apply: () => false, manage: () => false },
})

const makeConfig = (): Config => ({
  // Validation operates on config before Payload initializes the database.
  db: {} as Config['db'],
  secret: 'fixture-secret',
  collections: [
    { slug: 'posts', fields: [{ name: 'title', type: 'text', localized: true }] },
    { slug: 'media', upload: true, fields: [] },
  ],
  localization: { locales: ['fr', 'en'], defaultLocale: 'fr' },
  jobs: { tasks: [] },
})

describe('validatePluginOptions', () => {
  test('retains independently configured locales and defaults bulk to false', () => {
    expect(validatePluginOptions(makeOptions(), makeConfig())).toMatchObject({
      locales: ['fr', 'en'],
      bulk: false,
    })
  })

  test('accepts a subset of labeled Payload locales', () => {
    const config = makeConfig()
    config.localization = {
      locales: [
        { code: 'fr', label: 'Français' },
        { code: 'en', label: 'English' },
        { code: 'de', label: 'Deutsch' },
      ],
      defaultLocale: 'fr',
    }
    expect(validatePluginOptions(makeOptions(), config).locales).toEqual(['fr', 'en'])
  })

  test('names the locale missing from Payload localization', () => {
    const config = makeConfig()
    config.localization = { locales: ['fr'], defaultLocale: 'fr' }
    expect(() => validatePluginOptions(makeOptions(), config)).toThrow(/en.*localization/i)
  })

  test.each([undefined, false] as const)('rejects disabled localization (%s)', (localization) => {
    const config = makeConfig()
    config.localization = localization
    expect(() => validatePluginOptions(makeOptions(), config)).toThrow(/localization/i)
  })

  test('requires at least one plugin locale', () => {
    const options = makeOptions()
    options.locales = []
    expect(() => validatePluginOptions(options, makeConfig())).toThrow(/locales/i)
  })

  test('requires at least one target collection', () => {
    const options = makeOptions()
    options.collections = {}
    expect(() => validatePluginOptions(options, makeConfig())).toThrow(/collections/i)
  })

  test('rejects a target collection absent from the host', () => {
    const config = makeConfig()
    config.collections = config.collections?.filter(({ slug }) => slug !== 'posts')
    expect(() => validatePluginOptions(makeOptions(), config)).toThrow(/posts.*collection/i)
  })

  test('checks every configured target collection', () => {
    const options = makeOptions()
    options.collections.pages = { ...options.collections.posts }
    expect(() => validatePluginOptions(options, makeConfig())).toThrow(/pages.*collection/i)
  })

  test.each(['titleField', 'extractContent', 'resolveURL', 'mediaCollection'] as const)(
    'names a missing %s adapter on its collection',
    (field) => {
      const options = makeOptions()
      delete (options.collections.posts as unknown as Record<string, unknown>)[field]
      expect(() => validatePluginOptions(options, makeConfig())).toThrow(
        new RegExp(`posts.*${field}`, 'i'),
      )
    },
  )

  test.each(['titleField', 'mediaCollection'] as const)('rejects a blank %s', (field) => {
    const options = makeOptions()
    options.collections.posts[field] = '  '
    expect(() => validatePluginOptions(options, makeConfig())).toThrow(new RegExp(field, 'i'))
  })

  test.each(['extractContent', 'resolveURL'] as const)('requires a callable %s', (field) => {
    const options = makeOptions()
    ;(options.collections.posts as unknown as Record<string, unknown>)[field] = 'not a function'
    expect(() => validatePluginOptions(options, makeConfig())).toThrow(new RegExp(field, 'i'))
  })

  test('rejects a media collection absent from the host', () => {
    const config = makeConfig()
    config.collections = config.collections?.filter(({ slug }) => slug !== 'media')
    expect(() => validatePluginOptions(makeOptions(), config)).toThrow(/posts.*mediaCollection.*media/i)
  })

  test.each(['baseURL', 'apiKey', 'model'] as const)('names missing NIM %s', (field) => {
    const options = makeOptions()
    delete (options.nim as unknown as Record<string, unknown>)[field]
    expect(() => validatePluginOptions(options, makeConfig())).toThrow(new RegExp(`nim.*${field}`, 'i'))
  })

  test.each(['baseURL', 'apiKey', 'model'] as const)('rejects blank NIM %s', (field) => {
    const options = makeOptions()
    options.nim[field] = '   '
    expect(() => validatePluginOptions(options, makeConfig())).toThrow(new RegExp(`nim.*${field}`, 'i'))
  })

  test.each(['not-a-url', '/v1', 'file:///tmp/nim', 'ftp://example.test/v1'])(
    'rejects an invalid NIM baseURL (%s)',
    (baseURL) => {
      const options = makeOptions()
      options.nim.baseURL = baseURL
      expect(() => validatePluginOptions(options, makeConfig())).toThrow(/nim.*baseURL/i)
    },
  )

  test('accepts an HTTP endpoint for self-hosted NIM', () => {
    const options = makeOptions()
    options.nim.baseURL = 'http://localhost:8000/v1'
    expect(validatePluginOptions(options, makeConfig()).nim.baseURL).toBe('http://localhost:8000/v1')
  })

  test('requires Payload jobs when bulk is enabled', () => {
    const options = { ...makeOptions(), bulk: true }
    const config = makeConfig()
    delete config.jobs
    expect(() => validatePluginOptions(options, config)).toThrow(/jobs/i)
  })

  test('accepts host-configured jobs when bulk is enabled', () => {
    expect(validatePluginOptions({ ...makeOptions(), bulk: true }, makeConfig()).bulk).toBe(true)
  })

  test.each([undefined, false])('allows single-document generation without jobs (bulk=%s)', (bulk) => {
    const config = makeConfig()
    delete config.jobs
    expect(validatePluginOptions({ ...makeOptions(), bulk }, config).bulk).toBe(false)
  })
})

describe('nimSeoPlugin', () => {
  test('validates the host when Payload applies the plugin', () => {
    const config = makeConfig()
    config.localization = { locales: ['fr'], defaultLocale: 'fr' }
    expect(() => nimSeoPlugin(makeOptions())(config)).toThrow(/en.*localization/i)
  })

  test('preserves compatible host configuration while adding SEO models', async () => {
    const config = makeConfig()
    config.endpoints = [{ path: '/host', method: 'get', handler: () => new Response('host') }]
    config.admin = { meta: { titleSuffix: 'Host CMS' } }
    const originalCollections = [...config.collections!]
    const originalFields = [...originalCollections[0].fields]
    const result = await nimSeoPlugin(makeOptions())(config)
    expect(result.endpoints).toBe(config.endpoints)
    expect(result.jobs).toBe(config.jobs)
    expect(result.admin).toBe(config.admin)
    expect(result.collections?.find(({ slug }) => slug === 'media')).toBe(originalCollections[1])
    expect(result.collections?.find(({ slug }) => slug === 'posts')?.fields).toEqual(
      expect.arrayContaining([...originalFields, expect.objectContaining({ name: 'seo' })]),
    )
    expect(config.collections).toEqual(originalCollections)
    expect(config.collections?.[0].fields).toEqual(originalFields)
  })

  test('uses each target collection media adapter', async () => {
    const config = makeConfig()
    const options = makeOptions()
    options.collections.pages = { ...options.collections.posts, mediaCollection: 'page-media' }
    config.collections!.push({ slug: 'pages', fields: [] }, { slug: 'page-media', fields: [] })
    const result = await nimSeoPlugin(options)(config)
    expect(result.collections?.find(({ slug }) => slug === 'pages')?.fields).toContainEqual(
      expect.objectContaining({ name: 'seo', fields: expect.arrayContaining([
        expect.objectContaining({ name: 'social', fields: expect.arrayContaining([
          expect.objectContaining({ name: 'image', relationTo: 'page-media' }),
        ]) }),
      ]) }),
    )
  })

  test.each(['seo-proposals', 'seo-runs'])(
    'rejects reserved workflow collection %s without mutating the host',
    (slug) => {
      const config = makeConfig()
      const collision = {
        slug,
        access: { read: () => true },
        fields: [{ name: 'hostField', type: 'text' as const }],
      }
      config.collections!.push(collision)
      const originalCollections = config.collections
      const originalFields = collision.fields
      expect(() => nimSeoPlugin(makeOptions())(config)).toThrow(new RegExp(`${slug}.*reserved`, 'i'))
      expect(config.collections).toBe(originalCollections)
      expect(config.collections!.at(-1)).toBe(collision)
      expect(collision.fields).toBe(originalFields)
      expect(config.collections![0].fields).toEqual([{ name: 'title', type: 'text', localized: true }])
    },
  )

  test.each<Field>([
    { name: 'seo', type: 'text' },
    { name: 'seo', type: 'group', fields: [{ name: 'host', type: 'text' }] },
    { name: 'seo', type: 'group', localized: true, fields: [] },
    { name: 'seo', type: 'group', localized: true, fields: [{ name: 'citability', type: 'group', fields: [{ name: 'summary', type: 'textarea', maxLength: 2001 }] }] },
    { name: 'seo', type: 'group', localized: true, fields: [{ name: 'citability', type: 'group', fields: [{ name: 'summary', type: 'textarea', maxLength: 2000, validate: () => true }] }] },
  ])('rejects pre-existing reserved SEO fields without changing their schema ($type)', (field) => {
    const config = makeConfig()
    config.collections![0].fields.push(field)
    const originalFields = config.collections![0].fields
    expect(() => nimSeoPlugin(makeOptions())(config)).toThrow(/posts.*seo.*reserved/i)
    expect(config.collections![0].fields).toBe(originalFields)
    expect(config.collections![0].fields.at(-1)).toBe(field)
  })

  test('preserves unrelated internal collections and SEO fields on untargeted collections', async () => {
    const config = makeConfig()
    const internal = { slug: 'host-private-records', access: { read: () => false }, fields: [] }
    config.collections!.push(internal)
    const media = config.collections![1]
    media.fields.push({ name: 'seo', type: 'text' })
    const result = await nimSeoPlugin(makeOptions())(config)
    expect(result.collections?.find(({ slug }) => slug === internal.slug)).toBe(internal)
    expect(result.collections?.find(({ slug }) => slug === 'media')).toBe(media)
  })
})
