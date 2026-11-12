import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'
import { allowSeo } from '../collections/shared.js'
import { withSchedulingAuthority } from '../collections/runAuthority.js'
import type { ValidatedPluginOptions } from '../types.js'
import type { GenerateProposalInput } from './generateProposal.js'

export type ScheduleSelection = {
  kind: 'batch'
  collections: string[]
  locales: string[]
  filter?: Record<string, unknown>
  documents?: Pick<GenerateProposalInput, 'collection' | 'sourceID' | 'locale'>[]
} | { kind: 'document'; document: GenerateProposalInput; collections: string[]; locales: string[] }

/** Server-only scheduling boundary: original actor, immutable scope, exact job binding. */
export const scheduleSeoRun = async (options: ValidatedPluginOptions, req: PayloadRequest, selection: ScheduleSelection) => {
  if (!await allowSeo(options, selection.kind === 'batch' ? ['manage'] : ['generate', 'manage'])({ req })) throw new Error('SEO scheduling permission is required.')
  if (!options.bulk) throw new Error('SEO bulk jobs are disabled.')
  let ownsTransaction = false
  try {
    ownsTransaction = await initTransaction(req)
    return await withSchedulingAuthority(req, async () => {
      // Single-document generators need not be managers. This override is confined
      // to server-authorized workflow bookkeeping; source/proposal access is never bypassed.
      const overrideAccess = selection.kind === 'document'
      const run = await req.payload.create({ collection: 'seo-runs', req, overrideAccess, depth: 0,
        data: { ...selection, state: 'queued', progress: { total: 0, completed: 0, failed: 0 } },
      })
      try {
        const job = await req.payload.jobs.queue({ task: selection.kind === 'batch' ? 'nim-seo-run-audit' : 'nim-seo-generate-proposal', input: { runID: String(run.id) }, req, overrideAccess: false })
        const saved = await req.payload.update({ collection: 'seo-runs', id: run.id, req, overrideAccess, depth: 0, data: { jobID: String(job.id) } })
        if (ownsTransaction) await commitTransaction(req)
        return { run: saved, jobID: job.id }
      } catch (error) {
        if (!ownsTransaction) await req.payload.update({ collection: 'seo-runs', id: run.id, req, overrideAccess, data: { state: 'failed', finishedAt: new Date().toISOString(), errors: [{ code: 'queue_error', message: 'SEO job could not be queued.' }] } })
        throw error
      }
    })
  } catch (error) {
    if (ownsTransaction) await killTransaction(req)
    throw error
  }
}
