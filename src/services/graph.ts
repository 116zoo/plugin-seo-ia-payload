import type { EditorialGraphBinding, EditorialPatch, EditorialProposalPayload, EditorialRegistry, EditorialSemanticGraph, RelatedDraft } from '../types.js'
import { isPublicURL } from './content.js'
import { parseProposalOutput, ProposalValidationError } from './validation.js'

const fail = (): never => {
  throw new ProposalValidationError([{ code: 'invalid_graph', path: 'editorial.semanticGraph', message: 'Invalid or unresolved editorial semantic graph.' }])
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const draftID = (id: string): boolean => /^draft:[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(id)
const graphID = (id: unknown): id is string => typeof id === 'string' && (isPublicURL(id) || draftID(id))
const pageTypes = new Set(['Article', 'BlogPosting', 'WebPage', 'FAQPage', 'BreadcrumbList', 'WebSite'])
const sourceTypes = new Set(['Article', 'BlogPosting', 'WebPage', 'FAQPage', 'BreadcrumbList'])
const withoutHash = (url: string): string => { const parsed = new URL(url); parsed.hash = ''; return parsed.href }
// Explicit Schema.org vocabulary supported by this adapter; unknown/custom properties need a future adapter.
const properties = new Set([
  'name', 'headline', 'description', 'abstract', 'text', 'alternateName', 'inLanguage', 'datePublished', 'dateModified',
  'keywords', 'articleSection', 'wordCount', 'author', 'creator', 'editor', 'publisher', 'contributor', 'about', 'mentions',
  'mainEntity', 'mainEntityOfPage', 'isPartOf', 'hasPart', 'subjectOf', 'image', 'primaryImageOfPage', 'logo',
  'thumbnailUrl', 'contentUrl', 'embedUrl', 'encodingFormat', 'width', 'height', 'caption', 'url', 'sameAs', 'license',
  'sdLicense', 'discussionUrl', 'itemListElement', 'item', 'position', 'numberOfItems', 'acceptedAnswer', 'suggestedAnswer',
  'answerCount', 'question', 'address', 'streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry',
  'contactPoint', 'contactType', 'email', 'telephone', 'areaServed', 'availableLanguage',
])

/** Local document dependencies, including values inside arrays, groups and polymorphic relations. */
export const localDraftReferences = (value: unknown): Set<string> => {
  const ids = new Set<string>()
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) entry.forEach(visit)
    else if (record(entry)) {
      if (typeof entry.localId === 'string') ids.add(entry.localId)
      Object.values(entry).forEach(visit)
    }
  }
  visit(value)
  return ids
}

/** Reject directed cycles that involve at least one local draft node. */
const assertAcyclicLocalGraph = (edges: Map<string, Set<string>>, local: (id: string) => boolean): void => {
  for (const start of edges.keys()) {
    if (!local(start)) continue
    const seen = new Set<string>()
    const visit = (id: string): void => {
      if (id === start) fail()
      if (seen.has(id)) return
      seen.add(id)
      edges.get(id)?.forEach(visit)
    }
    edges.get(start)?.forEach(visit)
  }
}

/** Validates graph structure/provenance; called only after schema-aware patch/draft validation. */
export const parseEditorialGraph = (
  semanticGraph: unknown, graphBindings: unknown, patches: EditorialPatch[], relatedDrafts: RelatedDraft[], sourceURL?: string, registry?: EditorialRegistry,
): { semanticGraph?: EditorialSemanticGraph; graphBindings?: EditorialGraphBinding[] } => {
  if (semanticGraph === undefined && graphBindings === undefined) return {}
  if (!record(semanticGraph) || Object.keys(semanticGraph).some((key) => !['@context', '@graph'].includes(key))
    || (semanticGraph['@context'] !== undefined && semanticGraph['@context'] !== 'https://schema.org')
    || !Array.isArray(semanticGraph['@graph']) || !semanticGraph['@graph'].length || semanticGraph['@graph'].length > 500
    || !Array.isArray(graphBindings) || graphBindings.length > 1000) return fail()
  const nodes = semanticGraph['@graph'] as unknown[]
  const ids = new Set<string>()
  const drafts = new Set(relatedDrafts.map(({ graphNodeId }) => graphNodeId))
  const propertySources = new Map<string, boolean | undefined>()
  const nodeSources = new Map<string, boolean | undefined>()
  // Classification comes from the startup registry, never from a model's claimed role.
  // Exact paths also cover relationships nested under groups, tabs, arrays and blocks.
  for (const binding of graphBindings) {
    if (!record(binding) || typeof binding.path !== 'string' || typeof binding.nodeId !== 'string' || !Array.isArray(binding.properties)) continue
    const field = registry?.fields.find(({ path }) => path === binding.path)
    const source = field ? !['relationship', 'upload'].includes(field.type) : undefined
    const previous = nodeSources.get(binding.nodeId)
    nodeSources.set(binding.nodeId, source === true || previous === true ? true
      : source === undefined || (nodeSources.has(binding.nodeId) && previous === undefined) ? undefined : false)
    for (const property of binding.properties) propertySources.set(JSON.stringify([binding.nodeId, property]), source)
  }
  const assertSource = (node: Record<string, unknown>, sourceBound?: boolean): void => {
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']]
    if (!types.some((type) => typeof type === 'string' && pageTypes.has(type))) return
    const id = node['@id']
    // Declared draft pages identify related documents, not the source page.
    if (typeof id === 'string' && drafts.has(id as `draft:${string}`)) return
    if (typeof id !== 'string' || !isPublicURL(id)) return fail()
    const trustedSource = sourceURL && isPublicURL(sourceURL) ? withoutHash(sourceURL) : undefined
    if (trustedSource && withoutHash(id) === trustedSource) return
    // Related public pages can keep their own URL only with trusted relation-field provenance.
    if (sourceBound === false) return
    if (sourceBound === undefined || !trustedSource) return fail()
    if (types.some((type) => typeof type === 'string' && sourceTypes.has(type))
      && withoutHash(id) !== trustedSource) fail()
  }
  for (const node of nodes) {
    if (!record(node) || !graphID(node['@id']) || ids.has(node['@id']) || node['@type'] === undefined) return fail()
    if (draftID(node['@id']) && !drafts.has(node['@id'] as `draft:${string}`)) fail()
    assertSource(node, nodeSources.get(node['@id']))
    ids.add(node['@id'])
  }
  if ([...drafts].some((id) => !ids.has(id))) fail()
  const edges = new Map<string, Set<string>>()
  const ancestors = new Set<object>()
  let count = 0
  const sanitize = (value: unknown, owner: string, depth = 0, key?: string, sourceBound?: boolean): unknown => {
    if (++count > 5000 || depth > 32) return fail()
    if (key === '@id') {
      if (!graphID(value)) return fail()
      if (draftID(value) && !drafts.has(value as `draft:${string}`)) fail()
      if (ids.has(value) && value !== owner) edges.get(owner)?.add(value)
      // A reference to its own node is a local cycle too; top-level IDs are handled separately.
      if (value === owner) edges.get(owner)?.add(value)
      return draftID(value) ? `https://nim-seo.invalid/drafts/${value.slice(6)}` : value
    }
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value
    if (typeof value !== 'object' || ancestors.has(value)) return fail()
    ancestors.add(value)
    let result: unknown
    if (Array.isArray(value)) result = value.map((entry) => sanitize(entry, owner, depth + 1, key, sourceBound))
    else {
      if (!record(value)) return fail()
      assertSource(value, sourceBound)
      result = Object.fromEntries(Object.entries(value).map(([property, entry]) => {
        if (!['@id', '@type'].includes(property) && !properties.has(property)) fail()
        return [property, sanitize(entry, owner, depth + 1, property, sourceBound)]
      }))
    }
    ancestors.delete(value)
    return result
  }
  const sanitized = nodes.map((node) => {
    const current = node as Record<string, unknown>
    const id = current['@id'] as string
    edges.set(id, new Set())
    const { '@id': _id, ...values } = current
    // Already checked the top-level source ID; nested source nodes are checked by sanitize.
    const result = Object.fromEntries(Object.entries(values).map(([key, value]) => {
      if (key !== '@type' && !properties.has(key)) fail()
      return [key, sanitize(value, id, 1, key, draftID(id) ? false : propertySources.get(JSON.stringify([id, key])))]
    }))
    return { ...result, '@id': draftID(id) ? `https://nim-seo.invalid/drafts/${id.slice(6)}` : id }
  })
  // Reuse the established strict JSON-LD validator. A wrapper treats graph members
  // as nested Schema.org nodes so Person/ImageObject/Thing are allowed graph members.
  try {
    parseProposalOutput({ meta: { title: 'Graph', description: 'Graph' }, social: {}, citability: { summary: '' },
      schema: [{ '@type': 'WebPage', mainEntity: sanitized }] }, { url: 'https://nim-seo.invalid/', selectedMedia: [] })
  } catch { return fail() }
  assertAcyclicLocalGraph(edges, draftID)
  const patchPaths = new Set(patches.map(({ path }) => path))
  const claimed = new Set<string>()
  const bindings: EditorialGraphBinding[] = graphBindings.map((binding) => {
    if (!record(binding) || Object.keys(binding).some((key) => !['path', 'nodeId', 'properties'].includes(key))
      || typeof binding.path !== 'string' || binding.path.split('.').some((part) => part.toLowerCase() === 'content') || !patchPaths.has(binding.path)
      || typeof binding.nodeId !== 'string' || !ids.has(binding.nodeId) || draftID(binding.nodeId)
      || !Array.isArray(binding.properties) || !binding.properties.length) return fail()
    const node = nodes.find((node) => (node as Record<string, unknown>)['@id'] === binding.nodeId) as Record<string, unknown>
    for (const property of binding.properties) {
      if (typeof property !== 'string' || !properties.has(property) || !Object.hasOwn(node, property)) fail()
      const claim = JSON.stringify([binding.nodeId, property])
      if (claimed.has(claim)) fail()
      claimed.add(claim)
    }
    return { path: binding.path, nodeId: binding.nodeId, properties: [...binding.properties] as string[] }
  })
  for (const node of nodes as Record<string, unknown>[]) {
    const id = node['@id'] as string
    const contributions = Object.keys(node).filter((key) => !['@id', '@type'].includes(key))
    if (!contributions.length || (!draftID(id) && contributions.some((property) => !claimed.has(JSON.stringify([id, property]))))) fail()
  }
  return structuredClone({ semanticGraph: { '@context': 'https://schema.org', '@graph': nodes as Record<string, unknown>[] }, graphBindings: bindings })
}

export interface AppliedGraphArgs {
  /** Must have passed parseEditorialProposal against the trusted startup registry. */
  proposal: EditorialProposalPayload
  selectedPatches: readonly string[]
  selectedDrafts: readonly string[]
  /** Server-resolved public JSON-LD IDs, keyed by local draft ID (not Payload IDs). */
  resolvedDrafts?: Readonly<Record<string, string>>
  /** Trusted localized source URL from the host adapter; never a model-provided URL. */
  sourceURL?: string
  /** Trusted startup registry, required to distinguish related page nodes from source bindings. */
  registry?: EditorialRegistry
}

/** Pure reconciliation: no database access and no mutation of the proposal. */
export const buildAppliedGraph = ({ proposal, selectedPatches, selectedDrafts, resolvedDrafts = {}, sourceURL, registry }: AppliedGraphArgs): EditorialSemanticGraph => {
  const paths = new Set(selectedPatches), selected = new Set(selectedDrafts)
  if (paths.size !== selectedPatches.length || selected.size !== selectedDrafts.length
    || [...paths].some((path) => path.split('.').some((part) => part.toLowerCase() === 'content') || !proposal.patches.some((patch) => patch.path === path))
    || [...selected].some((id) => !proposal.relatedDrafts.some((draft) => draft.localId === id))) return fail()
  const reachable = new Set<string>()
  const visit = (value: unknown): void => {
    for (const id of localDraftReferences(value)) {
      if (!selected.has(id)) fail()
      if (reachable.has(id)) continue
      reachable.add(id)
      visit(proposal.relatedDrafts.find((draft) => draft.localId === id)?.fields)
    }
  }
  proposal.patches.filter(({ path }) => paths.has(path)).forEach(({ value }) => visit(value))
  if ([...selected].some((id) => !reachable.has(id))) fail()
  const parsed = parseEditorialGraph(proposal.semanticGraph, proposal.graphBindings, proposal.patches, proposal.relatedDrafts, sourceURL, registry)
  if (!parsed.semanticGraph) return { '@context': 'https://schema.org', '@graph': [] }
  const originalIDs = new Set(parsed.semanticGraph['@graph'].map((node) => node['@id'] as string))
  const replacements = new Set<string>()
  for (const id of selected) {
    const replacement = Object.hasOwn(resolvedDrafts, id) ? resolvedDrafts[id] : undefined
    if (!replacement || !isPublicURL(replacement) || originalIDs.has(replacement) || replacements.has(replacement)) return fail()
    replacements.add(replacement)
  }
  let nodes = parsed.semanticGraph['@graph'].flatMap((node) => {
    const id = node['@id'] as string
    if (draftID(id)) return selected.has(id.slice(6)) ? [node] : []
    const selectedProperties = new Set(parsed.graphBindings!.filter((binding) => binding.nodeId === id && paths.has(binding.path)).flatMap(({ properties }) => properties))
    const values = Object.entries(node).filter(([key]) => selectedProperties.has(key))
    return values.length ? [{ '@id': id, '@type': node['@type'], ...Object.fromEntries(values) }] : []
  })
  // Drop edges to graph nodes removed by selection, then remove emptied helper nodes.
  for (let pass = 0; pass <= parsed.semanticGraph['@graph'].length; pass++) {
    const retained = new Set(nodes.map((node) => node['@id'] as string))
    const prune = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        const entries = value.map(prune).filter((entry) => entry !== undefined)
        return entries.length ? entries : undefined
      }
      if (!record(value)) return value
      if (typeof value['@id'] === 'string' && originalIDs.has(value['@id']) && !retained.has(value['@id'])) {
        if (draftID(value['@id'])) fail()
        return undefined
      }
      return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
        const result = prune(entry)
        return result === undefined ? [] : [[key, result]]
      }))
    }
    const next = nodes.map((node) => prune(node) as Record<string, unknown>).filter((node) => Object.keys(node).some((key) => !['@id', '@type'].includes(key)))
    if (next.length === nodes.length) { nodes = next; break }
    nodes = next
  }
  const resolve = (value: unknown, key?: string): unknown => {
    if (key === '@id' && typeof value === 'string' && draftID(value)) return resolvedDrafts[value.slice(6)] ?? fail()
    if (Array.isArray(value)) return value.map((entry) => resolve(entry, key))
    if (record(value)) return Object.fromEntries(Object.entries(value).map(([property, entry]) => [property, resolve(entry, property)]))
    return value
  }
  return { '@context': 'https://schema.org', '@graph': resolve(nodes) as Record<string, unknown>[] }
}
