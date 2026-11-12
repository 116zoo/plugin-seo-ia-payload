import type { Access, Where } from 'payload'
import type { ValidatedPluginOptions } from '../types.js'
import { allowSeo } from './shared.js'

/** Join workflow visibility to the host's current, locale-specific source ACL.
 * Returning a query (rather than filtering afterRead) also protects counts,
 * findByID, bulk updates and deletes. Never cache this across requests.
 */
export const allowProposalSource = (options: ValidatedPluginOptions, permissions: (keyof ValidatedPluginOptions['permissions'])[]): Access => async ({ req }) => {
  if (!await allowSeo(options, permissions)({ req })) return false
  const scopes: Where[] = []
  for (const collection of Object.keys(options.collections)) for (const locale of options.locales) {
    const accessible = await req.payload.find({
      collection, locale, fallbackLocale: false, draft: true, depth: 0,
      req, overrideAccess: false, pagination: false, select: { id: true },
    }).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'status' in error && error.status === 403) return { docs: [] }
      throw error
    })
    if (accessible.docs.length) scopes.push({ and: [
      { sourceCollection: { equals: collection } }, { locale: { equals: locale } },
      { sourceID: { in: accessible.docs.map(({ id }) => String(id)) } },
    ] })
  }
  const where: Where = scopes.length ? { or: scopes } : { id: { in: [] } }
  return where
}

export const allowProposalCreate = (options: ValidatedPluginOptions): Access => async ({ req, data }) => {
  if (!await allowSeo(options, ['generate', 'manage'])({ req })) return false
  if (!data || !Object.hasOwn(options.collections, data.sourceCollection) || !options.locales.includes(data.locale)) return false
  try {
    await req.payload.findByID({ collection: data.sourceCollection, id: data.sourceID, locale: data.locale, fallbackLocale: false, draft: true, depth: 0, req, overrideAccess: false })
    return true
  } catch { return false }
}
