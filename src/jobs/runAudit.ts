import type { TaskConfig, Where } from 'payload'
import { z } from 'zod'
import type { ValidatedPluginOptions } from '../types.js'
import { generateDocumentProposal } from './generateProposal.js'
import { loadScheduledRun, type RunResult } from './execution.js'

export const batchSchema = (options: ValidatedPluginOptions) => z.object({
  collections: z.array(z.string().refine((collection) => Object.hasOwn(options.collections, collection))).min(1).transform((values) => [...new Set(values)]),
  locales: z.array(z.string().refine((locale) => options.locales.includes(locale))).min(1).transform((values) => [...new Set(values)]),
  filter: z.record(z.string(), z.unknown()).optional(),
})
export const runAuditTask = (options: ValidatedPluginOptions): TaskConfig<{
  input: { runID: string }
  output: { runID: string; completed: number; failed: number }
}> => ({
  slug: 'nim-seo-run-audit', retries: 0,
  inputSchema: [{ name: 'runID', type: 'text', required: true }],
  outputSchema: [{ name: 'runID', type: 'text' }, { name: 'completed', type: 'number' }, { name: 'failed', type: 'number' }],
  handler: async ({ input, req: workerReq, job }) => {
    const { req, run } = await loadScheduledRun(options, workerReq, input.runID, job.id, 'batch')
    const result = () => ({ output: { runID: String(run.id), completed: run.progress.completed, failed: run.progress.failed } })
    if (!['queued', 'running'].includes(run.state)) return result()
    const save = async (data: Record<string, unknown>) => req.payload.update({ collection: 'seo-runs', id: run.id, req, overrideAccess: false, depth: 0, data })
    const errors = [...(run.errors ?? [])]
    const results = [...(run.results ?? [])]
    try {
      const selection = batchSchema(options).parse(run)
      run.progress = { total: 0, completed: results.filter(({ state }) => state === 'draft').length, failed: results.filter(({ state }) => state === 'failed').length }
      for (const collection of selection.collections) for (const locale of selection.locales) {
        const { totalDocs } = await req.payload.find({ collection, locale, fallbackLocale: false, draft: true, depth: 0, req, overrideAccess: false, where: selection.filter as Where, limit: 1, select: { id: true } })
        run.progress.total += totalDocs
      }
      await save({ state: 'running', startedAt: new Date().toISOString(), progress: run.progress })
      for (const collection of selection.collections) for (const locale of selection.locales) {
        let page = 1
        let hasNextPage = true
        while (hasNextPage) {
          // IDs only during enumeration; generation reloads one real localized draft.
          const docs = await req.payload.find({ collection, locale, fallbackLocale: false, draft: true, depth: 0, req, overrideAccess: false, where: selection.filter as Where, limit: 50, page, sort: 'id', select: { id: true } })
          for (const { id } of docs.docs) {
            const sourceID = String(id)
            if (results.some((entry) => entry.sourceCollection === collection && entry.sourceID === sourceID && entry.locale === locale)) continue
            const entry: RunResult = { sourceCollection: collection, sourceID, locale, state: 'failed' }
            try {
              // Recover a persisted proposal after interrupted run bookkeeping, without a second paid generation.
              const prior = await req.payload.find({ collection: 'seo-proposals', req, overrideAccess: false, depth: 0, limit: 1, where: { and: [{ run: { equals: run.id } }, { sourceCollection: { equals: collection } }, { sourceID: { equals: sourceID } }, { locale: { equals: locale } }] } })
              const generated = prior.docs[0] ? { proposal: prior.docs[0], audit: undefined } : await generateDocumentProposal(options, req, { collection, sourceID, locale }, run.id)
              const proposal = generated.proposal
              entry.proposalID = String(proposal.id)
              entry.state = proposal.state === 'failed' ? 'failed' : 'draft'
              if (generated.audit) entry.audit = generated.audit
              if (entry.state === 'failed') errors.push({ sourceCollection: collection, sourceID, locale, code: proposal.errors?.[0]?.code ?? 'generation_error', message: 'SEO proposal generation failed for this document.' })
            } catch {
              errors.push({ sourceCollection: collection, sourceID, locale, code: 'document_error', message: 'SEO processing could not be completed for this document.' })
            }
            results.push(entry)
            if (entry.state === 'failed') run.progress.failed += 1
            else run.progress.completed += 1
            // Commit every document's outcome before moving to the next one.
            await save({ progress: { ...run.progress }, errors: [...errors], results: [...results] })
          }
          hasNextPage = docs.hasNextPage
          page += 1
        }
      }
      await save({ state: 'completed', finishedAt: new Date().toISOString(), progress: run.progress, results, errors })
      return result()
    } catch {
      await save({ state: 'failed', finishedAt: new Date().toISOString(), progress: run.progress, results, errors: [...errors, { code: 'batch_error', message: 'SEO batch processing could not be completed.' }] })
      throw new Error('SEO batch processing could not be completed.')
    }
  },
})
