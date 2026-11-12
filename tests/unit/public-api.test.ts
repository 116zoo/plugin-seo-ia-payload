import { expect, test } from 'vitest'

import { nimSeoPlugin } from '../../src/index.js'

const validOptions = {
  collections: {
    posts: {
      titleField: 'title',
      extractContent: ({ doc }: { doc: Record<string, unknown> }) => String(doc.content ?? ''),
      resolveURL: ({ doc, locale }: { doc: Record<string, unknown>; locale: string }) =>
        `https://example.com/${locale}/posts/${String(doc.slug)}`,
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
    organization: { name: 'Fixture', url: 'https://example.com' },
  },
  permissions: {
    generate: () => false,
    apply: () => false,
    manage: () => false,
  },
}

test('exports a Payload plugin factory', () => {
  expect(nimSeoPlugin(validOptions)).toBeTypeOf('function')
})
