import type { Metadata } from 'next'
import { describe, expect, test } from 'vitest'

import { buildJsonLd, buildMetadata, type SeoFields } from '../../src/helpers/metadata.js'

const frSeo: SeoFields = {
  meta: {
    title: 'Titre', description: 'Description',
    canonical: 'https://example.com/fr/article', robots: 'index, follow',
  },
  social: {
    image: { id: 42, url: '/media/a.jpg', alt: 'Ancien texte', width: 1200, height: 630 },
    imageAlt: 'Photo française', ogTitle: 'Titre social', twitterCard: 'summary_large_image',
    recommendedWidth: 400, recommendedHeight: 400,
  },
  schema: [{ '@context': 'https://schema.org', '@type': 'Article', headline: 'Titre' }],
}

describe('approved localized frontend helpers', () => {
  test('maps resolved approved fields to Next-compatible metadata', () => {
    const metadata: Metadata = buildMetadata(frSeo)
    expect(metadata).toMatchObject({
      title: 'Titre', description: 'Description', robots: 'index, follow',
      alternates: { canonical: 'https://example.com/fr/article' },
      openGraph: {
        title: 'Titre social', description: 'Description', url: 'https://example.com/fr/article',
        images: [{ url: '/media/a.jpg', alt: 'Photo française', width: 1200, height: 630 }],
      },
      twitter: {
        card: 'summary_large_image', title: 'Titre social', description: 'Description',
        images: [{ url: '/media/a.jpg', alt: 'Photo française', width: 1200, height: 630 }],
      },
    })
  })

  test('does not invent images from relationship IDs, filenames or recommended dimensions', () => {
    for (const image of [42, '42', null, { id: 42, url: null }]) {
      const metadata = buildMetadata({ social: { image, imageFilename: 'invented.jpg', recommendedWidth: 1200 } })
      expect(metadata.openGraph).toBeUndefined()
      expect(metadata.twitter).toBeUndefined()
    }
  })

  test('handles incomplete or cleared Payload groups without defaults from another locale', () => {
    expect(buildMetadata({})).toEqual({})
    expect(buildMetadata({ meta: null, social: null, schema: null })).toEqual({})
    expect(buildMetadata({ meta: { title: '' }, social: { image: { url: '' } } })).toEqual({})
    expect(buildMetadata({ meta: { title: 'English title' } })).toEqual({
      title: 'English title', openGraph: { title: 'English title' }, twitter: { title: 'English title' },
    })
  })

  test('uses resolved media metadata when no approved image alt override exists', () => {
    expect(buildMetadata({ social: { image: { url: 'https://example.com/a.jpg', alt: 'Media alt' } } }))
      .toMatchObject({ openGraph: { images: [{ url: 'https://example.com/a.jpg', alt: 'Media alt' }] } })
  })

  test('returns only cloned approved JSON-LD and handles no graphs', () => {
    const graphs = buildJsonLd(frSeo)
    expect(graphs).toEqual([expect.objectContaining({ '@context': 'https://schema.org' })])
    expect(graphs).not.toBe(frSeo.schema)
    graphs[0].headline = 'Changed'
    expect(frSeo.schema?.[0].headline).toBe('Titre')
    expect(buildJsonLd({ ...frSeo, schema: [] })).toEqual([])
    expect(buildJsonLd({ schema: null })).toEqual([])
    expect(buildJsonLd({})).toEqual([])
  })

  test('never reads a proposal output or runs generation while rendering', () => {
    const proposal = { output: frSeo }
    expect(buildMetadata(proposal as SeoFields)).toEqual({})
    expect(buildJsonLd(proposal as SeoFields)).toEqual([])
  })
})
