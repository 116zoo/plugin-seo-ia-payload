import { commitTransaction, initTransaction, killTransaction, type Endpoint } from 'payload'
import { allowSeo } from '../collections/shared.js'
import { batchSchema } from '../jobs/runAudit.js'
import { auditSeo } from '../services/audit.js'
import type { ValidatedPluginOptions } from '../types.js'
import { errorResponse, forbidden, readBody, SeoRequestError, sourceSchema } from './shared.js'
import { z } from 'zod'

export const auditEndpoint = (options: ValidatedPluginOptions): Endpoint => ({
  path: '/nim-seo/audit', method: 'post',
  handler: async (req) => {
    let ownsTransaction = false
    try {
      if (!await allowSeo(options, ['generate', 'apply', 'manage'])({ req })) return forbidden()
      const body = await readBody(req, z.record(z.string(), z.unknown()))
      if (body.mode === 'batch') {
        if (!await allowSeo(options, ['manage'])({ req })) return forbidden()
        if (!options.bulk) throw new SeoRequestError(400, 'bulk_disabled', 'SEO bulk jobs are disabled.')
        const parsed = batchSchema(options).safeParse(body)
        if (!parsed.success) throw new SeoRequestError(400, 'invalid_request', 'Invalid SEO batch parameters.')
        ownsTransaction = await initTransaction(req)
        const run = await req.payload.create({
          collection: 'seo-runs', req, overrideAccess: false, depth: 0,
          data: { ...parsed.data, state: 'queued', progress: { total: 0, completed: 0, failed: 0 }, actor: { collection: req.user!.collection, userID: String(req.user!.id) } },
        })
        try {
          const job = await req.payload.jobs.queue({ task: 'nim-seo-run-audit', input: { runID: String(run.id) }, req, overrideAccess: false })
          const saved = await req.payload.update({ collection: 'seo-runs', id: run.id, req, overrideAccess: false, depth: 0, data: { jobID: String(job.id) } })
          if (ownsTransaction) await commitTransaction(req)
          return Response.json({ run: saved, jobID: job.id }, { status: 202 })
        } catch (error) {
          if (!ownsTransaction) await req.payload.update({ collection: 'seo-runs', id: run.id, req, overrideAccess: false, data: { state: 'failed', finishedAt: new Date().toISOString(), errors: [{ code: 'queue_error', message: 'SEO batch could not be queued.' }] } })
          throw error
        }
      }
      if (body.mode !== undefined && body.mode !== 'document') throw new SeoRequestError(400, 'invalid_request', 'Unknown SEO audit mode.')
      const parsed = sourceSchema(options).safeParse(body)
      if (!parsed.success) throw new SeoRequestError(400, 'invalid_request', 'Invalid SEO audit parameters.')
      const { collection, sourceID, locale } = parsed.data
      const doc = await req.payload.findByID({ collection, id: sourceID, locale, fallbackLocale: false, draft: true, depth: 0, req, overrideAccess: false })
      return Response.json({ audit: auditSeo(doc, locale) })
    } catch (error) {
      if (ownsTransaction) await killTransaction(req)
      return errorResponse(error)
    }
  },
})
