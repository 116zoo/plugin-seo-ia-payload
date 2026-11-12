import type { CollectionConfig } from 'payload'

import type { ValidatedPluginOptions } from '../types.js'
import { actorField, allowSeo } from './shared.js'

export const buildRunsCollection = (options: ValidatedPluginOptions): CollectionConfig => ({
  slug: 'seo-runs',
  admin: { group: 'SEO', useAsTitle: 'state' },
  access: {
    admin: allowSeo(options, ['manage']),
    read: allowSeo(options, ['manage']),
    create: allowSeo(options, ['manage']),
    update: allowSeo(options, ['manage']),
    delete: allowSeo(options, ['manage']),
  },
  fields: [
    { name: 'collections', type: 'select', options: Object.keys(options.collections), hasMany: true, required: true },
    // Avoid colliding with Payload SQL's reserved translation-table suffix.
    { name: 'locales', type: 'select', dbName: 'selected_locales', options: options.locales, hasMany: true, required: true },
    { name: 'filter', type: 'json' },
    { name: 'state', type: 'select', options: ['queued', 'running', 'completed', 'failed', 'cancelled'], defaultValue: 'queued', required: true, index: true },
    {
      name: 'progress', type: 'group', fields: [
        { name: 'total', type: 'number', min: 0, defaultValue: 0 },
        { name: 'completed', type: 'number', min: 0, defaultValue: 0 },
        { name: 'failed', type: 'number', min: 0, defaultValue: 0 },
      ],
    },
    actorField(),
    { name: 'startedAt', type: 'date' },
    { name: 'finishedAt', type: 'date' },
    { name: 'usage', type: 'json' },
    {
      name: 'errors', type: 'array', fields: [
        { name: 'sourceCollection', type: 'select', options: Object.keys(options.collections) },
        { name: 'sourceID', type: 'text' },
        { name: 'locale', type: 'select', options: options.locales },
        { name: 'code', type: 'text', required: true },
        { name: 'message', type: 'text', required: true },
      ],
    },
  ],
})
