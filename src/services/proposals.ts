import { createHash } from 'node:crypto'
import { commitTransaction, initTransaction, killTransaction, type Document, type PayloadRequest } from 'payload'

import { allowSeo } from '../collections/shared.js'
import type { EditorialField, EditorialProposalPayload, EditorialRegistry, SeoProposalPayload, ValidatedPluginOptions } from '../types.js'
import { buildGenerationInput, isPublicURL, type BuildGenerationInputArgs, type GenerationInput } from './content.js'
import { resolveEditorialRegistry } from './editorialSchema.js'
import { buildAppliedGraph, localDraftReferences } from './graph.js'
import { createNimClient, NimGenerationError, type NimClient } from './nim.js'
import { parseProposalOutput, ProposalValidationError, type ProposalValidationDiagnostic } from './validation.js'
import { validateUsage, type NimUsage } from './usage.js'

/** Persisted proposal shape, independent of a host project's generated Payload types. */
export interface SeoProposal {
  id: string | number
  sourceCollection: string
  sourceID: string
  locale: string
  sourceFingerprint: string
  editorialSourceFingerprint?: string
  sourceSnapshot: GenerationInput
  output?: SeoProposalPayload
  usage?: NimUsage
  state: 'draft' | 'approved' | 'applied' | 'discarded' | 'failed'
  actor?: { collection?: string; userID?: string }
  appliedAt?: string
  updatedAt?: string
  run?: string | number
  errors?: ProposalValidationDiagnostic[]
  appliedSelection?: { groups: readonly SeoProposalGroup[]; editorialPaths: readonly string[]; relatedDraftIDs: readonly string[]; applyGraph: boolean; createdRelated: { localId: string; collection: string; id: string | number }[] }
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const fieldValue = (doc: Record<string, unknown>, path: string): unknown => path.split('.').reduce<unknown>((value, key) => object(value) ? value[key] : undefined, doc)
const stableJSON = (value: unknown): unknown => Array.isArray(value) ? value.map(stableJSON)
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJSON(value[key])])) : value ?? null
const editorialFingerprint = (doc: Record<string, unknown>, registry: EditorialRegistry): string => createHash('sha256')
  .update(JSON.stringify(stableJSON(Object.fromEntries(registry.fields.map(({ path }) => [path, fieldValue(doc, path)]))))).digest('hex')

/** Exact paths have no row identity: array/block descendants require a whole-container patch. */
const writableField = (registry: EditorialRegistry, path: string): EditorialField => {
  const descriptor = registry.fields.find((field) => field.path === path)
  if (!descriptor || path.split('.').some((part) => part.toLowerCase() === 'content')
    || registry.exclude.some((excluded) => path === excluded || path.startsWith(`${excluded}.`))) throw new Error('Select only configured editorial fields; content is excluded.')
  if (descriptor.ancestors.some(({ type }) => type === 'array' || type === 'blocks')) throw new Error('Editorial array/block descendants require a whole-container patch.')
  return descriptor
}
const materialize = (fields: Record<string, unknown>, registry: EditorialRegistry): Record<string, unknown> => {
  const data: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(fields)) {
    writableField(registry, path)
    const parts = path.split('.')
    let target = data
    for (const key of parts.slice(0, -1)) {
      if (!Object.hasOwn(target, key)) target[key] = {}
      target = target[key] as Record<string, unknown>
    }
    target[parts.at(-1)!] = value
  }
  return data
}
const resolveLocalReferences = (value: unknown, resolved: Map<string, string | number>): unknown => {
  if (Array.isArray(value)) return value.map((entry) => resolveLocalReferences(entry, resolved))
  if (!object(value)) return value
  if (typeof value.localId === 'string') {
    if (!resolved.has(value.localId)) throw new Error('Select and resolve every required related draft.')
    return resolved.get(value.localId)
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveLocalReferences(entry, resolved)]))
}
interface AuthorizedRelation { collection: string; doc: Record<string, unknown> }
const hasRelations = (field: EditorialField): boolean => ['relationship', 'upload'].includes(field.type) || Boolean(field.children?.some(hasRelations))
/** Check IDs through the host's active-locale read ACL and retain trusted documents for graph identity. */
const authorizeRelations = async (value: unknown, descriptor: EditorialField, req: PayloadRequest, locale: string, authorized: AuthorizedRelation[] = []): Promise<void> => {
  if (value === null || value === undefined) return
  if (descriptor.type === 'relationship' || descriptor.type === 'upload') {
    const field = descriptor.field
    if (field.type !== 'relationship' && field.type !== 'upload') throw new Error('Invalid editorial relation descriptor.')
    const entries = field.hasMany ? value as unknown[] : [value]
    for (const entry of entries) {
      const collection = Array.isArray(field.relationTo) && object(entry) ? entry.relationTo as string : field.relationTo as string
      const id = Array.isArray(field.relationTo) && object(entry) ? entry.value : entry
      const doc = await req.payload.findByID({ collection, id: id as string | number, locale, fallbackLocale: false, draft: true, depth: 0, req, overrideAccess: false })
      authorized.push({ collection, doc })
    }
  } else if (['group', 'array', 'blocks'].includes(descriptor.type)) {
    for (const entry of descriptor.type === 'group' ? [value] : value as unknown[]) {
      if (!object(entry)) continue
      const prefix = descriptor.type === 'blocks' ? `${descriptor.path}.${String(entry.blockType)}.` : `${descriptor.path}.`
      for (const child of descriptor.children ?? []) if (child.path.startsWith(prefix)) {
        await authorizeRelations(entry[child.path.slice(prefix.length)], child, req, locale, authorized)
      }
    }
  }
}
const graphIdentity = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !isPublicURL(value)) return undefined
  const parsed = new URL(value)
  parsed.hash = ''
  return parsed.href
}
/** Bind graph contributions to ACL-read Payload relations, never model-chosen public identities. */
const assertGraphIdentities = async (
  graph: Record<string, unknown>, editorial: EditorialProposalPayload, sourceURL: string | undefined,
  relations: Map<string, AuthorizedRelation[]>, draftRelations: Map<string, AuthorizedRelation[]>,
  resolvedDrafts: Record<string, string>, options: ValidatedPluginOptions, locale: string,
): Promise<void> => {
  const fail = (): never => { throw new Error('Semantic graph identity does not match the selected server-resolved document.') }
  const nodes = graph['@graph'] as Record<string, unknown>[]
  const trustedSource = graphIdentity(sourceURL)
  const identities = async (records: AuthorizedRelation[]): Promise<Set<string>> => {
    const result = new Set<string>()
    for (const { collection, doc } of records) {
      const resolve = options.collections[collection]?.resolveURL
      if (!resolve) return fail()
      const url = await resolve({ doc, locale })
      const identity = graphIdentity(typeof url === 'string' ? url.trim() : undefined)
      if (!identity) return fail()
      result.add(identity)
    }
    return result
  }
  const assertOwnURL = (node: Record<string, unknown>, ownID: string | undefined): void => {
    if (Object.hasOwn(node, 'url') && (!ownID || graphIdentity(node.url) !== ownID)) fail()
  }
  const assertLinks = (value: unknown, allowed: Set<string>): number => {
    if (Array.isArray(value)) return value.reduce((count, entry) => count + assertLinks(entry, allowed), 0)
    if (!object(value)) return 0
    let count = 0
    if (Object.hasOwn(value, '@id')) {
      const identity = graphIdentity(value['@id'])
      if (!identity || !allowed.has(identity)) return fail()
      assertOwnURL(value, identity)
      count++
    }
    return count + Object.values(value).reduce<number>((sum, entry) => sum + assertLinks(entry, allowed), 0)
  }
  for (const node of nodes) if (trustedSource && graphIdentity(node['@id']) === trustedSource) assertOwnURL(node, trustedSource)
  for (const [path, records] of relations) {
    const contributions = (editorial.graphBindings ?? []).filter((binding) => binding.path === path).flatMap((binding) => {
      const node = nodes.find((node) => node['@id'] === binding.nodeId)
      return node && binding.properties.some((property) => Object.hasOwn(node, property)) ? [{ binding, node }] : []
    })
    if (!contributions.length) continue
    const allowed = await identities(records)
    for (const { binding, node } of contributions) {
      const owner = graphIdentity(node['@id'])
      if (!owner || (owner !== trustedSource && !allowed.has(owner))) fail()
      assertOwnURL(node, owner)
      const linkTargets = new Set(allowed)
      if (owner !== trustedSource && trustedSource) linkTargets.add(trustedSource)
      let links = 0
      for (const property of binding.properties) if (Object.hasOwn(node, property)) links += assertLinks(node[property], linkTargets)
      if (owner === trustedSource && records.length > 0 && links === 0) fail()
    }
  }
  for (const [localID, url] of Object.entries(resolvedDrafts)) {
    const node = nodes.find((node) => node['@id'] === url)
    if (!node) continue
    const ownID = graphIdentity(url)
    if (!ownID) return fail()
    assertOwnURL(node, ownID)
    const allowed = await identities(draftRelations.get(localID) ?? [])
    for (const [property, value] of Object.entries(node)) if (!['@id', '@type'].includes(property)) assertLinks(value, allowed)
  }
}
/** Payload silently removes field-ACL-denied values. Detect that and roll back the whole application. */
const valuesMatch = (expected: unknown, actual: unknown, descriptor?: EditorialField): boolean => {
  if (descriptor?.type === 'date' && typeof expected === 'string' && typeof actual === 'string') return Date.parse(expected) === Date.parse(actual)
  if (descriptor && ['relationship', 'upload'].includes(descriptor.type) && expected !== null) {
    const relationMatches = (left: unknown, right: unknown): boolean => object(left) ? object(right) && left.relationTo === right.relationTo && String(left.value) === String(right.value) : String(left) === String(right)
    return Array.isArray(expected) ? Array.isArray(actual) && actual.length === expected.length && expected.every((entry, index) => relationMatches(entry, actual[index])) : relationMatches(expected, actual)
  }
  if (descriptor && ['group', 'array', 'blocks'].includes(descriptor.type)) {
    const entries = descriptor.type === 'group' ? [expected] : expected
    const saved = descriptor.type === 'group' ? [actual] : actual
    return Array.isArray(entries) && Array.isArray(saved) && entries.length === saved.length && entries.every((entry, index) => {
      if (!object(entry) || !object(saved[index])) return false
      const prefix = descriptor.type === 'blocks' ? `${descriptor.path}.${String(entry.blockType)}.` : `${descriptor.path}.`
      return Object.entries(entry).every(([key, value]) => valuesMatch(value, (saved[index] as Record<string, unknown>)[key], descriptor.children?.find(({ path }) => path === `${prefix}${key}`)))
    })
  }
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((entry, index) => valuesMatch(entry, actual[index]))
  if (object(expected)) return object(actual) && Object.entries(expected).every(([key, value]) => valuesMatch(value, actual[key]))
  return expected === actual
}
const assertWritten = (doc: Record<string, unknown>, fields: Record<string, unknown>, registry: EditorialRegistry): void => {
  for (const [path, value] of Object.entries(fields)) if (!valuesMatch(value, fieldValue(doc, path), writableField(registry, path))) {
    throw new Error('Editorial field write was denied or changed by the host; application was cancelled.')
  }
}

export interface CreateProposalArgs extends BuildGenerationInputArgs {
  req: PayloadRequest
  run?: string | number
  /** Trusted server-side override for testing or job adapters; output is still validated. */
  client?: NimClient
}

/** Create an unapplied proposal only. Host callers load doc in this locale without fallback. */
export const createProposal = async (args: CreateProposalArgs): Promise<SeoProposal> => {
  if (typeof window !== 'undefined') throw new NimGenerationError('server_only')
  const { options, req, run } = args
  if (!await allowSeo(options, ['generate', 'manage'])({ req })) {
    throw new Error('SEO generation permission is required.')
  }
  const input = await buildGenerationInput(args)
  let output: SeoProposalPayload | undefined
  let usage: NimUsage | undefined
  let errors: ProposalValidationDiagnostic[] | undefined
  try {
    const editorial = options.collections[input.collection].editorialFields
      ? { registry: resolveEditorialRegistry(options, input.collection), registries: options.editorialRegistries, locale: input.locale }
      : undefined
    const client = args.client ?? createNimClient(options.nim, editorial)
    // Keep the persistence boundary strict even with a trusted custom transport.
    const generated = await client.generate(input)
    usage = validateUsage(generated.usage)
    output = parseProposalOutput(generated.output, input, editorial)
  } catch (error) {
    if (error instanceof ProposalValidationError) errors = error.diagnostics
    else if (error instanceof NimGenerationError) {
      usage = validateUsage(error.usage)
      errors = error.diagnostics.length ? error.diagnostics : [{ code: error.code, message: error.message, path: '' }]
    } else errors = [{ code: 'generation_error', message: 'SEO proposal generation failed.', path: '' }]
  }
  const data: Omit<SeoProposal, 'id'> = {
    sourceCollection: input.collection,
    sourceID: input.sourceID,
    locale: input.locale,
    sourceFingerprint: input.fingerprint,
    ...(options.collections[input.collection].editorialFields ? { editorialSourceFingerprint: editorialFingerprint(args.doc, resolveEditorialRegistry(options, input.collection)) } : {}),
    sourceSnapshot: input,
    state: errors ? 'failed' : 'draft',
    ...(output ? { output } : {}),
    ...(usage ? { usage } : {}),
    ...(errors ? { errors } : {}),
    ...(req.user ? { actor: { collection: req.user.collection, userID: String(req.user.id) } } : {}),
    ...(run !== undefined ? { run } : {}),
  }
  // Persistence errors propagate: retrying here could duplicate a successfully written proposal.
  const saved = await req.payload.create({ collection: 'seo-proposals', data, req, overrideAccess: false, depth: 0 })
  return saved as unknown as SeoProposal
}

export type SeoProposalGroup = Exclude<keyof SeoProposalPayload, 'editorial'>

const proposalFields = {
  meta: ['title', 'description', 'canonical', 'robots', 'focusKeyphrase'],
  social: ['image', 'imageAlt', 'imageFilename', 'imageCaption', 'recommendedWidth', 'recommendedHeight', 'ogTitle', 'ogDescription', 'twitterCard'],
  citability: ['summary', 'sources', 'claims'],
} as const

export interface ApplyProposalArgs {
  options: ValidatedPluginOptions
  req: PayloadRequest
  /** Only the identity is trusted; state and output are reloaded on the server. */
  proposal: Pick<SeoProposal, 'id'>
  locale: string
  groups: readonly SeoProposalGroup[]
  editorialPaths?: readonly string[]
  relatedDraftIDs?: readonly string[]
  /** Explicitly apply the reconciled editorial graph to seo.schema. */
  applyGraph?: boolean
}

/** An editor's explicit application; always updates the latest draft without publishing. */
export const applyProposal = async ({ options, req, proposal: identity, locale, groups, editorialPaths = [], relatedDraftIDs = [], applyGraph = false }: ApplyProposalArgs): Promise<Document> => {
  if (typeof window !== 'undefined') throw new Error('SEO application is server-only.')
  if (!await allowSeo(options, ['apply', 'manage'])({ req })) throw new Error('SEO application permission is required.')
  if (!Array.isArray(groups) || groups.length > 4 || new Set(groups).size !== groups.length || groups.some((group) => !['meta', 'social', 'schema', 'citability'].includes(group))) {
    throw new Error('Select at least one valid SEO proposal group.')
  }
  if (!Array.isArray(editorialPaths) || editorialPaths.length > 500 || editorialPaths.some((path) => typeof path !== 'string') || new Set(editorialPaths).size !== editorialPaths.length
    || !Array.isArray(relatedDraftIDs) || relatedDraftIDs.length > 100 || relatedDraftIDs.some((id) => typeof id !== 'string') || new Set(relatedDraftIDs).size !== relatedDraftIDs.length
    || typeof applyGraph !== 'boolean' || (!groups.length && !editorialPaths.length && !applyGraph) || (applyGraph && groups.includes('schema'))) throw new Error('Select valid groups or editorial fields without conflicting graph selections.')
  if (!options.locales.includes(locale)) throw new Error('Unsupported SEO locale.')
  const ownsTransaction = await initTransaction(req)
  if (!await req.transactionID) {
    delete req.transactionID
    throw new Error('SEO application requires an effective database transaction; enable transactions in the host adapter.')
  }
  try {
    const proposal = await req.payload.findByID({ collection: 'seo-proposals', id: identity.id, req, overrideAccess: false, depth: 0 }) as unknown as SeoProposal
    if (proposal.state !== 'draft') throw new Error('Only draft SEO proposals can be applied.')
    if (proposal.locale !== locale) throw new Error('SEO proposal locale must match the active locale.')
    if (!Object.hasOwn(options.collections, proposal.sourceCollection)) throw new Error('Unknown SEO source collection.')
    const media = await Promise.all(proposal.sourceSnapshot.selectedMedia.map(({ id }) => req.payload.findByID({
      collection: options.collections[proposal.sourceCollection].mediaCollection, id, locale, fallbackLocale: false,
      depth: 0, req, overrideAccess: false,
    })))
    const output = parseProposalOutput(proposal.output, proposal.sourceSnapshot, options.collections[proposal.sourceCollection].editorialFields
      ? { registry: resolveEditorialRegistry(options, proposal.sourceCollection), registries: options.editorialRegistries, locale }
      : undefined)
    const doc = await req.payload.findByID({
      collection: proposal.sourceCollection, id: proposal.sourceID, locale, fallbackLocale: false,
      draft: true, depth: 0, req, overrideAccess: false,
    })
    const current = await buildGenerationInput({ options, collection: proposal.sourceCollection, doc, locale, selectedMedia: media })
    if (current.fingerprint !== proposal.sourceFingerprint) throw new Error('SEO proposal is stale; regenerate it before applying.')
    const applyingEditorial = editorialPaths.length > 0 || relatedDraftIDs.length > 0 || applyGraph
    const registry = options.collections[proposal.sourceCollection].editorialFields ? resolveEditorialRegistry(options, proposal.sourceCollection) : undefined
    const editorial = output.editorial
    if (applyingEditorial && (!registry || !editorial)) throw new Error('This proposal has no configured editorial fields.')
    if (applyingEditorial && (!proposal.editorialSourceFingerprint || proposal.editorialSourceFingerprint !== editorialFingerprint(doc, registry!))) throw new Error('Editorial proposal is stale; regenerate it before applying.')
    if (applyGraph && !editorial?.semanticGraph) throw new Error('This proposal has no editorial semantic graph.')
    if (applyingEditorial) {
      // The verified Drizzle adapters keep this predicate in one UPDATE with
      // atomic:true. Unknown adapters fail closed; the final normal update still
      // enforces proposal ACL/hooks before this transaction can commit.
      if (!['sqlite', 'postgres'].includes(req.payload.db.name) || !proposal.updatedAt || typeof req.payload.db.updateOne !== 'function') throw new Error('Editorial application requires an adapter supporting an atomic proposal claim.')
      const claimed = await req.payload.db.updateOne({ collection: 'seo-proposals', req, options: { atomic: true },
        where: { and: [{ id: { equals: proposal.id } }, { state: { equals: 'draft' } }, { updatedAt: { equals: proposal.updatedAt } }] }, data: { state: 'approved' },
      })
      if (!claimed || claimed.state !== 'approved') throw new Error('Only draft SEO proposals can be applied.')
    }
    const selectedFields: Record<string, unknown> = {}
    const createdRelated: { localId: string; collection: string; id: string | number }[] = []
    let graph: Record<string, unknown> | undefined
    if (applyingEditorial) {
      for (const path of editorialPaths) {
        writableField(registry!, path)
        const patch = editorial!.patches.find((patch) => patch.path === path)
        if (!patch) throw new Error('Select only proposed editorial fields.')
        selectedFields[path] = patch.value
      }
      // Preflight selection/dependency checks before creating any record. A graph-free
      // projection uses the same explicit reachability rules without needing IDs yet.
      buildAppliedGraph({ proposal: { ...editorial!, semanticGraph: undefined, graphBindings: undefined }, selectedPatches: editorialPaths, selectedDrafts: relatedDraftIDs })
      const selected = new Set(relatedDraftIDs)
      const resolved = new Map<string, string | number>()
      const resolvedGraph: Record<string, string> = {}
      const relations = new Map<string, AuthorizedRelation[]>()
      const draftRelations = new Map<string, AuthorizedRelation[]>()
      const createDraft = async (localId: string): Promise<void> => {
        if (resolved.has(localId)) return
        const draft = editorial!.relatedDrafts.find((entry) => entry.localId === localId)!
        for (const dependency of localDraftReferences(draft.fields)) {
          if (!selected.has(dependency)) throw new Error('Select every required related draft.')
          await createDraft(dependency)
        }
        const targetRegistry = resolveEditorialRegistry(options, draft.collection)
        const fields = resolveLocalReferences(draft.fields, resolved) as Record<string, unknown>
        const data = materialize(fields, targetRegistry)
        const authorized: AuthorizedRelation[] = []
        for (const [path, value] of Object.entries(fields)) await authorizeRelations(value, writableField(targetRegistry, path), req, locale, authorized)
        draftRelations.set(localId, authorized)
        const supportsDrafts = Boolean(req.payload.collections[draft.collection]?.config.versions?.drafts)
        const saved = await req.payload.create({ collection: draft.collection, locale, fallbackLocale: false, draft: supportsDrafts, data: { ...data, ...(supportsDrafts ? { _status: 'draft' } : {}) }, depth: 0, req, overrideAccess: false })
        // Read permission is required for every linked document, including a creation.
        const readable = await req.payload.findByID({ collection: draft.collection, id: saved.id, locale, fallbackLocale: false, draft: true, depth: 0, req, overrideAccess: false })
        assertWritten(readable, fields, targetRegistry)
        resolved.set(localId, saved.id)
        createdRelated.push({ localId, collection: draft.collection, id: saved.id })
        if (applyGraph) {
          const url = await options.collections[draft.collection].resolveURL({ doc: readable, locale })
          if (typeof url !== 'string') throw new Error('Related semantic graph requires a public host URL.')
          resolvedGraph[localId] = url.trim()
        }
      }
      for (const id of relatedDraftIDs) await createDraft(id)
      for (const path of editorialPaths) {
        selectedFields[path] = resolveLocalReferences(selectedFields[path], resolved)
        const descriptor = writableField(registry!, path)
        const authorized: AuthorizedRelation[] = []
        await authorizeRelations(selectedFields[path], descriptor, req, locale, authorized)
        if (hasRelations(descriptor)) relations.set(path, authorized)
      }
      if (applyGraph) {
        graph = buildAppliedGraph({ proposal: editorial!, selectedPatches: editorialPaths, selectedDrafts: relatedDraftIDs, resolvedDrafts: resolvedGraph, sourceURL: current.url, registry })
        await assertGraphIdentities(graph, editorial!, current.url, relations, draftRelations, resolvedGraph, options, locale)
      }
    }
    // Payload merges nested groups. Clear omitted optional values in selected groups
    // explicitly, without sending any unselected group (or source/status field).
    const seo = Object.fromEntries((groups as readonly SeoProposalGroup[]).map((group) => [group, group === 'schema' ? output.schema : {
      ...Object.fromEntries(proposalFields[group].map((field) => [field, null])), ...output[group],
    }]))
    if (graph) seo.schema = [graph]
    const data = { ...(editorialPaths.length ? materialize(selectedFields, registry!) : {}), ...(Object.keys(seo).length ? { seo } : {}) }
    const updated = await req.payload.update({
      collection: proposal.sourceCollection, id: proposal.sourceID, locale, fallbackLocale: false,
      data, draft: true, depth: 0, req, overrideAccess: false, overrideLock: false,
    })
    if (editorialPaths.length) assertWritten(updated, selectedFields, registry!)
    if (graph && !valuesMatch([graph], fieldValue(updated, 'seo.schema'))) throw new Error('Semantic graph write was denied or changed by the host; application was cancelled.')
    if (graph) {
      const resolvedSourceURL = await options.collections[proposal.sourceCollection].resolveURL({ doc: updated, locale })
      if ((typeof resolvedSourceURL === 'string' ? resolvedSourceURL.trim() || undefined : undefined) !== current.url) throw new Error('Applied source URL changed; regenerate the semantic graph before applying.')
    }
    const audit = { state: 'applied', appliedAt: new Date().toISOString(), actor: { collection: req.user!.collection, userID: String(req.user!.id) }, appliedSelection: { groups, editorialPaths, relatedDraftIDs, applyGraph, createdRelated } }
    const appliedProposal = await req.payload.update({
      collection: 'seo-proposals', id: proposal.id, req, overrideAccess: false, depth: 0,
      data: audit,
    })
    if (!valuesMatch(audit, appliedProposal)) throw new Error('Proposal application audit was denied or changed by the host; application was cancelled.')
    if (ownsTransaction) await commitTransaction(req)
    return updated
  } catch (error) {
    if (ownsTransaction) await killTransaction(req)
    throw error
  }
}
