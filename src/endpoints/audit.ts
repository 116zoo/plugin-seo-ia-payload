import type { Endpoint } from 'payload'
import { allowSeo } from '../collections/shared.js'
import { batchSchema } from '../jobs/runAudit.js'
import { scheduleSeoRun } from '../jobs/scheduling.js'
import { auditSeo } from '../services/audit.js'
import type { ValidatedPluginOptions } from '../types.js'
import { errorResponse, forbidden, readBody, SeoRequestError, sourceSchema } from './shared.js'
import { z } from 'zod'

export const auditEndpoint = (options: ValidatedPluginOptions): Endpoint => ({
  path: '/nim-seo/audit', method: 'post',
  handler: async (req) => {
    try {
      if (!await allowSeo(options, ['generate', 'apply', 'manage'])({ req })) return forbidden()
      const body = await readBody(req, z.record(z.string(), z.unknown()))
      if (body.mode === 'batch') {
        if (!await allowSeo(options, ['manage'])({ req })) return forbidden()
        if (!options.bulk) throw new SeoRequestError(400, 'bulk_disabled', 'SEO bulk jobs are disabled.')
        const parsed = batchSchema(options).safeParse(body)
        if (!parsed.success) throw new SeoRequestError(400, 'invalid_request', 'Invalid SEO batch parameters.')
        return Response.json(await scheduleSeoRun(options, req, { kind: 'batch', ...parsed.data }), { status: 202 })
      }
      if (body.mode !== undefined && body.mode !== 'document') throw new SeoRequestError(400, 'invalid_request', 'Unknown SEO audit mode.')
      const parsed = sourceSchema(options).safeParse(body)
      if (!parsed.success) throw new SeoRequestError(400, 'invalid_request', 'Invalid SEO audit parameters.')
      const { collection, sourceID, locale } = parsed.data
      const doc = await req.payload.findByID({ collection, id: sourceID, locale, fallbackLocale: false, draft: true, depth: 0, req, overrideAccess: false })
      return Response.json({ audit: auditSeo(doc, locale) })
    } catch (error) {
      return errorResponse(error)
    }
  },
})
