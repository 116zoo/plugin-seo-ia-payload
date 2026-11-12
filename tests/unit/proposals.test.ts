import type { PayloadRequest } from 'payload'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { buildGenerationInput } from '../../src/services/content.js'
import { NimGenerationError } from '../../src/services/nim.js'
import { createProposal, type CreateProposalArgs } from '../../src/services/proposals.js'
import type { SeoProposalPayload, ValidatedPluginOptions } from '../../src/types.js'

const options: ValidatedPluginOptions = {
  collections: { posts: { titleField: 'title', mediaCollection: 'media', extractContent: ({ doc, locale }) => (doc.content as Record<string, string>)[locale], resolveURL: ({ locale }) => `https://site.test/${locale}/post` } },
  locales: ['fr', 'en'], bulk: false,
  nim: { baseURL: 'https://nim.test/v1', apiKey: 'private-fixture-key', model: 'fixture' },
  site: { defaultLocale: 'fr', organization: { name: 'Site', url: 'https://site.test' } },
  permissions: { generate: () => true, apply: () => false, manage: () => false },
}
const output: SeoProposalPayload = { meta: { title: 'Proposed title', description: 'Description' }, social: { image: 7 }, schema: [], citability: { summary: 'Summary' } }
const setup = () => {
  const create = vi.fn(async ({ data }) => ({ id: 42, ...data }))
  const req = { user: { id: 9, collection: 'users' }, payload: { create } } as unknown as PayloadRequest
  const generate = vi.fn(async () => structuredClone(output))
  const args: CreateProposalArgs = {
    options, req, collection: 'posts', locale: 'en',
    doc: { id: 12, title: { en: 'English title', fr: 'Titre français' }, content: { en: 'English source', fr: 'Texte français' }, media: [{ id: 'unselected-media-id' }], seo: { meta: { title: 'Approved title' } } },
    selectedMedia: [{ id: 7, filename: 'photo.jpg', private: 'private-media-field' }], client: { generate },
  }
  return { args, create, generate }
}
afterEach(() => vi.unstubAllGlobals())

describe('createProposal', () => {
  test('persists one locale-specific draft with normalized snapshot, fingerprint, actor and optional run, without changing the source', async () => {
    const { args, create, generate } = setup()
    args.run = 3
    const before = structuredClone(args.doc)
    const expectedInput = await buildGenerationInput(args)
    const proposal = await createProposal(args)
    expect(proposal).toMatchObject({ id: 42, sourceCollection: 'posts', sourceID: '12', locale: 'en', state: 'draft', sourceFingerprint: expectedInput.fingerprint, sourceSnapshot: expectedInput, output, actor: { collection: 'users', userID: '9' }, run: 3 })
    expect(generate).toHaveBeenCalledWith(expectedInput)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ collection: 'seo-proposals', req: args.req, overrideAccess: false, depth: 0 }))
    expect(args.doc).toEqual(before)
    for (const excluded of ['private-fixture-key', 'unselected-media-id', 'private-media-field', 'Approved title', 'Texte français', 'Titre français']) expect(JSON.stringify(create.mock.calls[0][0].data)).not.toContain(excluded)
  })

  test('uses the configured NIM client by default', async () => {
    const { args } = setup()
    delete args.client
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }))))
    expect(await createProposal(args)).toMatchObject({ state: 'draft', output })
  })

  test('persists safe typed generation failures with no output', async () => {
    const { args, generate } = setup()
    generate.mockRejectedValue(new NimGenerationError('http_error'))
    const proposal = await createProposal(args)
    expect(proposal).toMatchObject({ state: 'failed', errors: [{ code: 'http_error', message: expect.any(String) }], sourceFingerprint: expect.any(String) })
    expect(proposal.output).toBeUndefined()
  })

  test('discards unexpected exception text before persisting a failed proposal', async () => {
    const { args, generate } = setup()
    generate.mockRejectedValue(new Error('private-fixture-key raw-private-body'))
    const proposal = await createProposal(args)
    expect(proposal).toMatchObject({ state: 'failed', errors: [{ code: 'generation_error', message: expect.any(String) }] })
    expect(JSON.stringify(proposal)).not.toMatch(/private-fixture-key|raw-private-body/)
  })

  test('revalidates client output before persistence and retains only safe parser diagnostics', async () => {
    const { args, generate } = setup()
    generate.mockResolvedValue({ ...output, social: { image: 'unselected-media-id' } })
    const proposal = await createProposal(args)
    expect(proposal).toMatchObject({ state: 'failed', errors: [expect.objectContaining({ code: 'unselected_media', path: 'social.image' })] })
    expect(proposal.output).toBeUndefined()
    expect(JSON.stringify(proposal)).not.toContain('unselected-media-id')
  })

  test('checks authenticated generation or management permission before extraction, NIM or persistence', async () => {
    for (const user of [null, { id: 9, collection: 'users' }]) {
      const { args, create, generate } = setup()
      args.req.user = user as PayloadRequest['user']
      args.options = { ...options, permissions: { ...options.permissions, generate: () => false } }
      await expect(createProposal(args)).rejects.toThrow(/permission/i)
      expect(generate).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
    }
  })

  test('does not turn persistence failures into a second failed write', async () => {
    const { args, create } = setup()
    create.mockRejectedValue(new Error('Database unavailable'))
    await expect(createProposal(args)).rejects.toThrow('Database unavailable')
    expect(create).toHaveBeenCalledTimes(1)
  })
})
