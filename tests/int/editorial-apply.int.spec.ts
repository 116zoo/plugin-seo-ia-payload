import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { buildConfig, createLocalReq, getPayload, type CollectionConfig, type Config, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

import { nimSeoPlugin } from '../../src/index.js'
import { applyProposalEndpoint } from '../../src/endpoints/apply.js'
import { resolveEditorialRegistry } from '../../src/services/editorialSchema.js'
import { applyProposal, createProposal, type ApplyProposalArgs } from '../../src/services/proposals.js'
import type { SeoProposalPayload, ValidatedPluginOptions } from '../../src/types.js'

let payload: Payload
let databaseDir: string
let user: NonNullable<PayloadRequest['user']>
const allowed = ({ req }: { req: PayloadRequest }) => Boolean(req.user)
const options: ValidatedPluginOptions = {
  collections: {
    posts: {
      titleField: 'title', localizedSourceFields: ['title', 'content'], mediaCollection: 'media',
      extractContent: ({ doc }) => String(doc.content), resolveURL: ({ doc, locale }) => `https://site.test/${locale}/posts/${doc.id}`,
      editorialFields: { include: ['title', 'excerpt', 'cta.label', 'faq', 'tags', 'category', 'items.label', 'sections.note.label'], relations: {
        tags: { relationTo: 'tags', allowCreate: true }, category: { relationTo: 'categories', allowCreate: true },
      } },
    },
    tags: {
      titleField: 'name', localizedSourceFields: ['name'], mediaCollection: 'media',
      extractContent: ({ doc }) => String(doc.name), resolveURL: ({ doc, locale }) => `https://site.test/${locale}/tags/${doc.id}`,
      editorialFields: { include: ['name', 'parent'], relations: { parent: { relationTo: 'categories', allowCreate: true } } },
    },
    categories: {
      titleField: 'name', localizedSourceFields: ['name'], mediaCollection: 'media',
      extractContent: ({ doc }) => String(doc.name), resolveURL: ({ doc, locale }) => `https://site.test/${locale}/categories/${doc.id}`,
      editorialFields: { include: ['name'] },
    },
  },
  locales: ['fr', 'en'], bulk: false, editorialRegistries: {},
  nim: { baseURL: 'https://nim.test/v1', apiKey: 'fixture', model: 'fixture' },
  site: { defaultLocale: 'fr', organization: { name: 'Site', url: 'https://site.test' } },
  permissions: { generate: allowed, apply: allowed, manage: allowed },
}

const sourceFields: CollectionConfig['fields'] = [
  { name: 'title', type: 'text', localized: true }, { name: 'content', type: 'textarea', localized: true },
  { name: 'excerpt', type: 'textarea', localized: true, access: { update: ({ req }) => !req.context.denyExcerpt } },
  { name: 'cta', type: 'group', fields: [{ name: 'label', type: 'text', localized: true }, { name: 'privateNote', type: 'text', localized: true }] },
  { name: 'faq', type: 'array', localized: true, fields: [{ name: 'question', type: 'text' }, { name: 'answer', type: 'textarea' }] },
  { name: 'items', type: 'array', fields: [{ name: 'label', type: 'text', localized: true }] },
  { name: 'sections', type: 'blocks', blocks: [{ slug: 'note', fields: [{ name: 'label', type: 'text', localized: true }] }] },
  { name: 'tags', type: 'relationship', relationTo: 'tags', hasMany: true, localized: true },
  { name: 'category', type: 'relationship', relationTo: 'categories', localized: true },
]

beforeAll(async () => {
  databaseDir = await mkdtemp(path.join(os.tmpdir(), 'nim-seo-editorial-'))
  const collections: CollectionConfig[] = [
    { slug: 'users', auth: true, fields: [] }, { slug: 'media', fields: [] },
    { slug: 'posts', versions: { drafts: true }, fields: sourceFields, access: { update: ({ req }) => !req.context.denyPostUpdate } },
    { slug: 'tags', versions: { drafts: true }, access: { create: ({ req }) => !req.context.denyTagCreate, read: ({ req }) => !req.context.denyTagRead },
      fields: [{ name: 'name', type: 'text', required: true, localized: true, access: { create: ({ req }) => !req.context.denyTagName } }, { name: 'parent', type: 'relationship', relationTo: 'categories', localized: true }],
      hooks: { beforeChange: [({ req }) => { if (req.context.failTag) throw new Error('Related creation rejected') }] } },
    { slug: 'categories', fields: [{ name: 'name', type: 'text', required: true, localized: true }] },
  ]
  for (const collection of Object.keys(options.collections)) options.editorialRegistries[collection] = resolveEditorialRegistry(options, collection, { collections } as Config)
  payload = await getPayload({ config: buildConfig({
    secret: 'editorial-integration-only-secret',
    email: () => ({ name: 'test', defaultFromAddress: 'test@example.test', defaultFromName: 'Test', sendEmail: async () => undefined }),
    db: sqliteAdapter({ client: { url: `file:${path.join(databaseDir, 'test.db')}` }, transactionOptions: {} }),
    localization: { locales: ['fr', 'en'], defaultLocale: 'fr', fallback: false }, collections,
    plugins: [nimSeoPlugin(options), (config) => {
      config.collections!.find(({ slug }) => slug === 'seo-proposals')!.hooks!.beforeChange!.push(({ data, req }) => {
        if (data.state === 'applied' && req.context.failApplication) throw new Error('Application bookkeeping rejected')
      })
      return config
    }],
  }) })
  user = { ...await payload.create({ collection: 'users', data: { email: 'editor@example.test', password: 'fixture-password' } }), collection: 'users' } as NonNullable<PayloadRequest['user']>
}, 30_000)

afterAll(async () => {
  await payload?.destroy()
  if (databaseDir) await rm(databaseDir, { recursive: true, force: true })
})

const setup = async (graph = false) => {
  const seo = { meta: { title: 'Original SEO' }, schema: [{ '@type': 'Organization', name: 'Keep schema' }] }
  const post = await payload.create({ collection: 'posts', locale: 'fr', data: { title: 'Titre FR', content: 'Contenu FR', excerpt: 'Chapô FR', cta: { label: 'FR', privateNote: 'Privé FR' }, seo, _status: 'published' } })
  await payload.update({ collection: 'posts', id: post.id, locale: 'en', data: { title: 'Title EN', content: 'Content EN', excerpt: 'Summary EN', cta: { label: 'EN', privateNote: 'Private EN' }, seo, _status: 'published' } })
  const req = await createLocalReq({ user }, payload)
  const doc = await payload.findByID({ collection: 'posts', id: post.id, locale: 'fr', fallbackLocale: false, draft: true, depth: 0 })
  const output: SeoProposalPayload = {
    meta: { title: 'Proposed SEO', description: 'Proposed description' }, social: {}, schema: [], citability: { summary: 'Résumé' },
    editorial: { locale: 'fr', patches: [
      { path: 'excerpt', operation: 'set', value: 'Chapô proposé' }, { path: 'cta.label', operation: 'set', value: 'Découvrir' },
      { path: 'faq', operation: 'set', value: [{ question: 'Pourquoi ?', answer: 'Pour apprendre.' }] },
      { path: 'tags', operation: 'set', value: [{ localId: 'tag-1' }] },
      { path: 'category', operation: 'set', value: { localId: 'unused-category' } },
    ], relatedDrafts: [
      { localId: 'tag-1', graphNodeId: 'draft:tag-1', collection: 'tags', locale: 'fr', fields: { name: 'Art numérique', parent: { localId: 'parent-1' } } },
      { localId: 'parent-1', graphNodeId: 'draft:parent-1', collection: 'categories', locale: 'fr', fields: { name: 'Culture' } },
      { localId: 'unused-category', graphNodeId: 'draft:unused-category', collection: 'categories', locale: 'fr', fields: { name: 'Non sélectionnée' } },
    ], ...(graph ? { semanticGraph: { '@context': 'https://schema.org', '@graph': [
      { '@id': `https://site.test/fr/posts/${post.id}`, '@type': 'Article', description: 'Chapô proposé', about: { '@id': 'draft:tag-1' } },
      { '@id': 'draft:tag-1', '@type': 'Thing', name: 'Art numérique', about: { '@id': 'draft:parent-1' } },
      { '@id': 'draft:parent-1', '@type': 'Thing', name: 'Culture' },
      { '@id': 'draft:unused-category', '@type': 'Thing', name: 'Non sélectionnée' },
    ] }, graphBindings: [
      { path: 'excerpt', nodeId: `https://site.test/fr/posts/${post.id}`, properties: ['description'] },
      { path: 'tags', nodeId: `https://site.test/fr/posts/${post.id}`, properties: ['about'] },
    ] } : {}) },
  }
  const proposal = await createProposal({ options, req, doc, collection: 'posts', locale: 'fr', client: { generate: async () => ({ output }) } })
  expect(proposal.state).toBe('draft')
  return { req, post, doc, proposal, output }
}
const selection = { groups: [], editorialPaths: ['excerpt', 'cta.label', 'faq', 'tags'], relatedDraftIDs: ['tag-1', 'parent-1'] } satisfies Pick<ApplyProposalArgs, 'groups' | 'editorialPaths' | 'relatedDraftIDs'>
const read = (id: string | number, locale = 'fr', draft = true) => payload.findByID({ collection: 'posts', id, locale, fallbackLocale: false, draft, depth: 0 })

describe('transactional editorial application', () => {
  test('applies explicit localized fields, nested groups/arrays, selected linked drafts, and leaves published/other-locale values intact', async () => {
    const { req, post, proposal } = await setup()
    const en = await read(post.id, 'en')
    const applied = await applyProposal({ options, req, proposal, locale: 'fr', ...selection })
    expect(applied).toMatchObject({ excerpt: 'Chapô proposé', content: 'Contenu FR', cta: { label: 'Découvrir', privateNote: 'Privé FR' }, faq: [{ question: 'Pourquoi ?', answer: 'Pour apprendre.' }], _status: 'draft' })
    const tag = await payload.findByID({ collection: 'tags', id: applied.tags[0], locale: 'fr', fallbackLocale: false, draft: true, depth: 0 })
    expect(tag).toMatchObject({ name: 'Art numérique', _status: 'draft' })
    expect((await payload.findByID({ collection: 'categories', id: tag.parent, locale: 'fr', fallbackLocale: false, depth: 0 })).name).toBe('Culture')
    expect((await payload.find({ collection: 'categories', where: { name: { equals: 'Non sélectionnée' } }, locale: 'fr' })).totalDocs).toBe(0)
    expect((await read(post.id)).seo.schema).toEqual(en.seo.schema)
    expect((await read(post.id, 'en')).excerpt).toBe(en.excerpt)
    expect((await read(post.id, 'fr', false)).excerpt).toBe('Chapô FR')
    expect((await payload.findByID({ collection: 'seo-proposals', id: proposal.id })).appliedSelection).toMatchObject({ editorialPaths: selection.editorialPaths, relatedDraftIDs: selection.relatedDraftIDs, applyGraph: false })
  })

  test('persists only the explicitly selected reconciled graph and resolves local IDs through host URLs', async () => {
    const { req, proposal } = await setup(true)
    const applied = await applyProposal({ options, req, proposal, locale: 'fr', ...selection, applyGraph: true } as ApplyProposalArgs)
    expect(applied.seo.schema).toHaveLength(1)
    const graph = applied.seo.schema[0]
    expect(graph['@context']).toBe('https://schema.org')
    expect(graph['@graph']).toHaveLength(3)
    expect(JSON.stringify(graph)).not.toMatch(/draft:|Non sélectionnée/)
    expect(graph['@graph'][0].about['@id']).toBe(`https://site.test/fr/tags/${applied.tags[0]}`)
  })

  test('rejects forbidden, undeclared, duplicate, wrong-locale and unselected-dependency selections without mutation', async () => {
    const cases = [
      { editorialPaths: ['content'] }, { editorialPaths: ['unknown'] }, { editorialPaths: ['excerpt', 'excerpt'] },
      { locale: 'en' }, { relatedDraftIDs: ['tag-1'] }, { relatedDraftIDs: ['tag-1', 'parent-1', 'unused-category'] },
    ]
    for (const invalid of cases) {
      const { req, post, proposal } = await setup()
      await expect(applyProposal({ options, req, proposal, locale: 'fr', ...selection, ...invalid })).rejects.toThrow()
      expect((await read(post.id)).excerpt).toBe('Chapô FR')
      expect((await payload.findByID({ collection: 'seo-proposals', id: proposal.id })).state).toBe('draft')
    }
  })

  test('rejects stale editorial values even when title/content/URL still match the generation snapshot', async () => {
    const { req, post, proposal } = await setup()
    await payload.update({ collection: 'posts', id: post.id, locale: 'fr', draft: true, data: { excerpt: 'Modification humaine' } })
    await expect(applyProposal({ options, req, proposal, locale: 'fr', ...selection })).rejects.toThrow(/stale/i)
    expect((await read(post.id)).excerpt).toBe('Modification humaine')
  })

  test('enforces source update and related create/read access, including silent field-level denial', async () => {
    for (const flag of ['denyPostUpdate', 'denyTagCreate', 'denyTagRead', 'denyTagName', 'denyExcerpt']) {
      const { req, post, proposal } = await setup()
      req.context[flag] = true
      await expect(applyProposal({ options, req, proposal, locale: 'fr', ...selection })).rejects.toThrow()
      expect((await read(post.id)).excerpt).toBe('Chapô FR')
      expect((await payload.findByID({ collection: 'seo-proposals', id: proposal.id })).state).toBe('draft')
    }
  })

  test('revalidates persisted patches and rejects array/block leaf paths without broadcasting them', async () => {
    for (const path of ['content', 'items.label', 'sections.note.label']) {
      const { req, post, proposal, output, doc } = await setup()
      if (path === 'content') {
        await payload.update({ collection: 'seo-proposals', id: proposal.id, data: { output: { ...output, editorial: { locale: 'fr', patches: [{ path, operation: 'set', value: 'Interdit' }], relatedDrafts: [] } } } })
      } else {
        const next = await createProposal({ options, req, doc, collection: 'posts', locale: 'fr', client: { generate: async () => ({ output: { ...output, editorial: { locale: 'fr', patches: [{ path, operation: 'set', value: 'Ambigu' }], relatedDrafts: [] } } }) } })
        proposal.id = next.id
        expect(next.state).toBe('draft')
      }
      await expect(applyProposal({ options, req, proposal, locale: 'fr', groups: [], editorialPaths: [path] })).rejects.toThrow(path === 'content' ? /content/i : /whole-container/i)
      expect((await read(post.id)).content).toBe('Contenu FR')
      expect((await payload.findByID({ collection: 'seo-proposals', id: proposal.id })).state).toBe('draft')
    }
  })

  test('keeps schema untouched without the graph checkbox and rejects graph/schema conflicts', async () => {
    const first = await setup(true)
    await expect(applyProposal({ options, req: first.req, proposal: first.proposal, locale: 'fr', ...selection, groups: ['schema'], applyGraph: true })).rejects.toThrow(/conflicting/i)
    const applied = await applyProposal({ options, req: first.req, proposal: first.proposal, locale: 'fr', ...selection })
    expect(applied.seo.schema).toEqual(first.doc.seo.schema)
    const second = await setup()
    await expect(applyProposal({ options, req: second.req, proposal: second.proposal, locale: 'fr', ...selection, applyGraph: true })).rejects.toThrow(/no editorial semantic graph/i)
  })

  test('rolls back created related records when the host cannot resolve their safe graph URL', async () => {
    const { req, post, proposal } = await setup(true)
    const before = await payload.count({ collection: 'categories' })
    const badURL = { ...options, collections: { ...options.collections, tags: { ...options.collections.tags, resolveURL: () => 'javascript:bad' } } }
    await expect(applyProposal({ options: badURL, req, proposal, locale: 'fr', ...selection, applyGraph: true })).rejects.toThrow()
    expect((await payload.count({ collection: 'categories' })).totalDocs).toBe(before.totalDocs)
    expect((await read(post.id)).excerpt).toBe('Chapô FR')
    expect((await payload.findByID({ collection: 'seo-proposals', id: proposal.id })).state).toBe('draft')
  })

  test('rolls back a graph application if an editorial change alters the host source URL', async () => {
    const { req, post, proposal } = await setup(true)
    const before = await payload.count({ collection: 'tags' })
    const movingURL = { ...options, collections: { ...options.collections, posts: { ...options.collections.posts,
      resolveURL: ({ doc, locale }: { doc: Record<string, unknown>; locale: string }) => `https://site.test/${locale}/posts/${doc.id}${doc.excerpt === 'Chapô proposé' ? '/changed' : ''}`,
    } } }
    await expect(applyProposal({ options: movingURL, req, proposal, locale: 'fr', ...selection, applyGraph: true })).rejects.toThrow(/source URL changed/i)
    expect((await payload.count({ collection: 'tags' })).totalDocs).toBe(before.totalDocs)
    expect((await read(post.id)).excerpt).toBe('Chapô FR')
    expect((await payload.findByID({ collection: 'seo-proposals', id: proposal.id })).state).toBe('draft')
  })

  test('validates endpoint selections and applies explicit editorial-only requests', async () => {
    const { req, proposal } = await setup()
    const endpoint = applyProposalEndpoint(options)
    for (const extra of [{ groups: [], editorialPaths: [], relatedDraftIDs: [] }, { groups: ['meta', 'meta'] }, { groups: ['schema'], applyGraph: true }, { editorialPaths: ['excerpt', 'excerpt'] }, { relatedDraftIDs: ['bad:id'] }, { unexpected: true }]) {
      req.json = async () => ({ proposalID: proposal.id, locale: 'fr', ...selection, ...extra })
      expect((await endpoint.handler(req)).status).toBe(400)
    }
    req.json = async () => ({ proposalID: proposal.id, locale: 'fr', ...selection })
    const response = await endpoint.handler(req)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ doc: { excerpt: 'Chapô proposé' } })
  })

  test('conditionally claims the exact proposal version and rejects replay before creating related records', async () => {
    const { req, proposal } = await setup()
    const claim = vi.spyOn(payload.db, 'updateOne')
    await applyProposal({ options, req, proposal, locale: 'fr', ...selection })
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ collection: 'seo-proposals', options: { atomic: true }, data: { state: 'approved' }, req,
      where: { and: [{ id: { equals: proposal.id } }, { state: { equals: 'draft' } }, { updatedAt: { equals: proposal.updatedAt } }] },
    }))
    claim.mockRestore()
    const before = await payload.count({ collection: 'tags' })
    await expect(applyProposal({ options, req, proposal, locale: 'fr', ...selection })).rejects.toThrow(/draft/i)
    expect((await payload.count({ collection: 'tags' })).totalDocs).toBe(before.totalDocs)
    const next = await setup()
    const rejected = vi.spyOn(payload.db, 'updateOne').mockResolvedValueOnce(null as unknown as Awaited<ReturnType<typeof payload.db.updateOne>>)
    try {
      await expect(applyProposal({ options, req: next.req, proposal: next.proposal, locale: 'fr', ...selection })).rejects.toThrow(/draft/i)
    } finally { rejected.mockRestore() }
    expect((await payload.count({ collection: 'tags' })).totalDocs).toBe(before.totalDocs)
    expect((await payload.findByID({ collection: 'seo-proposals', id: next.proposal.id })).state).toBe('draft')
  })

  test('fails closed for an unverified adapter before any editorial mutation', async () => {
    const { req, post, proposal } = await setup()
    const name = payload.db.name
    try {
      payload.db.name = 'custom-unverified'
      await expect(applyProposal({ options, req, proposal, locale: 'fr', ...selection })).rejects.toThrow(/atomic proposal claim/i)
    } finally { payload.db.name = name }
    expect((await read(post.id)).excerpt).toBe('Chapô FR')
    expect((await payload.findByID({ collection: 'seo-proposals', id: proposal.id })).state).toBe('draft')
  })

  test('rolls back every related record, source draft and application audit when creation or bookkeeping fails', async () => {
    for (const flag of ['failTag', 'failApplication']) {
      const { req, post, proposal } = await setup()
      const tags = await payload.count({ collection: 'tags' })
      const categories = await payload.count({ collection: 'categories' })
      req.context[flag] = true
      await expect(applyProposal({ options, req, proposal, locale: 'fr', ...selection })).rejects.toThrow(/rejected/i)
      expect((await payload.count({ collection: 'tags' })).totalDocs).toBe(tags.totalDocs)
      expect((await payload.count({ collection: 'categories' })).totalDocs).toBe(categories.totalDocs)
      expect((await read(post.id)).excerpt).toBe('Chapô FR')
      expect((await payload.findByID({ collection: 'seo-proposals', id: proposal.id })).state).toBe('draft')
    }
  })
})
