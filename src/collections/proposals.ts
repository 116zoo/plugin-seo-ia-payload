import type { CollectionConfig } from 'payload'

import type { ValidatedPluginOptions } from '../types.js'
import { actorField, allowSeo } from './shared.js'
import { allowProposalCreate, allowProposalSource } from './proposalAccess.js'

export const buildProposalsCollection = (options: ValidatedPluginOptions): CollectionConfig => ({
  slug: 'seo-proposals',
  admin: { group: 'SEO', useAsTitle: 'sourceID' },
  access: {
    admin: allowSeo(options, ['manage']),
    read: allowProposalSource(options, ['generate', 'apply', 'manage']),
    create: allowProposalCreate(options),
    update: allowProposalSource(options, ['apply', 'manage']),
    delete: allowProposalSource(options, ['manage']),
  },
  hooks: { beforeChange: [({ data, operation, originalDoc }) => {
    // A mutation cannot rebind an accessible proposal to somebody else's source.
    if (operation === 'update') for (const field of ['sourceCollection', 'sourceID', 'locale']) data[field] = originalDoc[field]
    return data
  }] },
  fields: [
    { name: 'sourceCollection', type: 'select', options: Object.keys(options.collections), required: true, index: true },
    { name: 'sourceID', type: 'text', required: true, index: true },
    { name: 'locale', type: 'select', options: options.locales, required: true, index: true },
    { name: 'sourceFingerprint', type: 'text', required: true },
    { name: 'editorialSourceFingerprint', type: 'text' },
    { name: 'sourceSnapshot', type: 'json' },
    { name: 'output', type: 'json' },
    { name: 'usage', type: 'json' },
    { name: 'diff', type: 'json' },
    { name: 'warnings', type: 'text', hasMany: true },
    { name: 'state', type: 'select', options: ['draft', 'approved', 'applied', 'discarded', 'failed'], defaultValue: 'draft', required: true, index: true },
    actorField(),
    { name: 'appliedAt', type: 'date' },
    { name: 'appliedSelection', type: 'json' },
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
