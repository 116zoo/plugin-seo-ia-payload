import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { buildConfig, type CollectionConfig, type PayloadRequest } from 'payload'

import { nimSeoPlugin } from '../src/index.js'
import { Posts } from './collections/Posts.js'

const fixtureDir = path.dirname(fileURLToPath(import.meta.url))

const Media: CollectionConfig = {
  slug: 'media',
  upload: { staticDir: path.join(fixtureDir, 'media') },
  fields: [{ name: 'alt', type: 'text', localized: true }],
}

const isEditor = ({ req }: { req: PayloadRequest }): boolean =>
  req.user?.role === 'editor' || req.user?.role === 'admin'
const isManager = ({ req }: { req: PayloadRequest }): boolean => req.user?.role === 'admin'

export default buildConfig({
  secret: process.env.PAYLOAD_SECRET ?? 'local-fixture-only-do-not-use-in-production',
  db: sqliteAdapter({
    client: { url: process.env.DATABASE_URL ?? `file:${path.join(fixtureDir, 'fixture.db')}` },
  }),
  localization: {
    locales: ['fr', 'en'],
    defaultLocale: 'fr',
    fallback: false,
  },
  collections: [
    {
      slug: 'users', auth: true,
      fields: [{
        name: 'role', type: 'select', options: ['viewer', 'editor', 'admin'], defaultValue: 'viewer',
        access: {
          create: isManager,
          update: isManager,
        },
      }],
    },
    Media,
    Posts,
  ],
  jobs: { tasks: [] },
  plugins: [
    nimSeoPlugin({
      collections: {
        posts: {
          titleField: 'title',
          extractContent: ({ doc }) => String(doc.content ?? '').slice(0, 10_000),
          resolveURL: ({ doc, locale }) =>
            typeof doc.slug === 'string'
              ? `https://example.test/${locale}/posts/${encodeURIComponent(doc.slug)}`
              : undefined,
          mediaCollection: 'media',
        },
      },
      locales: ['fr', 'en'],
      nim: {
        baseURL: process.env.NIM_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
        apiKey: process.env.NIM_API_KEY ?? 'fixture-placeholder-no-network',
        model: process.env.NIM_MODEL ?? 'fixture-model',
      },
      site: {
        defaultLocale: 'fr',
        organization: { name: 'Local SEO fixture', url: 'https://example.test' },
      },
      permissions: { generate: isEditor, apply: isEditor, manage: isManager },
    }),
  ],
  typescript: { outputFile: path.join(fixtureDir, 'payload-types.ts') },
})
