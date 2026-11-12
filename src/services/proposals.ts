import { commitTransaction, initTransaction, killTransaction, type Document, type PayloadRequest } from 'payload'

import { allowSeo } from '../collections/shared.js'
import type { SeoProposalPayload, ValidatedPluginOptions } from '../types.js'
import { buildGenerationInput, type BuildGenerationInputArgs, type GenerationInput } from './content.js'
import { resolveEditorialRegistry } from './editorialSchema.js'
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
  sourceSnapshot: GenerationInput
  output?: SeoProposalPayload
  usage?: NimUsage
  state: 'draft' | 'approved' | 'applied' | 'discarded' | 'failed'
  actor?: { collection?: string; userID?: string }
  appliedAt?: string
  run?: string | number
  errors?: ProposalValidationDiagnostic[]
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
  groups: readonly [SeoProposalGroup, ...SeoProposalGroup[]]
}

/** An editor's explicit application; always updates the latest draft without publishing. */
export const applyProposal = async ({ options, req, proposal: identity, locale, groups }: ApplyProposalArgs): Promise<Document> => {
  if (typeof window !== 'undefined') throw new Error('SEO application is server-only.')
  if (!await allowSeo(options, ['apply', 'manage'])({ req })) throw new Error('SEO application permission is required.')
  if (!Array.isArray(groups) || !groups.length || groups.some((group) => !['meta', 'social', 'schema', 'citability'].includes(group))) {
    throw new Error('Select at least one valid SEO proposal group.')
  }
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
    // Payload merges nested groups. Clear omitted optional values in selected groups
    // explicitly, without sending any unselected group (or source/status field).
    const seo = Object.fromEntries(groups.map((group) => [group, group === 'schema' ? output.schema : {
      ...Object.fromEntries(proposalFields[group].map((field) => [field, null])), ...output[group],
    }]))
    const updated = await req.payload.update({
      collection: proposal.sourceCollection, id: proposal.sourceID, locale, fallbackLocale: false,
      data: { seo }, draft: true, depth: 0, req, overrideAccess: false, overrideLock: false,
    })
    await req.payload.update({
      collection: 'seo-proposals', id: proposal.id, req, overrideAccess: false, depth: 0,
      data: { state: 'applied', appliedAt: new Date().toISOString(), actor: { collection: req.user!.collection, userID: String(req.user!.id) } },
    })
    if (ownsTransaction) await commitTransaction(req)
    return updated
  } catch (error) {
    if (ownsTransaction) await killTransaction(req)
    throw error
  }
}
