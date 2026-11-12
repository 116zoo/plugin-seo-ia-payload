import type { Endpoint } from 'payload'
import { allowSeo } from '../collections/shared.js'
import type { ValidatedPluginOptions } from '../types.js'
import { errorResponse, forbidden } from './shared.js'

/** Display hints only: every mutation still rechecks the real authenticated request. */
export const adminCapabilitiesEndpoint = (options: ValidatedPluginOptions): Endpoint => ({
  path: '/nim-seo/capabilities', method: 'get',
  handler: async (req) => {
    try {
      if (!req.user) return forbidden()
      const [generate, apply, manage] = await Promise.all([
        allowSeo(options, ['generate', 'manage'])({ req }),
        allowSeo(options, ['apply', 'manage'])({ req }),
        allowSeo(options, ['manage'])({ req }),
      ])
      return Response.json({ generate, apply, manage }, { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) { return errorResponse(error) }
  },
})
