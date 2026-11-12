import type { PayloadRequest, TaskConfig } from 'payload'
import { allowSeo } from '../collections/shared.js'
import { auditSeo } from '../services/audit.js'
import { createProposal } from '../services/proposals.js'
import type { ValidatedPluginOptions } from '../types.js'
import { sourceSchema } from '../endpoints/shared.js'

export interface GenerateProposalInput {
  collection: string
  sourceID: string | number
  locale: string
  selectedMedia?: (string | number)[]
}

/** Shared adapter: authorize, then fetch real locale/media records under host access. */
export const generateDocumentProposal = async (options: ValidatedPluginOptions, req: PayloadRequest, input: GenerateProposalInput, run?: string | number) => {
  if (!await allowSeo(options, ['generate', 'manage'])({ req })) throw new Error('SEO generation permission is required.')
  const parsed = sourceSchema(options).parse(input)
  const doc = await req.payload.findByID({
    collection: parsed.collection, id: parsed.sourceID, locale: parsed.locale, fallbackLocale: false,
    draft: true, depth: 0, req, overrideAccess: false,
  })
  const selectedMedia = await Promise.all(parsed.selectedMedia.map((id) => req.payload.findByID({
    collection: options.collections[parsed.collection].mediaCollection, id,
    locale: parsed.locale, fallbackLocale: false, depth: 0, req, overrideAccess: false,
  })))
  const proposal = await createProposal({ options, req, collection: parsed.collection, locale: parsed.locale, doc, selectedMedia, run })
  return { proposal, audit: auditSeo(doc, parsed.locale) }
}

/** Direct task execution requires an authenticated request with generation permission. */
export const generateProposalTask = (options: ValidatedPluginOptions): TaskConfig<{
  input: GenerateProposalInput
  output: { proposalID: string; state: string }
}> => ({
  slug: 'nim-seo-generate-proposal', retries: 0,
  inputSchema: [
    { name: 'collection', type: 'select', options: Object.keys(options.collections), required: true },
    { name: 'sourceID', type: 'text', required: true },
    { name: 'locale', type: 'select', options: options.locales, required: true },
    { name: 'selectedMedia', type: 'json' },
  ],
  outputSchema: [{ name: 'proposalID', type: 'text', required: true }, { name: 'state', type: 'text', required: true }],
  handler: async ({ input, req }) => {
    const { proposal } = await generateDocumentProposal(options, req, input)
    return { output: { proposalID: String(proposal.id), state: proposal.state } }
  },
})
