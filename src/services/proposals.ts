import type { PayloadRequest } from 'payload'

import { allowSeo } from '../collections/shared.js'
import type { SeoProposalPayload } from '../types.js'
import { buildGenerationInput, type BuildGenerationInputArgs, type GenerationInput } from './content.js'
import { createNimClient, NimGenerationError, type NimClient } from './nim.js'
import { parseProposalOutput, ProposalValidationError, type ProposalValidationDiagnostic } from './validation.js'

/** Persisted proposal shape, independent of a host project's generated Payload types. */
export interface SeoProposal {
  id: string | number
  sourceCollection: string
  sourceID: string
  locale: string
  sourceFingerprint: string
  sourceSnapshot: GenerationInput
  output?: SeoProposalPayload
  state: 'draft' | 'approved' | 'applied' | 'discarded' | 'failed'
  actor?: { collection?: string; userID?: string }
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
  let errors: ProposalValidationDiagnostic[] | undefined
  try {
    const client = args.client ?? createNimClient(options.nim)
    // Keep the persistence boundary strict even with a trusted custom transport.
    output = parseProposalOutput(await client.generate(input), input)
  } catch (error) {
    if (error instanceof ProposalValidationError) errors = error.diagnostics
    else if (error instanceof NimGenerationError) {
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
    ...(errors ? { errors } : {}),
    ...(req.user ? { actor: { collection: req.user.collection, userID: String(req.user.id) } } : {}),
    ...(run !== undefined ? { run } : {}),
  }
  // Persistence errors propagate: retrying here could duplicate a successfully written proposal.
  const saved = await req.payload.create({ collection: 'seo-proposals', data, req, overrideAccess: false, depth: 0 })
  return saved as unknown as SeoProposal
}
