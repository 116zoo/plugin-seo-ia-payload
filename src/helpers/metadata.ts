/** Approved SEO from one explicitly loaded Payload locale, never a proposal output. */
export interface SeoFields {
  meta?: {
    title?: string | null
    description?: string | null
    canonical?: string | null
    robots?: string | null
    focusKeyphrase?: string | null
  } | null
  social?: {
    /** Populate the media relationship (depth >= 1); unresolved IDs are not URLs. */
    image?: string | number | {
      id?: string | number
      url?: string | null
      alt?: string | null
      width?: number | null
      height?: number | null
    } | null
    imageAlt?: string | null
    imageFilename?: string | null
    imageCaption?: string | null
    recommendedWidth?: number | null
    recommendedHeight?: number | null
    ogTitle?: string | null
    ogDescription?: string | null
    twitterCard?: 'summary' | 'summary_large_image' | null
  } | null
  schema?: Record<string, unknown>[] | null
  citability?: {
    summary?: string | null
    sources?: string[] | null
    claims?: string[] | null
  } | null
  status?: {
    lastValidatedAt?: string | null
    completeness?: 'incomplete' | 'complete' | null
    warnings?: string[] | null
  } | null
}

export interface MetadataImage {
  url: string
  alt?: string
  width?: number
  height?: number
}

/** Framework-independent subset assignable to Next.js Metadata. */
export interface MetadataLike {
  title?: string
  description?: string
  robots?: string
  alternates?: { canonical: string }
  openGraph?: { title?: string; description?: string; url?: string; images?: MetadataImage[] }
  twitter?: { card?: 'summary' | 'summary_large_image'; title?: string; description?: string; images?: MetadataImage[] }
}

const text = (value: string | null | undefined): string | undefined => value?.trim() ? value : undefined
const dimension = (value: number | null | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

/** Pure mapping: no fetching, locale fallback, generation, or proposal application. */
export const buildMetadata = (seo: SeoFields): MetadataLike => {
  const title = text(seo.meta?.title)
  const description = text(seo.meta?.description)
  const canonical = text(seo.meta?.canonical)
  const robots = text(seo.meta?.robots)
  const socialTitle = text(seo.social?.ogTitle) ?? title
  const socialDescription = text(seo.social?.ogDescription) ?? description
  const card = seo.social?.twitterCard ?? undefined
  const media = seo.social?.image
  const url = media && typeof media === 'object' ? text(media.url) : undefined
  const images: MetadataImage[] | undefined = url && media && typeof media === 'object' ? [{
    url,
    ...(text(seo.social?.imageAlt) ?? text(media.alt) ? { alt: text(seo.social?.imageAlt) ?? text(media.alt) } : {}),
    ...(dimension(media.width) ? { width: dimension(media.width) } : {}),
    ...(dimension(media.height) ? { height: dimension(media.height) } : {}),
  }] : undefined
  const social = {
    ...(socialTitle ? { title: socialTitle } : {}),
    ...(socialDescription ? { description: socialDescription } : {}),
    ...(images ? { images } : {}),
  }
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(robots ? { robots } : {}),
    ...(canonical ? { alternates: { canonical } } : {}),
    ...(Object.keys(social).length || canonical ? { openGraph: { ...social, ...(canonical ? { url: canonical } : {}) } } : {}),
    ...(Object.keys(social).length || card ? { twitter: { ...social, ...(card ? { card } : {}) } } : {}),
  }
}

/** Return independent approved JSON-LD graphs. Escape '<' when serializing into HTML. */
export const buildJsonLd = (seo: SeoFields): Record<string, unknown>[] =>
  structuredClone(seo.schema ?? [])
