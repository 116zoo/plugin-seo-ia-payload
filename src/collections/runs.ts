import type { CollectionConfig } from 'payload'

import type { ValidatedPluginOptions } from '../types.js'
import { actorField, allowSeo } from './shared.js'
import { isSchedulingRequest } from './runAuthority.js'

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
  hooks: {
    beforeChange: [({ data, originalDoc, operation, req }) => {
      if (operation === 'create') {
        // Ignore any submitted actor, including privileged Local API input.
        data.actor = req.user ? { collection: req.user.collection, userID: String(req.user.id) } : {}
        if (!isSchedulingRequest(req)) { data.jobID = null; data.kind = 'batch'; data.document = null; data.documents = null }
      } else {
        // Scheduling identity and scope cannot be rebound by managers or workers.
        for (const field of ['actor', 'kind', 'document', 'documents', 'collections', 'locales', 'filter']) data[field] = originalDoc?.[field] ?? (field === 'actor' ? {} : field === 'kind' ? 'batch' : null)
        data.jobID = originalDoc?.jobID || (isSchedulingRequest(req) ? data.jobID : null)
      }
      return data
    }],
  },
  fields: [
    { name: 'kind', type: 'select', options: ['batch', 'document'], defaultValue: 'batch', required: true, access: { create: ({ req }) => isSchedulingRequest(req), update: () => false } },
    { name: 'document', type: 'json', access: { create: ({ req }) => isSchedulingRequest(req), update: () => false } },
    { name: 'documents', type: 'json', access: { create: ({ req }) => isSchedulingRequest(req), update: () => false } },
    { name: 'collections', type: 'select', options: Object.keys(options.collections), hasMany: true, required: true },
    // Avoid colliding with Payload SQL's reserved translation-table suffix.
    { name: 'locales', type: 'select', dbName: 'selected_locales', options: options.locales, hasMany: true, required: true },
    { name: 'filter', type: 'json' },
    { name: 'jobID', type: 'text', index: true, access: { create: ({ req }) => isSchedulingRequest(req), update: ({ req }) => isSchedulingRequest(req) } },
    { name: 'results', type: 'json' },
    { name: 'state', type: 'select', options: ['queued', 'running', 'completed', 'failed', 'cancelled'], defaultValue: 'queued', required: true, index: true },
    {
      name: 'progress', type: 'group', fields: [
        { name: 'total', type: 'number', min: 0, defaultValue: 0 },
        { name: 'completed', type: 'number', min: 0, defaultValue: 0 },
        { name: 'failed', type: 'number', min: 0, defaultValue: 0 },
      ],
    },
    { ...actorField(), access: { create: () => false, update: () => false } },
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
