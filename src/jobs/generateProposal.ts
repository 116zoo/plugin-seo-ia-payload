import type { PayloadRequest, TaskConfig } from 'payload'
import { allowSeo } from '../collections/shared.js'
import { auditSeo } from '../services/audit.js'
import { createProposal } from '../services/proposals.js'
import type { ValidatedPluginOptions } from '../types.js'
import { loadScheduledRun, type RunResult } from './execution.js'
import { scheduleSeoRun } from './scheduling.js'
import { sourceSchema } from '../endpoints/shared.js'

export interface GenerateProposalInput {
  collection: string
  sourceID: string | number
  locale: string
  selectedMedia?: (string | number)[]
}

/** Shared adapter: authorize, then fetch real locale/media records under host access. */
export const generateDocumentProposal = async (options: ValidatedPluginOptions, req: PayloadRequest, input: GenerateProposalInput, run?: string | number) => {
  if (!await allowSeo(options, ['generate', 'manage'])({ req })) throw new Error('SEO generation permission is required.')
  const parsed = sourceSchema(options).parse(input)
  const doc = await req.payload.findByID({
    collection: parsed.collection, id: parsed.sourceID, locale: parsed.locale, fallbackLocale: false,
    draft: true, depth: 0, req, overrideAccess: false,
  })
  const selectedMedia = await Promise.all(parsed.selectedMedia.map((id) => req.payload.findByID({
    collection: options.collections[parsed.collection].mediaCollection, id,
    locale: parsed.locale, fallbackLocale: false, depth: 0, req, overrideAccess: false,
  })))
  const proposal = await createProposal({ options, req, collection: parsed.collection, locale: parsed.locale, doc, selectedMedia, run })
  return { proposal, audit: auditSeo(doc, parsed.locale) }
}

/** Trusted host scheduling API; execution never inherits the queue runner's identity. */
export const queueGenerateProposal = async (options: ValidatedPluginOptions, req: PayloadRequest, input: GenerateProposalInput) => {
  if (!await allowSeo(options, ['generate', 'manage'])({ req })) throw new Error('SEO generation permission is required.')
  const document = sourceSchema(options).parse(input)
  return scheduleSeoRun(options, req, { kind: 'document', document, collections: [document.collection], locales: [document.locale] })
}

export const generateProposalTask = (options: ValidatedPluginOptions): TaskConfig<{
  input: { runID: string }
  output: { proposalID: string; state: string }
}> => ({
  slug: 'nim-seo-generate-proposal', retries: 0,
  inputSchema: [{ name: 'runID', type: 'text', required: true }],
  outputSchema: [{ name: 'proposalID', type: 'text', required: true }, { name: 'state', type: 'text', required: true }],
  handler: async ({ input, req: workerReq, job }) => {
    const { req, run } = await loadScheduledRun(options, workerReq, input.runID, job.id, 'document')
    if (run.state === 'completed' && run.results?.[0]?.proposalID) return { output: { proposalID: run.results[0].proposalID, state: run.results[0].state } }
    if (!['queued', 'running'].includes(run.state) || !run.document) throw new Error('SEO scheduled generation is unavailable.')
    // Only workflow lifecycle bookkeeping uses this override, allowing a generator
    // to execute its own authorized document job without manager collection access.
    const save = async (data: Record<string, unknown>) => req.payload.update({ collection: 'seo-runs', id: run.id, req, overrideAccess: true, depth: 0, data })
    try {
      await save({ state: 'running', startedAt: new Date().toISOString(), progress: { total: 1, completed: 0, failed: 0 } })
      const prior = await req.payload.find({ collection: 'seo-proposals', req, overrideAccess: false, depth: 0, limit: 1, where: { run: { equals: run.id } } })
      const generated = prior.docs[0] ? { proposal: prior.docs[0], audit: undefined } : await generateDocumentProposal(options, req, run.document, run.id)
      const { proposal, audit } = generated
      const state = proposal.state === 'failed' ? 'failed' : 'draft'
      const entry: RunResult = { sourceCollection: run.document.collection, sourceID: String(run.document.sourceID), locale: run.document.locale, proposalID: String(proposal.id), state, ...(audit ? { audit } : {}) }
      await save({ state: 'completed', finishedAt: new Date().toISOString(), progress: { total: 1, completed: state === 'draft' ? 1 : 0, failed: state === 'failed' ? 1 : 0 }, results: [entry], errors: state === 'failed' ? [{ sourceCollection: entry.sourceCollection, sourceID: entry.sourceID, locale: entry.locale, code: proposal.errors?.[0]?.code ?? 'generation_error', message: 'SEO proposal generation failed for this document.' }] : [] })
      return { output: { proposalID: String(proposal.id), state } }
    } catch {
      await save({ state: 'failed', finishedAt: new Date().toISOString(), progress: { total: 1, completed: 0, failed: 1 }, errors: [{ code: 'document_error', message: 'SEO scheduled generation could not be completed.' }] })
      throw new Error('SEO scheduled generation could not be completed.')
    }
  },
})
