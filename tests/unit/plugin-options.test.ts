import type { Config, Field } from 'payload'
import { describe, expect, test } from 'vitest'

import { nimSeoPlugin, validatePluginOptions } from '../../src/index.js'
import type { NimSeoPluginOptions } from '../../src/index.js'

const makeOptions = (): NimSeoPluginOptions => ({
  collections: {
    posts: {
      titleField: 'title',
      localizedSourceFields: ['title', 'slug', 'content'],
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
    { slug: 'posts', fields: [
      { name: 'title', type: 'text', localized: true },
      { name: 'slug', type: 'text', localized: true },
      { name: 'content', type: 'textarea', localized: true },
    ] },
    { slug: 'media', upload: true, fields: [] },
  ],
  localization: { locales: ['fr', 'en'], defaultLocale: 'fr' },
  jobs: { tasks: [] },
})

describe('validatePluginOptions', () => {
  test.each(['title', 'content'].flatMap((name) => [undefined, false].map((localized) => ({ name, localized }))))(
    'rejects a shared source $name (localized=$localized) even when SEO/locales are bilingual', ({ name, localized }) => {
      const config = makeConfig()
      const field = config.collections![0].fields.find((field) => 'name' in field && field.name === name)!
      if ('localized' in field) field.localized = localized
      expect(() => validatePluginOptions(makeOptions(), config)).toThrow(new RegExp(`posts.*${name}.*localized`, 'i'))
    },
  )

  test.each([undefined, null, [], 'content', [''], ['  '], [123], ['title', 'article..body']].map((fields) => ({ fields })))(
    'requires a nonempty declaration of source field paths ($fields)', ({ fields }) => {
      const options = makeOptions()
      ;(options.collections.posts as unknown as Record<string, unknown>).localizedSourceFields = fields
      expect(() => validatePluginOptions(options, makeConfig())).toThrow(/posts.*localizedSourceFields/i)
    },
  )

  test('requires the source title in the localization declaration', () => {
    const options = makeOptions()
    options.collections.posts.localizedSourceFields = ['content']
    expect(() => validatePluginOptions(options, makeConfig())).toThrow(/posts.*title.*localizedSourceFields/i)
  })

  test('names a declared source field absent from the targeted collection', () => {
    const options = makeOptions()
    options.collections.posts.localizedSourceFields = ['title', 'missing']
    expect(() => validatePluginOptions(options, makeConfig())).toThrow(/posts.*missing.*exist/i)
  })

  test('resolves source paths through layout fields, named tabs, groups, arrays and block variants', () => {
    const config = makeConfig()
    config.collections![0].fields.push({ type: 'tabs', tabs: [
      { label: 'Content', fields: [{ type: 'row', fields: [{ type: 'collapsible', label: 'Details', fields: [
        { name: 'intro', type: 'textarea', localized: true },
      ] }] }] },
      { name: 'article', fields: [{ name: 'details', type: 'group', fields: [
        { name: 'body', type: 'richText', localized: true },
      ] }] },
    ] }, {
      name: 'sections', type: 'array', fields: [{ name: 'text', type: 'textarea', localized: true }],
    }, {
      name: 'layout', type: 'blocks', blocks: [{ slug: 'hero', fields: [
        { name: 'text', type: 'textarea', localized: true },
      ] }], blockReferences: ['shared'],
    })
    config.blocks = [{ slug: 'shared', fields: [{ name: 'text', type: 'textarea', localized: true }] }]
    const options = makeOptions()
    options.collections.posts.localizedSourceFields = ['title', 'content', 'intro', 'article.details.body', 'sections.text', 'layout.hero.text', 'layout.shared.text']
    expect(validatePluginOptions(options, config).collections.posts.localizedSourceFields).toEqual(options.collections.posts.localizedSourceFields)
    options.collections.posts.localizedSourceFields = ['title', 'article.details.missing']
    expect(() => validatePluginOptions(options, config)).toThrow(/posts.*article.details.missing.*exist/i)
  })

  test('does not confuse equally named fields in different groups or block variants', () => {
    const config = makeConfig()
    config.collections![0].fields.push({ name: 'shared', type: 'group', fields: [
      { name: 'content', type: 'textarea' },
    ] }, { name: 'layout', type: 'blocks', blocks: [
      { slug: 'translated', fields: [{ name: 'text', type: 'textarea', localized: true }] },
      { slug: 'shared', fields: [{ name: 'text', type: 'textarea' }] },
    ] })
    const options = makeOptions()
    for (const path of ['shared.content', 'layout.shared.text']) {
      options.collections.posts.localizedSourceFields = ['title', path]
      expect(() => validatePluginOptions(options, config)).toThrow(new RegExp(`posts.*${path}.*localized`, 'i'))
    }
  })

  test('requires explicit localization on a declared field even inside a localized group', () => {
    const config = makeConfig()
    config.collections![0].fields.push({ name: 'article', type: 'group', localized: true, fields: [
      { name: 'body', type: 'textarea' },
    ] })
    const options = makeOptions()
    options.collections.posts.localizedSourceFields = ['title', 'article.body']
    expect(() => validatePluginOptions(options, config)).toThrow(/posts.*article.body.*localized/i)
  })

  test('retains independently configured locales and defaults bulk to false', () => {
    expect(validatePluginOptions(makeOptions(), makeConfig())).toMatchObject({
      locales: ['fr', 'en'],
      collections: { posts: { localizedSourceFields: ['title', 'slug', 'content'] } },
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
  test('registers locale-aware UI without serializing provider configuration or replacing host components', async () => {
    const config = makeConfig()
    config.admin = { components: { beforeDashboard: ['host/Before'], afterDashboard: ['host/After'] } }
    const result = await nimSeoPlugin(makeOptions())(config)
    expect(result.admin?.components?.beforeDashboard).toEqual([
      'host/Before', {
        path: '@scope/payload-plugin-nim-seo/client#AuditDashboard',
        clientProps: { locales: ['fr', 'en'], collections: ['posts'], bulk: false },
      },
    ])
    expect(result.admin?.components?.afterDashboard).toEqual(['host/After'])
    expect(config.admin.components?.beforeDashboard).toEqual(['host/Before'])
    expect(result.collections?.find(({ slug }) => slug === 'posts')?.fields).toContainEqual({
      name: 'nimSeoPanel', type: 'ui', admin: { components: { Field: {
        path: '@scope/payload-plugin-nim-seo/client#SeoPanel',
        clientProps: { locales: ['fr', 'en'], mediaCollection: 'media' },
      } } },
    })
  })

  test('rejects a host capability endpoint collision before registration', () => {
    const config = makeConfig()
    config.endpoints = [{ path: '/nim-seo/capabilities', method: 'get', handler: () => new Response() }]
    expect(() => nimSeoPlugin(makeOptions())(config)).toThrow(/capabilities.*reserved/i)
  })

  test('rejects a conflicting host field instead of adding a duplicate admin panel name', () => {
    const config = makeConfig()
    config.collections![0].fields.push({ name: 'nimSeoPanel', type: 'text' })
    expect(() => nimSeoPlugin(makeOptions())(config)).toThrow(/nimSeoPanel.*reserved/i)
  })

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
    expect(result.endpoints).toEqual(expect.arrayContaining(config.endpoints))
    expect(config.endpoints).toHaveLength(1)
    expect(result.jobs).toBe(config.jobs)
    expect(result.admin).toMatchObject(config.admin!)
    expect(config.admin).toEqual({ meta: { titleSuffix: 'Host CMS' } })
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
    config.collections!.push({ slug: 'pages', fields: makeConfig().collections![0].fields }, { slug: 'page-media', fields: [] })
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
      expect(config.collections![0].fields).toEqual(makeConfig().collections![0].fields)
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

describe('protected workflow registration', () => {
  test('keeps host tasks/settings/endpoints intact while registering bulk tasks', async () => {
    const config = makeConfig()
    const task = { slug: 'host-job', handler: async () => ({ output: {} }) }
    const queue = () => false
    config.jobs = { tasks: [task], access: { queue } }
    const result = await nimSeoPlugin({ ...makeOptions(), bulk: true })(config)
    expect(result.jobs?.tasks).toEqual(expect.arrayContaining([task, expect.objectContaining({ slug: 'nim-seo-generate-proposal' }), expect.objectContaining({ slug: 'nim-seo-run-audit' })]))
    expect(result.jobs?.access?.queue).toBe(queue)
    expect(config.jobs.tasks).toEqual([task])
    expect(result.endpoints).toEqual(expect.arrayContaining(['/nim-seo/generate', '/nim-seo/apply', '/nim-seo/audit'].map((path) => expect.objectContaining({ path, method: 'post' }))))
  })
  test.each(['nim-seo-generate-proposal', 'nim-seo-run-audit'])('rejects reserved host job collision %s', (slug) => {
    const config = makeConfig()
    config.jobs!.tasks = [{ slug, handler: async () => ({ output: {} }) }]
    expect(() => nimSeoPlugin({ ...makeOptions(), bulk: true })(config)).toThrow(/reserved/)
  })
  test.each(['/nim-seo/generate', '/nim-seo/apply', '/nim-seo/audit'])('rejects reserved host endpoint collision %s', (path) => {
    const config = makeConfig()
    config.endpoints = [{ path, method: 'post', handler: () => new Response() }]
    expect(() => nimSeoPlugin(makeOptions())(config)).toThrow(/reserved/)
  })
})
