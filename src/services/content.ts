import { createHash } from 'node:crypto'

import type { ValidatedPluginOptions } from '../types.js'

/** Bounds the host's plain-text extraction before sending it to a model. */
const MAX_CONTENT_LENGTH = 50_000

export interface SelectedMediaMetadata {
  id: string | number
  filename?: string
  alt?: string
  caption?: string
  width?: number
  height?: number
}

export interface GenerationInput {
  collection: string
  sourceID: string
  locale: string
  title: string
  content: string
  url?: string
  site: ValidatedPluginOptions['site']
  selectedMedia: SelectedMediaMetadata[]
  /** SHA-256 of the normalized context, excluding the fingerprint itself. */
  fingerprint: string
}

export interface BuildGenerationInputArgs {
  options: ValidatedPluginOptions
  collection: string
  /** Host-loaded document for this locale, with Payload fallback disabled. */
  doc: Record<string, unknown>
  locale: string
  /** Only media explicitly selected by the editor; never inferred from the document. */
  selectedMedia?: readonly Record<string, unknown>[]
}

/** Shared deterministic URL rule for host routing and generated public metadata. */
export const isPublicURL = (value: string): boolean => {
  if (/[\s<>\u0000-\u001f\u007f]/u.test(value)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch {
    return false
  }
}

const normalizeText = (value: string): string => value.replace(/\s+/gu, ' ').replace(/[\u0000-\u0008\u000e-\u001f\u007f]/gu, '').trim()

const localizedText = (value: unknown, locale: string): string | undefined => {
  const localized = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[locale]
    : value
  return typeof localized === 'string' ? normalizeText(localized) : undefined
}

const normalizeMedia = (media: Record<string, unknown>, locale: string): SelectedMediaMetadata => {
  const { id } = media
  if ((typeof id !== 'string' || !id.trim()) && (typeof id !== 'number' || !Number.isFinite(id))) {
    throw new Error('Selected media must have a string or numeric id.')
  }
  const result: SelectedMediaMetadata = { id: id as string | number }
  for (const key of ['filename', 'alt', 'caption'] as const) {
    const text = localizedText(media[key], locale)
    if (text !== undefined) result[key] = text
  }
  for (const key of ['width', 'height'] as const) {
    const dimension = media[key]
    if (typeof dimension === 'number' && Number.isInteger(dimension) && dimension > 0) result[key] = dimension
  }
  return result
}

/** No Payload queries or transport: adapters alone define the locale's source context. */
export const buildGenerationInput = async ({
  options, collection, doc, locale, selectedMedia = [],
}: BuildGenerationInputArgs): Promise<GenerationInput> => {
  const adapter = options.collections[collection]
  if (!adapter) throw new Error('Unknown SEO source collection.')
  if (!options.locales.includes(locale)) throw new Error('Unsupported SEO locale.')
  if ((typeof doc.id !== 'string' || !doc.id.trim()) && (typeof doc.id !== 'number' || !Number.isFinite(doc.id))) {
    throw new Error('SEO source document must have a string or numeric id.')
  }

  const extracted = await adapter.extractContent({ doc, locale })
  const resolved = await adapter.resolveURL({ doc, locale })
  if (typeof extracted !== 'string') throw new Error('extractContent must return plain text.')
  const url = typeof resolved === 'string' ? resolved.trim() || undefined : undefined
  if (url && !isPublicURL(url)) throw new Error('resolveURL must return an absolute HTTP or HTTPS URL without credentials.')

  // Project every value explicitly: no config secrets, approved SEO, or media relations.
  const context: Omit<GenerationInput, 'fingerprint'> = {
    collection,
    sourceID: String(doc.id),
    locale,
    title: localizedText(doc[adapter.titleField], locale) ?? '',
    content: normalizeText(extracted).slice(0, MAX_CONTENT_LENGTH),
    ...(url ? { url } : {}),
    site: {
      defaultLocale: options.site.defaultLocale,
      organization: {
        name: normalizeText(options.site.organization.name),
        url: options.site.organization.url,
      },
    },
    selectedMedia: selectedMedia.map((media) => normalizeMedia(media, locale)),
  }
  return {
    ...context,
    fingerprint: createHash('sha256').update(JSON.stringify(context)).digest('hex'),
  }
}
