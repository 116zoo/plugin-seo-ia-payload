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
        groups: z.array(z.enum(['meta', 'social', 'schema', 'citability'])).max(4),
        editorialPaths: z.array(z.string().min(1).max(500)).max(500).default([]),
        relatedDraftIDs: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/)).max(100).default([]),
        applyGraph: z.boolean().default(false),
      }).strict().refine((value) => (value.groups.length > 0 || value.editorialPaths.length > 0 || value.applyGraph)
        && new Set(value.groups).size === value.groups.length
        && new Set(value.editorialPaths).size === value.editorialPaths.length
        && new Set(value.relatedDraftIDs).size === value.relatedDraftIDs.length
        && !(value.applyGraph && value.groups.includes('schema'))))
      const doc = await applyProposal({ options, req, proposal: { id: input.proposalID }, locale: input.locale, groups: input.groups, editorialPaths: input.editorialPaths, relatedDraftIDs: input.relatedDraftIDs, applyGraph: input.applyGraph })
      return Response.json({ doc })
    } catch (error) { return errorResponse(error) }
  },
})
