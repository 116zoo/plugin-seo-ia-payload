import type { PayloadRequest } from 'payload'
import { z } from 'zod'
import type { ValidatedPluginOptions } from '../types.js'
import { auditSeo, type SeoAudit } from './audit.js'

export interface AuditDocument { collection: string; sourceID: string; locale: string; title: string; audit: SeoAudit }
export const auditListingSchema = (options: ValidatedPluginOptions) => z.object({
  collection: z.string().refine((value) => Object.hasOwn(options.collections, value)),
  locale: z.string().refine((value) => options.locales.includes(value)),
  status: z.enum(['all', 'incomplete', 'complete']).default('all'),
  minScore: z.number().int().min(0).max(100).default(0),
  maxScore: z.number().int().min(0).max(100).default(100),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(25),
}).refine(({ minScore, maxScore }) => minScore <= maxScore)

/** Audit approved fields without persisting, calling NIM or scheduling jobs.
 * Compute before filtering/pagination so scores never depend on stale stored status.
 */
export const listAudits = async (options: ValidatedPluginOptions, req: PayloadRequest, input: z.infer<ReturnType<typeof auditListingSchema>>) => {
  const docs: AuditDocument[] = []
  let totalDocs = 0
  let sourcePage = 1
  let hasNextPage = true
  while (hasNextPage) {
    const sources = await req.payload.find({ collection: input.collection, locale: input.locale, fallbackLocale: false, draft: true, depth: 0, req, overrideAccess: false, limit: 100, page: sourcePage, sort: 'id' })
    for (const source of sources.docs) {
      const audit = auditSeo(source, input.locale)
      if (audit.score < input.minScore || audit.score > input.maxScore || (input.status !== 'all' && audit.completeness !== input.status)) continue
      if (totalDocs >= (input.page - 1) * input.limit && docs.length < input.limit) {
        const title = source[options.collections[input.collection].titleField]
        docs.push({ collection: input.collection, sourceID: String(source.id), locale: input.locale, title: typeof title === 'string' ? title : String(source.id), audit })
      }
      totalDocs += 1
    }
    hasNextPage = sources.hasNextPage
    sourcePage += 1
  }
  return { docs, totalDocs, page: input.page, totalPages: Math.ceil(totalDocs / input.limit), hasNextPage: input.page * input.limit < totalDocs }
}
