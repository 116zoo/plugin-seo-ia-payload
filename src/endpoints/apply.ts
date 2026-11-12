import type { Endpoint } from 'payload'
import { z } from 'zod'
import { allowSeo } from '../collections/shared.js'
import { applyProposal } from '../services/proposals.js'
import type { ValidatedPluginOptions } from '../types.js'
import { errorResponse, forbidden, identifier, readBody } from './shared.js'

export const applyProposalEndpoint = (options: ValidatedPluginOptions): Endpoint => ({
  path: '/nim-seo/apply', method: 'post',
  handler: async (req) => {
    try {
      if (!await allowSeo(options, ['apply', 'manage'])({ req })) return forbidden()
      const input = await readBody(req, z.object({
        proposalID: identifier,
        locale: z.string().refine((locale) => options.locales.includes(locale)),
        groups: z.array(z.enum(['meta', 'social', 'schema', 'citability'])).min(1).max(4),
      }))
      const doc = await applyProposal({ options, req, proposal: { id: input.proposalID }, locale: input.locale, groups: input.groups as [typeof input.groups[number], ...typeof input.groups] })
      return Response.json({ doc })
    } catch (error) { return errorResponse(error) }
  },
})
