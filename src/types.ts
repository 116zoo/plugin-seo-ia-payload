import type { Field, PayloadRequest } from 'payload'

/** A relationship/upload policy. Creation is always an explicit host decision. */
export interface EditorialRelationOptions {
  relationTo: string | readonly string[]
  allowCreate: boolean
}

export interface EditorialFieldOptions {
  /** Exact schema paths, without document array indexes or wildcards. */
  include: readonly string[]
  /** Removes an exact path and its descendants; content is always forbidden. */
  exclude?: readonly string[]
  relations?: Record<string, EditorialRelationOptions>
}

export type EditorialFieldType = 'text' | 'textarea' | 'richText' | 'number' | 'date'
  | 'checkbox' | 'select' | 'relationship' | 'upload' | 'group' | 'array' | 'blocks'

/** Schema metadata for server-side value validation, never client-provided. */
export interface EditorialField {
  path: string
  type: EditorialFieldType
  field: Field
  ancestors: { path: string; type: 'group' | 'array' | 'blocks'; blockSlug?: string }[]
  /** Whole-container patches must validate every nested value against these children. */
  children?: EditorialField[]
  relation?: EditorialRelationOptions
}

export interface EditorialRegistry {
  collection: string
  fields: EditorialField[]
  exclude: readonly string[]
  relations: Record<string, EditorialRelationOptions>
}

/** The host owns content extraction and localized public routing. */
export interface CollectionSeoOptions {
  titleField: string
  /** All translatable source fields read by the adapters, including titleField. */
  localizedSourceFields: readonly string[]
  extractContent: (args: {
    doc: Record<string, unknown>
    locale: string
  }) => string | Promise<string>
  resolveURL: (args: {
    doc: Record<string, unknown>
    locale: string
  }) => string | null | undefined | Promise<string | null | undefined>
  mediaCollection: string
  /** Opt-in AI field proposals; omitted means SEO-only behavior. */
  editorialFields?: EditorialFieldOptions
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
  /** Enable bulk jobs; defaults to false and requires host-configured Payload jobs. */
  bulk?: boolean
}

/** Host-compatible options with optional settings resolved to their defaults. */
export interface ValidatedPluginOptions extends NimSeoPluginOptions {
  bulk: boolean
  /** Startup-resolved host schema, consumed by server workflows only. */
  editorialRegistries: Record<string, EditorialRegistry>
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
