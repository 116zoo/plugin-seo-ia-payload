import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { buildConfig, createLocalReq, getPayload, type PayloadRequest } from 'payload'
import { vi } from 'vitest'
import { nimSeoPlugin } from '../../src/index.js'
import type { ValidatedPluginOptions } from '../../src/types.js'

export const output = { meta: { title: 'Proposed title', description: 'Proposed description' }, social: {}, schema: [], citability: { summary: 'Proposed summary' } }
export const fixture = async (bulk = true) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nim-seo-endpoints-'))
  const hasRole = (...roles: string[]) => ({ req }: { req: PayloadRequest }) => roles.includes(String(req.user?.role))
  const options: ValidatedPluginOptions = {
    collections: { posts: { titleField: 'title', mediaCollection: 'media', extractContent: ({ doc }) => String(doc.content ?? ''), resolveURL: ({ locale }) => `https://site.test/${locale}/post` } },
    locales: ['fr', 'en'], bulk,
    nim: { baseURL: 'https://nim.test/v1', apiKey: 'fixture-key-do-not-leak', model: 'fixture' },
    site: { defaultLocale: 'fr', organization: { name: 'Fixture', url: 'https://site.test' } },
    permissions: { generate: hasRole('editor', 'generator'), apply: hasRole('editor', 'reviewer'), manage: hasRole('manager') },
  }
  const payload = await getPayload({ config: buildConfig({
    secret: 'endpoint-integration-only-secret',
    email: () => ({ name: 'test', defaultFromAddress: 'test@example.test', defaultFromName: 'Test', sendEmail: async () => undefined }),
    db: sqliteAdapter({ client: { url: `file:${path.join(directory, 'test.db')}` }, transactionOptions: {} }),
    localization: { locales: ['fr', 'en'], defaultLocale: 'fr', fallback: false },
    jobs: { access: { queue: hasRole('manager'), run: () => false }, tasks: [{ slug: 'host-task', handler: async () => ({ output: {} }) }] },
    collections: [
      { slug: 'users', auth: true, fields: [{ name: 'role', type: 'text' }] },
      { slug: 'media', fields: [{ name: 'alt', type: 'text', localized: true }] },
      { slug: 'posts', versions: { drafts: true }, access: { read: ({ req }) => Boolean(req.user) && { title: { not_equals: 'Hidden' } } }, fields: [{ name: 'title', type: 'text', localized: true }, { name: 'content', type: 'textarea', localized: true }] },
    ], plugins: [nimSeoPlugin(options)],
  }) })
  const users: Record<string, NonNullable<PayloadRequest['user']>> = {}
  for (const role of ['viewer', 'editor', 'manager', 'generator', 'reviewer']) {
    const doc = await payload.create({ collection: 'users', data: { email: `${role}@example.test`, password: 'fixture-password', role } })
    users[role] = { ...doc, collection: 'users' } as NonNullable<PayloadRequest['user']>
  }
  const request = async (role?: string, body: unknown = {}) => {
    const req = await createLocalReq({ user: role ? users[role] : undefined }, payload)
    req.json = async () => body
    return req
  }
  const post = async (title = 'Titre FR') => {
    const doc = await payload.create({ collection: 'posts', locale: 'fr', data: { title, content: 'Contenu FR', seo: { meta: { title: 'Approved FR' }, citability: { summary: 'Approved summary FR' } }, _status: 'published' } })
    await payload.update({ collection: 'posts', id: doc.id, locale: 'en', data: { title: title === 'Hidden' ? title : 'Title EN', content: 'Content EN', seo: { meta: { title: 'Approved EN' } }, _status: 'published' } })
    return doc
  }
  const transport = vi.fn(async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }))
  vi.stubGlobal('fetch', transport)
  return { payload, options, users, request, post, transport, cleanup: async () => { vi.unstubAllGlobals(); await payload.destroy(); await rm(directory, { recursive: true, force: true }) } }
}
