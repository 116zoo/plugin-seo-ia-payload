import { z } from 'zod'

import type { SeoProposalPayload } from '../types.js'
import { parseEditorialProposal, type EditorialValidationContext } from './editorialValidation.js'
import { isPublicURL, type GenerationInput } from './content.js'

export interface ProposalValidationDiagnostic {
  code: string
  message: string
  path: string
}

/** Safe to persist: contains field diagnostics, never the unvalidated model response. */
export class ProposalValidationError extends Error {
  readonly diagnostics: ProposalValidationDiagnostic[]

  constructor(diagnostics: ProposalValidationDiagnostic[]) {
    super(`Invalid SEO proposal: ${diagnostics.map(({ path, message }) => `${path || 'proposal'}: ${message}`).join('; ')}`)
    this.name = 'ProposalValidationError'
    this.diagnostics = diagnostics
  }
}

const rootTypes = new Set(['WebPage', 'Article', 'BlogPosting', 'BreadcrumbList', 'Organization', 'LocalBusiness', 'WebSite', 'FAQPage'])
const nestedTypes = new Set([...rootTypes, 'Person', 'ImageObject', 'ListItem', 'Question', 'Answer', 'PostalAddress', 'ContactPoint', 'Thing'])
const pageTypes = new Set(['WebPage', 'Article', 'BlogPosting', 'BreadcrumbList', 'WebSite', 'FAQPage'])
const urlFields = new Set(['@id', 'url', 'sameAs', 'image', 'logo', 'contentUrl', 'embedUrl', 'thumbnailUrl', 'mainEntityOfPage', 'isPartOf', 'license', 'discussionUrl', 'item', 'subjectOf', 'sdLicense'])
const stringURLFields = new Set(['@id', 'url', 'sameAs', 'contentUrl', 'embedUrl', 'thumbnailUrl', 'license', 'discussionUrl', 'sdLicense'])
// The Schema.org context aliases these JSON-LD keywords; require canonical spellings
// so every accepted type and identifier follows the same validation/filtering rules.
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor', 'type', 'id'])
const jsonLdKeywords = new Set(['@context', '@type', '@id', '@graph', '@value', '@language', '@list', '@set'])
const diagnosticFields = new Set([
  'meta', 'title', 'description', 'canonical', 'robots', 'focusKeyphrase',
  'social', 'image', 'imageAlt', 'imageFilename', 'imageCaption', 'recommendedWidth', 'recommendedHeight', 'ogTitle', 'ogDescription', 'twitterCard',
  'schema', 'citability', 'summary', 'sources', 'claims',
])

const plainText = z.string().refine((value) => !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), 'Unsafe markup or control characters.')
const publicURL = z.string().refine(isPublicURL, 'Expected an absolute HTTP or HTTPS URL without credentials.')
const uniqueStrings = (schema: z.ZodString) => z.array(schema).transform((values) => [...new Set(values)])

/** Bound recursive JSON validation before cloning or serializing a model-produced graph. */
const schemaGraph = z.custom<Record<string, unknown>>((value) => value !== null && typeof value === 'object' && !Array.isArray(value)).superRefine((graph, ctx) => {
  const ancestors = new Set<object>()
  let nodes = 0
  const invalid = () => ctx.addIssue({ code: 'custom', message: 'Unsafe or unsupported JSON-LD.' })
  const visit = (value: unknown, depth: number, key?: string, root = false, graphMember = false): boolean => {
    nodes += 1
    if (depth > 32 || nodes > 5000) return false
    if (key && urlFields.has(key) && typeof value !== 'string') {
      if (key === '@id' || value === null || typeof value !== 'object') return false
      if (stringURLFields.has(key) && !Array.isArray(value)) return false
    }
    if (typeof value === 'string') {
      if (/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return false
      if (key === '@context') return value === 'https://schema.org'
      if (key === '@type') return (root && !graphMember ? rootTypes : nestedTypes).has(value)
      return !(key && urlFields.has(key)) || isPublicURL(value)
    }
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value === 'boolean' || value === null) return true
    if (typeof value !== 'object' || ancestors.has(value)) return false
    ancestors.add(value)
    let valid: boolean
    if (Array.isArray(value)) {
      valid = value.every((entry) => visit(entry, depth + 1, key, root, graphMember))
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
      const record = value as Record<string, unknown>
      if (root && record['@type'] === undefined && (!Array.isArray(record['@graph']) || record['@graph'].length === 0)) return false
      if (record['@type'] !== undefined) {
        const types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']]
        if (!types.length || !types.every((type) => typeof type === 'string' && (root && !graphMember ? rootTypes : nestedTypes).has(type))) return false
      }
      if (record['@context'] !== undefined && record['@context'] !== 'https://schema.org') return false
      valid = Object.entries(record).every(([property, entry]) => {
        if (forbiddenKeys.has(property) || (property.startsWith('@') && !jsonLdKeywords.has(property))) return false
        if (property === '@graph') {
          // A graph can contain supporting entities (Person, ImageObject, Thing),
          // while standalone schema documents retain the stricter root types.
          return Array.isArray(entry) && entry.every((node) => node !== null && typeof node === 'object' && !Array.isArray(node) && visit(node, depth + 1, undefined, true, true))
        }
        return visit(entry, depth + 1, property, property === '@type' && root, graphMember)
      })
    }
    ancestors.delete(value)
    return valid
  }
  if (!visit(graph, 0, undefined, true)) invalid()
})

const proposalSchema = z.strictObject({
  meta: z.strictObject({
    title: plainText.min(1),
    description: plainText.min(1),
    canonical: publicURL.optional(),
    robots: plainText.optional(),
    focusKeyphrase: plainText.optional(),
  }),
  social: z.strictObject({
    image: z.union([z.string().min(1), z.number().finite()]).optional(),
    imageAlt: plainText.optional(),
    imageFilename: plainText.optional(),
    imageCaption: plainText.optional(),
    recommendedWidth: z.number().int().positive().optional(),
    recommendedHeight: z.number().int().positive().optional(),
    ogTitle: plainText.optional(),
    ogDescription: plainText.optional(),
    twitterCard: z.enum(['summary', 'summary_large_image']).optional(),
  }),
  schema: z.array(schemaGraph),
  citability: z.strictObject({
    summary: plainText.max(2000),
    sources: uniqueStrings(publicURL).optional(),
    claims: uniqueStrings(plainText).optional(),
  }),
})

/** Remove URL-dependent types at any depth, including nodes nested in organization graphs. */
const removePageGraphs = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const retained = removePageGraphs(entry)
      return retained === undefined ? [] : [retained]
    })
  }
  if (!value || typeof value !== 'object') return value
  const graph = value as Record<string, unknown>
  const types = Array.isArray(graph['@type']) ? graph['@type'] : [graph['@type']]
  if (types.some((type) => typeof type === 'string' && pageTypes.has(type))) return undefined
  const result = Object.fromEntries(Object.entries(graph).flatMap(([key, entry]) => {
    const retained = removePageGraphs(entry)
    return retained === undefined ? [] : [[key, retained]]
  }))
  if (Array.isArray(result['@graph']) && result['@graph'].length === 0) return undefined
  return result
}

const sortedJSON = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortedJSON)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => [key, sortedJSON(entry)]))
}

const diagnosticsFromIssues = (issues: z.core.$ZodIssue[]): ProposalValidationDiagnostic[] => issues.map((issue) => ({
  code: issue.code,
  path: issue.path.map((part) => typeof part === 'number' || (typeof part === 'string' && diagnosticFields.has(part)) ? String(part) : 'field').join('.'),
  message: issue.code === 'too_big' && issue.path.join('.') === 'citability.summary'
    ? 'Must contain at most 2000 characters.'
    : issue.code === 'custom' ? issue.message : 'Invalid field value.',
}))

/** Complete image fields from editor-selected media when the model omits them. */
const completeSelectedMedia = (value: unknown, selectedMedia: GenerationInput['selectedMedia']): unknown => {
  if (!selectedMedia.length || !value || typeof value !== 'object' || Array.isArray(value)) return value
  const proposal = value as Record<string, unknown>
  if (!proposal.social || typeof proposal.social !== 'object' || Array.isArray(proposal.social)) return value

  const social = { ...(proposal.social as Record<string, unknown>) }
  const selected = selectedMedia.find((media) => media.id === social.image || String(media.id) === String(social.image)) ?? selectedMedia[0]
  if (social.image === undefined) social.image = selected.id
  else if (selectedMedia.some((media) => media.id === social.image || String(media.id) === String(social.image))) social.image = selected.id
  if (social.imageAlt === undefined && selected.alt) social.imageAlt = selected.alt
  if (social.imageFilename === undefined && selected.filename) social.imageFilename = selected.filename
  if (social.imageCaption === undefined && selected.caption) social.imageCaption = selected.caption
  if (social.recommendedWidth === undefined && selected.width) social.recommendedWidth = selected.width
  if (social.recommendedHeight === undefined && selected.height) social.recommendedHeight = selected.height
  return { ...proposal, social }
}

/** Validate the complete proposal before a caller can persist it or offer editorial review. */
export const parseProposalOutput = (value: unknown, input: Pick<GenerationInput, 'url' | 'selectedMedia'>, editorial?: EditorialValidationContext): SeoProposalPayload => {
  let decoded: unknown = value
  if (typeof value === 'string') {
    try {
      decoded = JSON.parse(value)
    } catch {
      throw new ProposalValidationError([{ code: 'invalid_json', message: 'Expected a JSON proposal object.', path: '' }])
    }
  }
  // Some OpenAI-compatible models collapse a one-item string array into a
  // scalar. Normalize that harmless shape before strict validation.
  if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
    const proposal = decoded as Record<string, unknown>
    const citability = proposal.citability
    const value = citability && typeof citability === 'object' && !Array.isArray(citability)
      ? { ...(citability as Record<string, unknown>) }
      : {}
    if (typeof value.summary !== 'string') value.summary = ''
    if (typeof value.claims === 'string') value.claims = [value.claims]
    else if (value.claims !== undefined && (!Array.isArray(value.claims) || !value.claims.every((item) => typeof item === 'string'))) delete value.claims
    if (typeof value.sources === 'string') value.sources = [value.sources]
    else if (value.sources !== undefined && (!Array.isArray(value.sources) || !value.sources.every((item) => typeof item === 'string'))) delete value.sources
    proposal.citability = value
  }
  decoded = completeSelectedMedia(decoded, input.selectedMedia)
  let editorialOutput: SeoProposalPayload['editorial']
  if (editorial && decoded && typeof decoded === 'object' && !Array.isArray(decoded) && Object.hasOwn(decoded, 'editorial')) {
    const { editorial: rawEditorial, ...seo } = decoded as Record<string, unknown>
    if (editorial.locale !== (input as Partial<GenerationInput>).locale && (input as Partial<GenerationInput>).locale !== undefined) {
      throw new ProposalValidationError([{ code: 'invalid_editorial', path: 'editorial', message: 'Editorial locale must match the source locale.' }])
    }
    editorialOutput = parseEditorialProposal(rawEditorial, editorial.registry, editorial.locale, editorial.registries, input.url)
    decoded = seo
  }
  let result = proposalSchema.safeParse(decoded)
  // Schema.org is optional enrichment: discard only an unsafe schema graph so
  // valid meta/social/citability proposals remain reviewable and applicable.
  if (!result.success && result.error.issues.length > 0
    && result.error.issues.every((issue) => issue.code === 'custom' && issue.path[0] === 'schema')
    && decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
    result = proposalSchema.safeParse({ ...(decoded as Record<string, unknown>), schema: [] })
  }
  if (!result.success) throw new ProposalValidationError(diagnosticsFromIssues(result.error.issues))
  const output = result.data
  if (output.social.image !== undefined && !input.selectedMedia.some(({ id }) => id === output.social.image)) {
    throw new ProposalValidationError([{ code: 'unselected_media', message: 'Image must be explicitly selected by the editor.', path: 'social.image' }])
  }
  if (!input.url) delete output.meta.canonical
  const graphs = input.url ? output.schema : removePageGraphs(output.schema) as Record<string, unknown>[]
  // Schema validation permits only JSON values. Clone to avoid retaining source object references.
  // Each array entry is an independent JSON-LD document. Nested nodes and
  // @graph members inherit this root context; never add contexts recursively.
  const uniqueGraphs = new Set(graphs.map((graph) => JSON.stringify(sortedJSON({ ...graph, '@context': 'https://schema.org' }))))
  output.schema = [...uniqueGraphs].map((graph) => JSON.parse(graph) as Record<string, unknown>)
  if (input.url && editorialOutput?.semanticGraph) {
    const editorialGraph = sortedJSON({ ...editorialOutput.semanticGraph, '@context': 'https://schema.org' }) as Record<string, unknown>
    const serializedEditorialGraph = JSON.stringify(editorialGraph)
    if (!uniqueGraphs.has(serializedEditorialGraph)) output.schema.push(editorialGraph)
  }
  return { ...output, ...(editorialOutput ? { editorial: editorialOutput } : {}) }
}
