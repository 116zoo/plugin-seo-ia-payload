import type { CollectionConfig } from 'payload'

import type { ValidatedPluginOptions } from '../types.js'
import { actorField, allowSeo } from './shared.js'

export const buildProposalsCollection = (options: ValidatedPluginOptions): CollectionConfig => ({
  slug: 'seo-proposals',
  admin: { group: 'SEO', useAsTitle: 'sourceID' },
  access: {
    admin: allowSeo(options, ['manage']),
    read: allowSeo(options, ['generate', 'apply', 'manage']),
    create: allowSeo(options, ['generate', 'manage']),
    update: allowSeo(options, ['apply', 'manage']),
    delete: allowSeo(options, ['manage']),
  },
  fields: [
    { name: 'sourceCollection', type: 'select', options: Object.keys(options.collections), required: true, index: true },
    { name: 'sourceID', type: 'text', required: true, index: true },
    { name: 'locale', type: 'select', options: options.locales, required: true, index: true },
    { name: 'sourceFingerprint', type: 'text', required: true },
    { name: 'sourceSnapshot', type: 'json' },
    { name: 'output', type: 'json' },
    { name: 'diff', type: 'json' },
    { name: 'warnings', type: 'text', hasMany: true },
    { name: 'state', type: 'select', options: ['draft', 'approved', 'applied', 'discarded', 'failed'], defaultValue: 'draft', required: true, index: true },
    actorField(),
    { name: 'appliedAt', type: 'date' },
    { name: 'run', type: 'relationship', relationTo: 'seo-runs' },
    {
      name: 'errors', type: 'array', fields: [
        { name: 'code', type: 'text', required: true },
        { name: 'message', type: 'text', required: true },
        { name: 'path', type: 'text' },
      ],
    },
  ],
})
