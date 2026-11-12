import { describe, expect, test } from 'vitest'

import { buildGenerationInput, type BuildGenerationInputArgs } from '../../src/services/content.js'
import type { ValidatedPluginOptions } from '../../src/types.js'

const options: ValidatedPluginOptions = {
  collections: {
    posts: {
      titleField: 'title', mediaCollection: 'media',
      extractContent: async ({ doc, locale }) => (doc.content as Record<string, string>)[locale] ?? '',
      resolveURL: async ({ doc, locale }) => {
        const slug = (doc.slug as Record<string, string>)[locale]
        return slug ? `https://site.test/${locale}/${slug}` : undefined
      },
    },
  },
  locales: ['fr', 'en'], bulk: false,
  nim: { baseURL: 'https://nim.test/v1', apiKey: 'private-fixture-key', model: 'fixture' },
  site: { defaultLocale: 'fr', organization: { name: ' Site ', url: 'https://site.test' } },
  permissions: { generate: () => true, apply: () => true, manage: () => true },
}
const makeArgs = (): BuildGenerationInputArgs => ({
  options, collection: 'posts', locale: 'fr',
  doc: {
    id: 12, title: { fr: ' Bonjour\n monde ', en: 'Hello' },
    content: { fr: ' Texte\r\n français.  ', en: 'English content.' },
    slug: { fr: 'x', en: 'hello' },
    seo: { meta: { title: 'Approved SEO' } },
    media: [{ id: 'unselected-media-id', filename: 'private.jpg' }],
  },
  selectedMedia: [{
    id: 'selected', filename: ' photo.jpg ', alt: { fr: ' Photo FR ', en: 'Photo EN' },
    caption: { fr: ' Légende ', en: 'Caption' }, width: 1200, height: 630,
    url: 'https://private.test/file', secret: 'never-send', related: { id: 'unselected-media-id' },
  }],
})

describe('buildGenerationInput', () => {
  test('normalizes only the requested locale and explicitly selected media metadata', async () => {
    const args = makeArgs()
    const original = structuredClone(args.doc)
    const input = await buildGenerationInput(args)
    expect(input).toMatchObject({
      collection: 'posts', sourceID: '12', locale: 'fr', title: 'Bonjour monde',
      content: 'Texte français.', url: 'https://site.test/fr/x',
      selectedMedia: [{ id: 'selected', filename: 'photo.jpg', alt: 'Photo FR', caption: 'Légende', width: 1200, height: 630 }],
      site: { defaultLocale: 'fr', organization: { name: 'Site', url: 'https://site.test' } },
    })
    const serialized = JSON.stringify(input)
    for (const excluded of ['private-fixture-key', 'never-send', 'unselected-media-id', 'Approved SEO', 'English content.', 'Photo EN', 'private.test']) {
      expect(serialized).not.toContain(excluded)
    }
    expect(args.doc).toEqual(original)
  })

  test('uses English adapters when requested without copying missing localized titles or media', async () => {
    const args = makeArgs()
    args.locale = 'en'
    args.doc.title = { fr: 'Français uniquement' }
    args.selectedMedia = [{ id: 2, alt: { fr: 'Français uniquement' }, caption: { fr: 'Légende FR' } }]
    const input = await buildGenerationInput(args)
    expect(input).toMatchObject({ locale: 'en', content: 'English content.', title: '', url: 'https://site.test/en/hello', selectedMedia: [{ id: 2 }] })
    expect(JSON.stringify(input)).not.toContain('Français uniquement')
  })

  test.each([null, undefined, '', '   '])('omits absent resolved URLs (%s)', async (url) => {
    const args = makeArgs()
    args.options = { ...options, collections: { posts: { ...options.collections.posts, resolveURL: () => url } } }
    expect((await buildGenerationInput(args)).url).toBeUndefined()
  })

  test('does not infer selected media from the document', async () => {
    const args = makeArgs()
    delete args.selectedMedia
    expect((await buildGenerationInput(args)).selectedMedia).toEqual([])
  })

  test('fingerprints normalized context deterministically and detects meaningful source changes', async () => {
    const args = makeArgs()
    const first = await buildGenerationInput(args)
    const reordered = { ...args, doc: { ...args.doc, title: { en: 'Hello', fr: 'Bonjour monde' }, seo: { meta: { title: 'Changed approved SEO' } } } }
    expect((await buildGenerationInput(reordered)).fingerprint).toBe(first.fingerprint)
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    for (const change of [
      { ...args, locale: 'en' },
      { ...args, doc: { ...args.doc, content: { fr: 'Changed source' } } },
      { ...args, selectedMedia: [{ id: 'another-selected' }] },
      { ...args, options: { ...options, site: { ...options.site, organization: { ...options.site.organization, name: 'New site' } } } },
    ]) {
      expect((await buildGenerationInput(change)).fingerprint).not.toBe(first.fingerprint)
    }
  })

  test('bounds host-extracted content before fingerprinting', async () => {
    const args = makeArgs()
    args.doc.content = { fr: 'x'.repeat(50_001) }
    expect((await buildGenerationInput(args)).content).toHaveLength(50_000)
  })

  test.each(['javascript:alert(1)', '/relative', 'https://user:password@site.test/x'])('rejects unsafe resolved URLs (%s)', async (url) => {
    const args = makeArgs()
    args.options = { ...options, collections: { posts: { ...options.collections.posts, resolveURL: () => url } } }
    await expect(buildGenerationInput(args)).rejects.toThrow(/url/i)
  })

  test('rejects unknown collections and locales before extraction', async () => {
    await expect(buildGenerationInput({ ...makeArgs(), collection: 'unknown' })).rejects.toThrow(/collection/i)
    await expect(buildGenerationInput({ ...makeArgs(), locale: 'de' })).rejects.toThrow(/locale/i)
  })
})
