import type { PayloadRequest } from 'payload'

/** The host owns content extraction and localized public routing. */
export interface CollectionSeoOptions {
  titleField: string
  extractContent: (args: {
    doc: Record<string, unknown>
    locale: string
  }) => string | Promise<string>
  resolveURL: (args: {
    doc: Record<string, unknown>
    locale: string
  }) => string | null | undefined | Promise<string | null | undefined>
  mediaCollection: string
}

/** Server-only configuration: never pass this object to client components. */
export interface NimConfig {
  baseURL: string
  apiKey: string
  model: string
}

export interface NimSeoPluginOptions {
  collections: Record<string, CollectionSeoOptions>
  locales: string[]
  nim: NimConfig
  site: {
    defaultLocale: string
    organization: {
      name: string
      url: string
    }
  }
  permissions: {
    generate: (args: { req: PayloadRequest }) => boolean | Promise<boolean>
    apply: (args: { req: PayloadRequest }) => boolean | Promise<boolean>
    manage: (args: { req: PayloadRequest }) => boolean | Promise<boolean>
  }
  /** Enable bulk jobs; requires the host to configure Payload jobs. */
  bulk?: boolean
}

/** Unapplied proposal data, reviewed by an editor before becoming approved SEO. */
export interface SeoProposalPayload {
  meta: {
    title: string
    description: string
    canonical?: string
    robots?: string
    focusKeyphrase?: string
  }
  social: {
    image?: string | number
    imageAlt?: string
    imageFilename?: string
    imageCaption?: string
    recommendedWidth?: number
    recommendedHeight?: number
    ogTitle?: string
    ogDescription?: string
    twitterCard?: 'summary' | 'summary_large_image'
  }
  schema: Record<string, unknown>[]
  citability: {
    /** Limited to 2,000 characters by the proposal validator in Task 4. */
    summary: string
    sources?: string[]
    claims?: string[]
  }
}
