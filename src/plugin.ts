import type { Config, Plugin } from 'payload'

import { buildProposalsCollection } from './collections/proposals.js'
import { buildRunsCollection } from './collections/runs.js'
import { buildSeoFields } from './fields/seoFields.js'

import type { NimSeoPluginOptions, ValidatedPluginOptions } from './types.js'

const configurationError = (message: string): Error =>
  new Error(`[payload-plugin-nim-seo] ${message}`)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

/** Validate the unsanitized host config before Payload initializes the plugin. */
export const validatePluginOptions = (
  options: NimSeoPluginOptions,
  config: Config,
): ValidatedPluginOptions => {
  const collections = Object.entries(options.collections ?? {})
  if (collections.length === 0) {
    throw configurationError('collections must configure at least one target collection.')
  }

  const hostCollections = new Set(config.collections?.map(({ slug }) => slug))
  for (const [slug, collection] of collections) {
    if (!hostCollections.has(slug)) {
      throw configurationError(`${slug}: target collection must exist in Payload collections.`)
    }
    for (const field of ['titleField', 'mediaCollection'] as const) {
      if (!isNonEmptyString(collection?.[field])) {
        throw configurationError(`${slug}.${field} must be a non-empty string.`)
      }
    }
    for (const field of ['extractContent', 'resolveURL'] as const) {
      if (typeof collection?.[field] !== 'function') {
        throw configurationError(`${slug}.${field} must be a function.`)
      }
    }
    if (!hostCollections.has(collection.mediaCollection)) {
      throw configurationError(
        `${slug}.mediaCollection: ${collection.mediaCollection} must exist in Payload collections.`,
      )
    }
  }

  if (!Array.isArray(options.locales) || options.locales.length === 0) {
    throw configurationError('locales must contain at least one Payload localization locale.')
  }
  const hostLocales = new Set(
    config.localization
      ? config.localization.locales.map((locale) => typeof locale === 'string' ? locale : locale.code)
      : [],
  )
  for (const locale of options.locales) {
    if (!isNonEmptyString(locale) || !hostLocales.has(locale)) {
      throw configurationError(
        `${locale}: locale must be enabled in Payload localization.locales.`,
      )
    }
  }

  for (const field of ['baseURL', 'apiKey', 'model'] as const) {
    if (!isNonEmptyString(options.nim?.[field])) {
      throw configurationError(`nim.${field} must be a non-empty string.`)
    }
  }
  let baseURL: URL
  try {
    baseURL = new URL(options.nim.baseURL)
  } catch {
    throw configurationError('nim.baseURL must be an absolute HTTP or HTTPS URL.')
  }
  if (baseURL.protocol !== 'http:' && baseURL.protocol !== 'https:') {
    throw configurationError('nim.baseURL must be an absolute HTTP or HTTPS URL.')
  }

  const bulk = options.bulk ?? false
  if (bulk && !config.jobs) {
    throw configurationError('bulk requires Payload jobs configuration; configure jobs or disable bulk.')
  }

  return { ...options, bulk }
}

/** Add SEO models without mutating the host's collection/config objects. */
export const nimSeoPlugin = (options: NimSeoPluginOptions): Plugin => (config) => {
  const validated = validatePluginOptions(options, config)
  const collections = (config.collections ?? []).map((collection) => {
    const target = validated.collections[collection.slug]
    if (!target || collection.fields.some((field) => 'name' in field && field.name === 'seo')) {
      return collection
    }
    return {
      ...collection,
      fields: [...collection.fields, ...buildSeoFields({
        ...validated,
        collections: { [collection.slug]: target },
      })],
    }
  })
  for (const build of [buildProposalsCollection, buildRunsCollection]) {
    const internal = build(validated)
    if (!collections.some(({ slug }) => slug === internal.slug)) collections.push(internal)
  }
  return { ...config, collections }
}
