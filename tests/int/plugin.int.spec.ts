import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { buildConfig, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { Posts } from '../../dev/collections/Posts.js'
import { nimSeoPlugin } from '../../src/index.js'

let payload: Payload
let databaseDir: string
let viewer: NonNullable<PayloadRequest['user']>
let editor: NonNullable<PayloadRequest['user']>
let manager: NonNullable<PayloadRequest['user']>
const hasRole = (...roles: string[]) => async ({ req }: { req: PayloadRequest }): Promise<boolean> =>
  roles.includes(String(req.user?.role))
const proposalData = {
  sourceCollection: 'posts',
  sourceID: '123',
  locale: 'fr',
  sourceFingerprint: 'source-fingerprint',
  sourceSnapshot: { title: 'Bonjour' },
  output: { meta: { title: 'Proposed title' }, citability: { summary: 'Proposed summary' } },
  diff: { meta: { title: { before: '', after: 'Proposed title' } } },
  actor: { collection: 'users', userID: '1' },
  errors: [{ code: 'validation', message: 'Safe error' }],
}

beforeAll(async () => {
  databaseDir = await mkdtemp(path.join(os.tmpdir(), 'nim-seo-integration-'))
  payload = await getPayload({
    config: buildConfig({
      secret: 'integration-only-not-a-production-secret',
      email: () => ({ name: 'integration-no-send', defaultFromAddress: 'test@example.test', defaultFromName: 'Integration', sendEmail: async () => undefined }),
      db: sqliteAdapter({ client: { url: `file:${path.join(databaseDir, 'test.db')}` } }),
      localization: { locales: ['fr', 'en'], defaultLocale: 'fr', fallback: false },
      collections: [
        {
          slug: 'users', auth: true,
          fields: [{ name: 'role', type: 'select', options: ['viewer', 'editor', 'manager', 'generator', 'reviewer'] }],
        },
        { slug: 'media', fields: [{ name: 'alt', type: 'text' }] },
        Posts,
      ],
      plugins: [nimSeoPlugin({
        collections: {
          posts: {
            titleField: 'title', mediaCollection: 'media',
            extractContent: ({ doc }) => String(doc.content ?? ''),
            resolveURL: ({ doc, locale }) => `https://example.test/${locale}/${String(doc.slug)}`,
          },
        },
        locales: ['fr', 'en'],
        nim: { baseURL: 'https://example.test/v1', apiKey: 'never-expose-this-fixture-key', model: 'fixture' },
        site: { defaultLocale: 'fr', organization: { name: 'Fixture', url: 'https://example.test' } },
        permissions: { generate: hasRole('editor', 'generator'), apply: hasRole('editor', 'reviewer'), manage: hasRole('manager') },
      })],
    }),
  })
  for (const role of ['viewer', 'editor', 'manager', 'generator', 'reviewer']) {
    const user = await payload.create({
      collection: 'users', data: { email: `${role}@example.test`, password: 'fixture-password', role },
    })
    const actor = { ...user, collection: 'users' } as NonNullable<PayloadRequest['user']>
    if (role === 'viewer') viewer = actor
    if (role === 'editor') editor = actor
    if (role === 'manager') manager = actor
  }
}, 30_000)

afterAll(async () => {
  await payload?.destroy()
  if (databaseDir) await rm(databaseDir, { recursive: true, force: true })
})

describe('localized SEO models', () => {
  test('registers SEO on target collections and private workflow collections', () => {
    expect(payload.collections.posts.config.fields).toContainEqual(
      expect.objectContaining({ name: 'seo', localized: true }),
    )
    expect(payload.collections['seo-proposals']).toBeDefined()
    expect(payload.collections['seo-runs']).toBeDefined()
    expect(payload.collections.media.config.fields).not.toContainEqual(expect.objectContaining({ name: 'seo' }))
  })

  test('persists all approved SEO groups independently for fr and en', async () => {
    const media = await payload.create({ collection: 'media', data: { alt: 'Photo' } })
    const seo = {
      meta: { title: 'Titre FR', description: 'Description FR', canonical: 'https://example.test/fr', robots: 'index,follow', focusKeyphrase: 'bonjour' },
      social: { image: media.id, imageAlt: 'Image FR', imageFilename: 'photo.jpg', imageCaption: 'Légende', recommendedWidth: 1200, recommendedHeight: 630, ogTitle: 'OG FR', ogDescription: 'OG description FR', twitterCard: 'summary_large_image' },
      schema: [{ '@context': 'https://schema.org', '@type': 'Article', version: 1 }],
      citability: { summary: 'Résumé FR', sources: ['https://example.test/source'], claims: ['Affirmation'] },
      status: { lastValidatedAt: '2026-11-12T00:00:00.000Z', completeness: 'complete', warnings: ['Review image'] },
    }
    const post = await payload.create({ collection: 'posts', locale: 'fr', data: { title: 'Bonjour', slug: 'bonjour', seo } })
    await payload.update({ collection: 'posts', id: post.id, locale: 'en', data: { title: 'Hello', slug: 'hello', seo: { meta: { title: 'Title EN' }, citability: { summary: 'Summary EN' } } } })
    const french = await payload.findByID({ collection: 'posts', id: post.id, locale: 'fr', fallbackLocale: false, depth: 0 })
    const english = await payload.findByID({ collection: 'posts', id: post.id, locale: 'en', fallbackLocale: false, depth: 0 })
    expect(french.seo).toMatchObject(seo)
    expect(english.seo).toMatchObject({ meta: { title: 'Title EN' }, citability: { summary: 'Summary EN' } })
    expect(english.seo.social?.image).not.toBe(media.id)
    expect(english.seo.schema).not.toEqual(seo.schema)
    expect(french.title).toBe('Bonjour')
  })

  test('enforces the 2,000-character summary boundary on server create and update', async () => {
    const post = await payload.create({ collection: 'posts', locale: 'fr', data: { title: 'Limit', slug: 'limit', seo: { citability: { summary: 'x'.repeat(2000) } } } })
    expect(post.seo?.citability?.summary).toHaveLength(2000)
    await expect(payload.create({ collection: 'posts', locale: 'fr', data: { title: 'Too long', slug: 'too-long', seo: { citability: { summary: 'x'.repeat(2001) } } } })).rejects.toThrow()
    await expect(payload.update({ collection: 'posts', id: post.id, locale: 'en', data: { seo: { citability: { summary: 'x'.repeat(2001) } } } })).rejects.toThrow()
  })
})

describe('private workflow records', () => {
  test('persists source identity, structured proposal, diff, actor, state and safe errors', async () => {
    const proposal = await payload.create({ collection: 'seo-proposals', data: proposalData, user: editor, overrideAccess: false })
    expect(proposal).toMatchObject({ ...proposalData, state: 'draft' })
    expect(JSON.stringify(proposal)).not.toContain('never-expose-this-fixture-key')
    expect(JSON.stringify(payload.config.collections)).not.toContain('never-expose-this-fixture-key')
    const result = await payload.find({ collection: 'seo-proposals', user: editor, overrideAccess: false })
    expect(result.docs).toContainEqual(expect.objectContaining({ id: proposal.id }))
  })

  test('creating a proposal leaves source content and approved SEO unchanged', async () => {
    const original = await payload.create({ collection: 'posts', locale: 'fr', data: { title: 'Approved content', slug: 'approved', seo: { meta: { title: 'Approved SEO' }, citability: { summary: 'Approved summary' } } } })
    await payload.create({ collection: 'seo-proposals', data: { ...proposalData, sourceID: String(original.id) }, user: editor, overrideAccess: false })
    const after = await payload.findByID({ collection: 'posts', id: original.id, locale: 'fr', depth: 0 })
    expect(after.title).toBe('Approved content')
    expect(after.seo).toEqual(original.seo)
  })

  test('persists run filters, locale selection, progress and per-document failures', async () => {
    const run = await payload.create({
      collection: 'seo-runs', user: manager, overrideAccess: false,
      data: { collections: ['posts'], locales: ['fr', 'en'], filter: { id: { equals: '123' } }, progress: { total: 2, completed: 1, failed: 1 }, errors: [{ sourceCollection: 'posts', sourceID: '123', locale: 'en', code: 'transport', message: 'Provider unavailable' }], usage: { totalTokens: 20 }, actor: { collection: 'users', userID: String(manager.id) } },
    })
    expect(run).toMatchObject({ state: 'queued', collections: ['posts'], locales: ['fr', 'en'], progress: { total: 2, completed: 1, failed: 1 }, usage: { totalTokens: 20 } })
    expect(JSON.stringify(run)).not.toContain('never-expose-this-fixture-key')
  })

  test.each(['seo-proposals', 'seo-runs'])('denies anonymous and viewer CRUD for %s', async (collection) => {
    const data = collection === 'seo-proposals' ? proposalData : { collections: ['posts'], locales: ['fr'] }
    const record = await payload.create({ collection, data })
    for (const user of [undefined, viewer]) {
      await expect(payload.find({ collection, user, overrideAccess: false })).rejects.toThrow()
      await expect(payload.create({ collection, data, user, overrideAccess: false })).rejects.toThrow()
      await expect(payload.update({ collection, id: record.id, data: { state: 'failed' }, user, overrideAccess: false })).rejects.toThrow()
      await expect(payload.delete({ collection, id: record.id, user, overrideAccess: false })).rejects.toThrow()
    }
  })

  test('separates generation and application role permissions', async () => {
    const generatorDoc = (await payload.find({ collection: 'users', where: { role: { equals: 'generator' } } })).docs[0]
    const reviewerDoc = (await payload.find({ collection: 'users', where: { role: { equals: 'reviewer' } } })).docs[0]
    const generator = { ...generatorDoc, collection: 'users' } as NonNullable<PayloadRequest['user']>
    const reviewer = { ...reviewerDoc, collection: 'users' } as NonNullable<PayloadRequest['user']>
    const proposal = await payload.create({ collection: 'seo-proposals', data: proposalData, user: generator, overrideAccess: false })
    await expect(payload.update({ collection: 'seo-proposals', id: proposal.id, data: { state: 'approved' }, user: generator, overrideAccess: false })).rejects.toThrow()
    await expect(payload.create({ collection: 'seo-proposals', data: proposalData, user: reviewer, overrideAccess: false })).rejects.toThrow()
    await expect(payload.find({ collection: 'seo-proposals', user: reviewer, overrideAccess: false })).resolves.toMatchObject({ totalDocs: expect.any(Number) })
    await expect(payload.update({ collection: 'seo-proposals', id: proposal.id, data: { state: 'approved' }, user: reviewer, overrideAccess: false })).resolves.toMatchObject({ state: 'approved' })
  })

  test('validates workflow locale, source collection and state', async () => {
    for (const invalid of [{ locale: 'de' }, { sourceCollection: 'unknown' }, { state: 'unknown' }]) {
      await expect(payload.create({ collection: 'seo-proposals', data: { ...proposalData, ...invalid } })).rejects.toThrow()
    }
  })

  test('requires managers for run scheduling and deletion', async () => {
    await expect(payload.create({ collection: 'seo-runs', data: { collections: ['posts'], locales: ['fr'] }, user: editor, overrideAccess: false })).rejects.toThrow()
    const proposal = await payload.create({ collection: 'seo-proposals', data: proposalData, user: editor, overrideAccess: false })
    await expect(payload.delete({ collection: 'seo-proposals', id: proposal.id, user: editor, overrideAccess: false })).rejects.toThrow()
    await expect(payload.delete({ collection: 'seo-proposals', id: proposal.id, user: manager, overrideAccess: false })).resolves.toMatchObject({ id: proposal.id })
  })
})
