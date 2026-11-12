import type { Config, Field, Plugin } from 'payload'

import { buildProposalsCollection } from './collections/proposals.js'
import { buildRunsCollection } from './collections/runs.js'
import { buildSeoFields } from './fields/seoFields.js'
import { generateProposalEndpoint } from './endpoints/generate.js'
import { applyProposalEndpoint } from './endpoints/apply.js'
import { auditEndpoint } from './endpoints/audit.js'
import { adminCapabilitiesEndpoint } from './endpoints/admin.js'
import { generateProposalTask } from './jobs/generateProposal.js'
import { runAuditTask } from './jobs/runAudit.js'

import type { NimSeoPluginOptions, ValidatedPluginOptions } from './types.js'

const configurationError = (message: string): Error =>
  new Error(`[payload-plugin-nim-seo] ${message}`)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

/** Resolve configuration paths, retaining namespaces but ignoring layout-only wrappers. */
const findSourceField = (
  fields: Field[],
  path: readonly string[],
  config: Config,
): { localized?: boolean } | undefined => {
  for (const field of fields) {
    if (field.type === 'tabs') {
      for (const tab of field.tabs) {
        const named = 'name' in tab && Boolean(tab.name)
        if (named && tab.name !== path[0]) continue
        if (named && path.length === 1) return tab
        const match = findSourceField(tab.fields, named ? path.slice(1) : path, config)
        if (match) return match
      }
    } else if ('name' in field && field.name) {
      if (field.name !== path[0]) continue
      if (path.length === 1) return 'localized' in field ? field : {}
      if ('fields' in field) {
        const match = findSourceField(field.fields, path.slice(1), config)
        if (match) return match
      }
      if (field.type === 'blocks') {
        // Block slugs disambiguate fields with the same name in different variants.
        for (const reference of [...field.blocks, ...(field.blockReferences ?? [])]) {
          const block = typeof reference === 'string'
            ? config.blocks?.find(({ slug }) => slug === reference)
            : reference
          if (block?.slug !== path[1]) continue
          const match = findSourceField(block.fields, path.slice(2), config)
          if (match) return match
        }
      }
    } else if ('fields' in field) {
      const match = findSourceField(field.fields, path, config)
      if (match) return match
    }
  }
  return undefined
}

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
  // Plugin-owned models must never adopt host definitions with unknown access/validation.
  for (const slug of ['seo-proposals', 'seo-runs']) {
    if (hostCollections.has(slug)) {
      throw configurationError(
        `${slug}: collection slug is reserved by this plugin; remove or rename the existing collection.`,
      )
    }
  }
  for (const [slug, collection] of collections) {
    if (!hostCollections.has(slug)) {
      throw configurationError(`${slug}: target collection must exist in Payload collections.`)
    }
    const hostCollection = config.collections!.find((candidate) => candidate.slug === slug)!
    if (hostCollection.fields.some((field) => 'name' in field && field.name === 'nimSeoPanel')) {
      throw configurationError(`${slug}.nimSeoPanel: field name is reserved by this plugin; remove or rename the existing field.`)
    }
    if (hostCollection.fields.some((field) => 'name' in field && field.name === 'seo')) {
      throw configurationError(
        `${slug}.seo: field name is reserved by this plugin; remove or rename the existing field.`,
      )
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
    if (!Array.isArray(collection.localizedSourceFields) || collection.localizedSourceFields.length === 0
      || !collection.localizedSourceFields.every((field) => isNonEmptyString(field) && field.split('.').every(isNonEmptyString))) {
      throw configurationError(`${slug}.localizedSourceFields must be a non-empty array of source field paths.`)
    }
    if (!collection.localizedSourceFields.includes(collection.titleField)) {
      throw configurationError(`${slug}.${collection.titleField}: titleField must be included in localizedSourceFields.`)
    }
    for (const path of collection.localizedSourceFields) {
      const field = findSourceField(hostCollection.fields, path.split('.'), config)
      if (!field) {
        throw configurationError(`${slug}.${path}: declared source field must exist in the target collection.`)
      }
      if (field.localized !== true) {
        throw configurationError(`${slug}.${path}: source field must explicitly set localized: true for independent locale content.`)
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
  for (const endpoint of config.endpoints || []) {
    if (endpoint.method === 'get' && endpoint.path === '/nim-seo/capabilities') {
      throw configurationError(`${endpoint.path}: endpoint path is reserved by this plugin.`)
    }
    if (endpoint.method === 'post' && ['/nim-seo/generate', '/nim-seo/apply', '/nim-seo/audit'].includes(endpoint.path)) {
      throw configurationError(`${endpoint.path}: endpoint path is reserved by this plugin.`)
    }
  }
  if (bulk) for (const task of config.jobs?.tasks ?? []) {
    if (['nim-seo-generate-proposal', 'nim-seo-run-audit'].includes(task.slug)) {
      throw configurationError(`${task.slug}: job task slug is reserved by this plugin.`)
    }
  }

  return { ...options, bulk }
}

/** Add SEO models without mutating the host's collection/config objects. */
export const nimSeoPlugin = (options: NimSeoPluginOptions): Plugin => (config) => {
  const validated = validatePluginOptions(options, config)
  const collections = (config.collections ?? []).map((collection) => {
    const target = validated.collections[collection.slug]
    if (!target) {
      return collection
    }
    return {
      ...collection,
      fields: [...collection.fields, {
        name: 'nimSeoPanel', type: 'ui' as const,
        admin: { components: { Field: {
          path: '@scope/payload-plugin-nim-seo/client#SeoPanel',
          clientProps: { locales: validated.locales, mediaCollection: target.mediaCollection },
        } } },
      }, ...buildSeoFields({
        ...validated,
        collections: { [collection.slug]: target },
      })],
    }
  })
  for (const build of [buildProposalsCollection, buildRunsCollection]) {
    collections.push(build(validated))
  }
  const endpoints = [...(config.endpoints || []), generateProposalEndpoint(validated), applyProposalEndpoint(validated), auditEndpoint(validated), adminCapabilitiesEndpoint(validated)]
  const jobs = validated.bulk ? {
    ...config.jobs,
    tasks: [...(config.jobs?.tasks ?? []), generateProposalTask(validated), runAuditTask(validated)],
  } : config.jobs
  const admin = { ...config.admin, components: {
    ...config.admin?.components,
    beforeDashboard: [...(config.admin?.components?.beforeDashboard ?? []), {
      path: '@scope/payload-plugin-nim-seo/client#AuditDashboard',
      clientProps: { locales: validated.locales, collections: Object.keys(validated.collections), bulk: validated.bulk },
    }],
  } }
  return { ...config, admin, collections, endpoints, ...(jobs ? { jobs } : {}) }
}
