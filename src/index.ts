import type { Plugin } from 'payload'

import type { NimSeoPluginOptions } from './types.js'

export type {
  CollectionSeoOptions,
  NimConfig,
  NimSeoPluginOptions,
  SeoProposalPayload,
} from './types.js'

/** Create a Payload config transformer. SEO behavior is added in subsequent tasks. */
export const nimSeoPlugin = (_options: NimSeoPluginOptions): Plugin => (config) => config
