import type { Field } from 'payload'

import type { ValidatedPluginOptions } from '../types.js'

/** Called with the target collection's options so its own media adapter is used. */
export const buildSeoFields = (options: ValidatedPluginOptions): Field[] => [{
  name: 'seo',
  type: 'group',
  localized: true,
  fields: [
    {
      name: 'meta', type: 'group', fields: [
        { name: 'title', type: 'text' },
        { name: 'description', type: 'textarea' },
        { name: 'canonical', type: 'text' },
        { name: 'robots', type: 'text' },
        { name: 'focusKeyphrase', type: 'text' },
      ],
    },
    {
      name: 'social', type: 'group', fields: [
        { name: 'image', type: 'relationship', relationTo: Object.values(options.collections)[0].mediaCollection },
        { name: 'imageAlt', type: 'text' },
        { name: 'imageFilename', type: 'text' },
        { name: 'imageCaption', type: 'textarea' },
        { name: 'recommendedWidth', type: 'number', min: 1 },
        { name: 'recommendedHeight', type: 'number', min: 1 },
        { name: 'ogTitle', type: 'text' },
        { name: 'ogDescription', type: 'textarea' },
        { name: 'twitterCard', type: 'select', options: ['summary', 'summary_large_image'] },
      ],
    },
    // Preserve the public proposal contract: schema is a list of JSON-LD graphs.
    { name: 'schema', type: 'json' },
    {
      name: 'citability', type: 'group', fields: [
        { name: 'summary', type: 'textarea', maxLength: 2000 },
        { name: 'sources', type: 'text', hasMany: true },
        { name: 'claims', type: 'text', hasMany: true },
      ],
    },
    {
      name: 'status', type: 'group', fields: [
        { name: 'lastValidatedAt', type: 'date' },
        { name: 'completeness', type: 'select', options: ['incomplete', 'complete'] },
        { name: 'warnings', type: 'text', hasMany: true },
      ],
    },
  ],
}]
