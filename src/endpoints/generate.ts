import type { Endpoint } from 'payload'
import { allowSeo } from '../collections/shared.js'
import { generateDocumentProposal } from '../jobs/generateProposal.js'
import type { ValidatedPluginOptions } from '../types.js'
import { errorResponse, forbidden, readBody, sourceSchema } from './shared.js'

export const generateProposalEndpoint = (options: ValidatedPluginOptions): Endpoint => ({
  path: '/nim-seo/generate', method: 'post',
  handler: async (req) => {
    try {
      if (!await allowSeo(options, ['generate', 'manage'])({ req })) return forbidden()
      const input = await readBody(req, sourceSchema(options))
      const { proposal } = await generateDocumentProposal(options, req, input)
      return Response.json({ proposal }, { status: 201 })
    } catch (error) { return errorResponse(error) }
  },
})
