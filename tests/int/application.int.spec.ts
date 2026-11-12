import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { buildConfig, createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { nimSeoPlugin } from '../../src/index.js'
import { applyProposal, createProposal } from '../../src/services/proposals.js'
import type { SeoProposalPayload, ValidatedPluginOptions } from '../../src/types.js'

let payload: Payload
let databaseDir: string
let user: NonNullable<PayloadRequest['user']>
const allowed = ({ req }: { req: PayloadRequest }) => Boolean(req.user)
const options: ValidatedPluginOptions = {
  collections: { posts: { titleField: 'title', mediaCollection: 'media', extractContent: ({ doc }) => String(doc.content), resolveURL: ({ locale }) => `https://site.test/${locale}/post` } },
  locales: ['fr', 'en'], bulk: false,
  nim: { baseURL: 'https://nim.test/v1', apiKey: 'test-only-key', model: 'fixture' },
  site: { defaultLocale: 'fr', organization: { name: 'Site', url: 'https://site.test' } },
  permissions: { generate: allowed, apply: allowed, manage: allowed },
}
const output: SeoProposalPayload = {
  meta: { title: 'Proposed title', description: 'Proposed description' },
  social: {}, schema: [], citability: { summary: 'Proposed summary' },
}

beforeAll(async () => {
  databaseDir = await mkdtemp(path.join(os.tmpdir(), 'nim-seo-application-'))
  payload = await getPayload({ config: buildConfig({
    secret: 'application-integration-only-secret',
    email: () => ({ name: 'test', defaultFromAddress: 'test@example.test', defaultFromName: 'Test', sendEmail: async () => undefined }),
    db: sqliteAdapter({ client: { url: `file:${path.join(databaseDir, 'test.db')}` }, transactionOptions: {} }),
    localization: { locales: ['fr', 'en'], defaultLocale: 'fr', fallback: false },
    collections: [
      { slug: 'users', auth: true, fields: [] },
      { slug: 'media', fields: [] },
      {
        slug: 'posts', versions: { drafts: true },
        fields: [{ name: 'title', type: 'text', localized: true }, { name: 'content', type: 'textarea', localized: true }],
      },
    ], plugins: [nimSeoPlugin(options), (config) => {
      const proposals = config.collections!.find(({ slug }) => slug === 'seo-proposals')!
      proposals.hooks = { beforeChange: [({ data, req }) => {
        if (data.state === 'applied' && req.context.failApplication) throw new Error('Application bookkeeping rejected')
      }] }
      return config
    }],
  }) })
  const saved = await payload.create({ collection: 'users', data: { email: 'editor@example.test', password: 'fixture-password' } })
  user = { ...saved, collection: 'users' } as NonNullable<PayloadRequest['user']>
}, 30_000)

afterAll(async () => {
  await payload?.destroy()
  if (databaseDir) await rm(databaseDir, { recursive: true, force: true })
})

const setup = async () => {
  const original = {
    meta: { title: 'Original title', description: 'Original description', canonical: 'https://site.test/old', robots: 'noindex' },
    social: { ogTitle: 'Keep social' },
    schema: [{ '@type': 'Organization', name: 'Keep schema' }], citability: { summary: 'Keep summary' },
    status: { completeness: 'incomplete' },
  }
  const post = await payload.create({ collection: 'posts', locale: 'fr', data: { title: 'Titre FR', content: 'Contenu FR', seo: original, _status: 'published' } })
  await payload.update({ collection: 'posts', id: post.id, locale: 'en', data: { title: 'Title EN', content: 'Content EN', seo: original, _status: 'published' } })
  const req = await createLocalReq({ user }, payload)
  const doc = await payload.findByID({ collection: 'posts', id: post.id, locale: 'en', fallbackLocale: false, draft: true, depth: 0 })
  const proposal = await createProposal({ options, req, doc, collection: 'posts', locale: 'en', client: { generate: async () => output } })
  return { req, post, proposal, doc }
}

describe('real localized selective application', () => {
  test('replaces selected draft groups without touching other groups, locales, source content or published values', async () => {
    const { req, post, proposal, doc } = await setup()
    const frenchBefore = await payload.findByID({ collection: 'posts', id: post.id, locale: 'fr', fallbackLocale: false, draft: true, depth: 0 })
    await applyProposal({ options, req, proposal, locale: 'en', groups: ['meta'] })
    const draft = await payload.findByID({ collection: 'posts', id: post.id, locale: 'en', fallbackLocale: false, draft: true, depth: 0 })
    expect(draft.seo.meta).toMatchObject(output.meta)
    expect(draft.seo.meta.canonical).toBeNull()
    expect(draft.seo.meta.robots).toBeNull()
    for (const group of ['social', 'schema', 'citability', 'status']) expect(draft.seo[group]).toEqual(doc.seo[group])
    expect(draft.title).toBe('Title EN')
    expect(draft.content).toBe('Content EN')
    const published = await payload.findByID({ collection: 'posts', id: post.id, locale: 'en', fallbackLocale: false, draft: false, depth: 0 })
    expect(published.seo).toEqual(doc.seo)
    const frenchAfter = await payload.findByID({ collection: 'posts', id: post.id, locale: 'fr', fallbackLocale: false, draft: true, depth: 0 })
    expect(frenchAfter.seo).toEqual(frenchBefore.seo)
    expect(frenchAfter.title).toBe('Titre FR')
    const applied = await payload.findByID({ collection: 'seo-proposals', id: proposal.id, depth: 0 })
    expect(applied).toMatchObject({ state: 'applied', actor: { collection: 'users', userID: String(user.id) }, appliedAt: expect.any(String) })
    await expect(applyProposal({ options, req, proposal, locale: 'en', groups: ['citability'] })).rejects.toThrow(/draft/i)
  })

  test('detects edits in the latest draft even while the published source still matches the generation snapshot', async () => {
    const { req, post, proposal, doc } = await setup()
    await payload.update({ collection: 'posts', id: post.id, locale: 'en', draft: true, data: { content: 'Changed draft content' } })
    await expect(applyProposal({ options, req, proposal, locale: 'en', groups: ['meta'] })).rejects.toThrow(/stale/i)
    const draft = await payload.findByID({ collection: 'posts', id: post.id, locale: 'en', draft: true, depth: 0 })
    expect(draft.seo).toEqual(doc.seo)
    expect((await payload.findByID({ collection: 'seo-proposals', id: proposal.id })).state).toBe('draft')
  })

  test('rolls back approved SEO if a Payload hook rejects application bookkeeping', async () => {
    const { req, post, proposal, doc } = await setup()
    req.context.failApplication = true
    await expect(applyProposal({ options, req, proposal, locale: 'en', groups: ['meta'] })).rejects.toThrow('Application bookkeeping rejected')
    const draft = await payload.findByID({ collection: 'posts', id: post.id, locale: 'en', draft: true, depth: 0 })
    expect(draft.seo).toEqual(doc.seo)
    expect((await payload.findByID({ collection: 'seo-proposals', id: proposal.id })).state).toBe('draft')
  })
})
