import type { GroupField, PayloadRequest } from 'payload'

import type { ValidatedPluginOptions } from '../types.js'

type Permission = keyof ValidatedPluginOptions['permissions']

/** Resolve host role predicates on the server; no options are serialized into admin props. */
export const allowSeo = (options: ValidatedPluginOptions, permissions: Permission[]): ((args: { req: PayloadRequest }) => Promise<boolean>) =>
  async ({ req }: { req: PayloadRequest }) => {
    if (!req.user) return false
    for (const permission of permissions) {
      if (await options.permissions[permission]({ req })) return true
    }
    return false
  }

/** Collection plus string ID supports hosts with multiple auth collections and numeric/UUID IDs. */
export const actorField = (): GroupField => ({
  name: 'actor', type: 'group', fields: [
    { name: 'collection', type: 'text' },
    { name: 'userID', type: 'text' },
  ],
})
