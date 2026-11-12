import type { PayloadRequest } from 'payload'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { buildGenerationInput } from '../../src/services/content.js'
import { NimGenerationError } from '../../src/services/nim.js'
import { applyProposal, createProposal, type ApplyProposalArgs, type CreateProposalArgs, type SeoProposal } from '../../src/services/proposals.js'
import type { SeoProposalPayload, ValidatedPluginOptions } from '../../src/types.js'

const options: ValidatedPluginOptions = {
  collections: { posts: { titleField: 'title', localizedSourceFields: ['title', 'content'], mediaCollection: 'media', extractContent: ({ doc, locale }) => (doc.content as Record<string, string>)[locale], resolveURL: ({ locale }) => `https://site.test/${locale}/post` } },
  locales: ['fr', 'en'], bulk: false,
  editorialRegistries: {},
  nim: { baseURL: 'https://nim.test/v1', apiKey: 'private-fixture-key', model: 'fixture' },
  site: { defaultLocale: 'fr', organization: { name: 'Site', url: 'https://site.test' } },
  permissions: { generate: () => true, apply: () => false, manage: () => false },
}
const output: SeoProposalPayload = { meta: { title: 'Proposed title', description: 'Description' }, social: { image: 7 }, schema: [], citability: { summary: 'Summary' } }
const setup = () => {
  const create = vi.fn(async ({ data }) => ({ id: 42, ...data }))
  const req = { user: { id: 9, collection: 'users' }, payload: { create } } as unknown as PayloadRequest
  const generate = vi.fn(async () => ({ output: structuredClone(output) }))
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

  test('persists validated usage on successful and failed proposals outside the SEO output', async () => {
    const { args } = setup()
    args.client = { generate: async () => ({ output, usage: { promptTokens: 10, totalTokens: 15 } }) }
    expect(await createProposal(args)).toMatchObject({ state: 'draft', output, usage: { promptTokens: 10, totalTokens: 15 } })
    args.client = { generate: async () => { throw new NimGenerationError('invalid_output', undefined, { totalTokens: 20 }) } }
    const failed = await createProposal(args)
    expect(failed).toMatchObject({ state: 'failed', usage: { totalTokens: 20 } })
    expect(failed.output).toBeUndefined()
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
    generate.mockResolvedValue({ output: { ...output, social: { image: 'unselected-media-id' } } })
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

const setupApply = async () => {
  const generated = setup()
  const proposal = await createProposal(generated.args)
  const doc = structuredClone(generated.args.doc)
  doc.seo = {
    meta: { title: 'Approved title' }, social: { image: 99, ogTitle: 'Keep social' },
    schema: [{ '@type': 'Organization', name: 'Keep schema' }], citability: { summary: 'Keep summary' },
    status: { completeness: 'incomplete' },
  }
  const findByID = vi.fn(async ({ collection }) => structuredClone(collection === 'seo-proposals' ? proposal : collection === 'media' ? generated.args.selectedMedia![0] : doc))
  const update = vi.fn(async ({ collection, data }) => {
    if (collection === 'seo-proposals') return Object.assign(proposal, data)
    const seo = { ...doc.seo as object, ...data.seo }
    Object.assign(doc, { ...data, seo })
    return structuredClone(doc)
  })
  const db = { beginTransaction: vi.fn(async () => 'transaction-1'), commitTransaction: vi.fn(async () => undefined), rollbackTransaction: vi.fn(async () => undefined) }
  const req = { user: { id: 13, collection: 'editors' }, payload: { findByID, update, db } } as unknown as PayloadRequest
  const args: ApplyProposalArgs = {
    options: { ...options, permissions: { ...options.permissions, apply: () => true } },
    req, proposal: { id: proposal.id }, locale: 'en', groups: ['meta'],
  }
  return { args, proposal, doc, findByID, update, db }
}

describe('applyProposal', () => {
  test('applies only explicitly selected approved groups in the active locale and records application actor and date', async () => {
    const { args, doc, proposal, findByID, update, db } = await setupApply()
    const before = structuredClone(doc)
    const start = Date.now()
    const updated = await applyProposal(args)
    expect(updated.seo.meta.title).toBe('Proposed title')
    for (const group of ['social', 'schema', 'citability', 'status']) expect(updated.seo[group]).toEqual((before.seo as Record<string, unknown>)[group])
    expect(updated.title).toEqual(before.title)
    expect(updated.content).toEqual(before.content)
    expect(proposal).toMatchObject({ state: 'applied', actor: { collection: 'editors', userID: '13' }, appliedAt: expect.any(String) })
    expect(Date.parse(proposal.appliedAt!)).toBeGreaterThanOrEqual(start)
    const sourceRead = findByID.mock.calls.find(([query]) => query.collection === 'posts')![0]
    const sourceWrite = update.mock.calls.find(([query]) => query.collection === 'posts')![0]
    expect(sourceRead).toMatchObject({ locale: 'en', fallbackLocale: false, depth: 0, draft: true, req: args.req, overrideAccess: false })
    expect(sourceWrite).toMatchObject({ locale: 'en', fallbackLocale: false, depth: 0, draft: true, overrideAccess: false, overrideLock: false, req: args.req })
    expect(Object.keys(sourceWrite.data)).toEqual(['seo'])
    expect(Object.keys(sourceWrite.data.seo)).toEqual(['meta'])
    expect(db.commitTransaction).toHaveBeenCalledTimes(1)
  })

  test('rejects a stale source without writing approved SEO or changing proposal state', async () => {
    const { args, doc, update, proposal } = await setupApply()
    doc.content = { en: 'Edited after generation', fr: 'Texte français' }
    await expect(applyProposal(args)).rejects.toThrow(/stale/i)
    expect(update).not.toHaveBeenCalled()
    expect(proposal.state).toBe('draft')
  })

  test.each(['approved', 'applied', 'discarded', 'failed'] as const)('rejects persisted %s proposals even if the caller supplies a draft', async (state) => {
    const { args, proposal, update } = await setupApply()
    proposal.state = state
    args.proposal = { ...proposal, state: 'draft' } as SeoProposal
    await expect(applyProposal(args)).rejects.toThrow(/draft/i)
    expect(update).not.toHaveBeenCalled()
  })

  test('rejects a different active locale rather than copying or translating the proposal', async () => {
    const { args, update } = await setupApply()
    args.locale = 'fr'
    await expect(applyProposal(args)).rejects.toThrow(/locale/i)
    expect(update).not.toHaveBeenCalled()
  })

  test.each([[], ['status'], ['meta', 'unknown'], ['__proto__'], 'meta', null])('rejects invalid explicit group selection %j before loading content', async (groups) => {
    const { args, findByID, update } = await setupApply()
    args.groups = groups as unknown as ApplyProposalArgs['groups']
    await expect(applyProposal(args)).rejects.toThrow(/group/i)
    expect(findByID).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  test('authorizes authenticated application or management before loading the proposal or source', async () => {
    for (const user of [null, { id: 13, collection: 'editors' }]) {
      const { args, findByID, update, db } = await setupApply()
      args.req.user = user as PayloadRequest['user']
      args.options = { ...options, permissions: { ...options.permissions, apply: () => false } }
      await expect(applyProposal(args)).rejects.toThrow(/permission/i)
      expect(findByID).not.toHaveBeenCalled()
      expect(update).not.toHaveBeenCalled()
      expect(db.beginTransaction).not.toHaveBeenCalled()
    }
  })

  test('detects stale selected media metadata as well as stale source content', async () => {
    const { args, findByID, update } = await setupApply()
    const originalRead = findByID.getMockImplementation()!
    findByID.mockImplementation(async (query) => query.collection === 'media' ? { id: 7, filename: 'changed.jpg' } : originalRead(query))
    await expect(applyProposal(args)).rejects.toThrow(/stale/i)
    expect(update).not.toHaveBeenCalled()
  })

  test('revalidates saved model output and never applies a caller-supplied replacement', async () => {
    const { args, proposal, update } = await setupApply()
    proposal.output = { ...output, citability: { summary: 'x'.repeat(2001) } }
    args.proposal = { ...proposal, output } as SeoProposal
    await expect(applyProposal(args)).rejects.toThrow(/2000/)
    expect(update).not.toHaveBeenCalled()
  })

  test('supports multiple selected groups while preserving the remaining approved values', async () => {
    const { args, doc } = await setupApply()
    args.groups = ['social', 'schema', 'citability']
    const updated = await applyProposal(args)
    expect(updated.seo).toMatchObject({ social: output.social, schema: output.schema, citability: output.citability })
    expect(updated.seo.meta).toEqual((doc.seo as Record<string, unknown>).meta)
  })

  test('rolls back the source update if application bookkeeping fails', async () => {
    const { args, update, db } = await setupApply()
    const originalUpdate = update.getMockImplementation()!
    update.mockImplementation(async (query) => {
      if (query.collection === 'seo-proposals') throw new Error('Bookkeeping failed')
      return originalUpdate(query)
    })
    await expect(applyProposal(args)).rejects.toThrow('Bookkeeping failed')
    expect(db.rollbackTransaction).toHaveBeenCalledWith('transaction-1')
    expect(db.commitTransaction).not.toHaveBeenCalled()
  })

  test('requires an effective transaction before writing approved SEO or application bookkeeping', async () => {
    const { args, db, update } = await setupApply()
    db.beginTransaction.mockResolvedValue(null as unknown as string)
    await expect(applyProposal(args)).rejects.toThrow(/transaction/i)
    expect(update).not.toHaveBeenCalled()
    expect(args.req.transactionID).toBeUndefined()
  })

  test('joins an existing host transaction without committing it', async () => {
    const { args, db } = await setupApply()
    args.req.transactionID = 'host-transaction'
    await applyProposal(args)
    expect(db.beginTransaction).not.toHaveBeenCalled()
    expect(db.commitTransaction).not.toHaveBeenCalled()
    expect(args.req.transactionID).toBe('host-transaction')
  })
})
