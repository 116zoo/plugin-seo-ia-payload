import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { generateProposalEndpoint } from '../../src/endpoints/generate.js'
import { applyProposalEndpoint } from '../../src/endpoints/apply.js'
import { auditEndpoint } from '../../src/endpoints/audit.js'
import { fixture, output } from './endpointFixture.js'

let f: Awaited<ReturnType<typeof fixture>>
beforeAll(async () => { f = await fixture() }, 30_000)
afterAll(async () => { await f?.cleanup() })
const generate = async (role: string | undefined, body: unknown) => generateProposalEndpoint(f.options).handler(await f.request(role, body))
const audit = async (role: string | undefined, body: unknown) => auditEndpoint(f.options).handler(await f.request(role, body))

describe('protected SEO endpoints with real Payload storage', () => {
  test('rejects anonymous/viewer before content reads or provider calls', async () => {
    const find = vi.spyOn(f.payload, 'findByID')
    const calls = f.transport.mock.calls.length
    for (const role of [undefined, 'viewer']) expect((await generate(role, { collection: 'posts', sourceID: 1, locale: 'fr' })).status).toBe(403)
    expect(find).not.toHaveBeenCalled()
    expect(f.transport).toHaveBeenCalledTimes(calls)
    find.mockRestore()
  })
  test('forbidden audit/application never read source or proposal records', async () => {
    const find = vi.spyOn(f.payload, 'findByID')
    expect((await audit('viewer', { collection: 'posts', sourceID: 1, locale: 'fr' })).status).toBe(403)
    expect((await applyProposalEndpoint(f.options).handler(await f.request('generator', { proposalID: 1, locale: 'fr', groups: ['meta'] }))).status).toBe(403)
    expect(find).not.toHaveBeenCalled()
    find.mockRestore()
  })
  test('rejects malformed JSON without querying records', async () => {
    const req = await f.request('editor')
    req.json = async () => { throw new SyntaxError('Untrusted malformed body') }
    const find = vi.spyOn(f.payload, 'findByID')
    expect((await generateProposalEndpoint(f.options).handler(req)).status).toBe(400)
    expect(find).not.toHaveBeenCalled()
    find.mockRestore()
  })
  test('generation loads exactly the selected locale/media and creates one unapplied draft', async () => {
    const post = await f.post()
    const before = await f.payload.findByID({ collection: 'posts', id: post.id, locale: 'en', draft: true, depth: 0 })
    const media = await f.payload.create({ collection: 'media', locale: 'en', data: { alt: 'Real image' } })
    const response = await generate('editor', { collection: 'posts', sourceID: post.id, locale: 'en', selectedMedia: [media.id], doc: { content: 'Forged' }, output: {}, nim: { apiKey: 'Forged' } })
    expect(response.status).toBe(201)
    const { proposal } = await response.json()
    expect(proposal).toMatchObject({ state: 'draft', locale: 'en', sourceSnapshot: { content: 'Content EN', selectedMedia: [{ id: media.id, alt: 'Real image' }] }, output })
    expect(JSON.stringify(proposal)).not.toContain(f.options.nim.apiKey)
    expect((await f.payload.find({ collection: 'seo-proposals', where: { sourceID: { equals: String(post.id) } } })).totalDocs).toBe(1)
    expect(await f.payload.findByID({ collection: 'posts', id: post.id, locale: 'en', draft: true, depth: 0 })).toEqual(before)
  })
  test.each([{ collection: 'unknown', sourceID: 1, locale: 'fr' }, { collection: 'posts', sourceID: 1, locale: 'all' }, { collection: 'posts', sourceID: {}, locale: 'fr' }, { collection: 'posts', sourceID: 1, locale: 'fr', selectedMedia: [{ id: 1, alt: 'Forged' }] }])('validates source identity before queries: %j', async (body) => {
    const find = vi.spyOn(f.payload, 'findByID')
    expect((await generate('editor', body)).status).toBe(400)
    expect(find).not.toHaveBeenCalled()
    find.mockRestore()
  })
  test('enforces host document read access and returns safe errors', async () => {
    const hidden = await f.post('Hidden')
    const response = await generate('editor', { collection: 'posts', sourceID: hidden.id, locale: 'fr' })
    expect([403, 404]).toContain(response.status)
    expect(JSON.stringify(await response.json())).not.toContain('Hidden')
  })
  test('application delegates selective apply with locale/stale checks and source draft preservation', async () => {
    const post = await f.post()
    const body = { collection: 'posts', sourceID: post.id, locale: 'fr' }
    const { proposal } = await (await generate('generator', body)).json()
    const apply = async (role: string, extra: unknown) => applyProposalEndpoint(f.options).handler(await f.request(role, extra))
    expect((await apply('generator', { proposalID: proposal.id, locale: 'fr', groups: ['citability'] })).status).toBe(403)
    expect((await apply('reviewer', { proposalID: proposal.id, locale: 'en', groups: ['citability'] })).status).toBe(409)
    expect((await apply('reviewer', { proposalID: proposal.id, locale: 'fr', groups: [] })).status).toBe(400)
    expect((await apply('reviewer', { proposalID: proposal.id, locale: 'fr', groups: ['citability'] })).status).toBe(200)
    const draft = await f.payload.findByID({ collection: 'posts', id: post.id, locale: 'fr', draft: true })
    expect(draft.seo.citability.summary).toBe(output.citability.summary)
    expect(draft.seo.meta.title).toBe('Approved FR')
    const published = await f.payload.findByID({ collection: 'posts', id: post.id, locale: 'fr', draft: false })
    expect(published.seo.citability.summary).toBe('Approved summary FR')
  })
  test('application maps stale drafts to a conflict without changes', async () => {
    const post = await f.post()
    const { proposal } = await (await generate('editor', { collection: 'posts', sourceID: post.id, locale: 'fr' })).json()
    await f.payload.update({ collection: 'posts', id: post.id, locale: 'fr', draft: true, data: { content: 'New source draft' } })
    const response = await applyProposalEndpoint(f.options).handler(await f.request('editor', { proposalID: proposal.id, locale: 'fr', groups: ['meta'] }))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'proposal_conflict' } })
    expect((await f.payload.findByID({ collection: 'posts', id: post.id, locale: 'fr', draft: true })).seo.meta.title).toBe('Approved FR')
  })
  test('audit reports existing approved values without any writes or provider calls', async () => {
    const post = await f.post()
    const create = vi.spyOn(f.payload, 'create'), update = vi.spyOn(f.payload, 'update')
    const calls = f.transport.mock.calls.length
    const response = await audit('reviewer', { collection: 'posts', sourceID: post.id, locale: 'en' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ audit: { locale: 'en', missing: expect.arrayContaining(['meta.description', 'citability.summary']) } })
    expect(create).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled(); expect(f.transport).toHaveBeenCalledTimes(calls)
    create.mockRestore(); update.mockRestore()
  })
  test('only managers may queue bulk runs; malformed requests never create a run', async () => {
    const create = vi.spyOn(f.payload, 'create')
    expect((await audit('editor', { mode: 'batch', collections: ['posts'], locales: ['fr', 'en'] })).status).toBe(403)
    expect((await audit('manager', { mode: 'batch', collections: ['posts'], locales: ['all'] })).status).toBe(400)
    expect(create).not.toHaveBeenCalled(); create.mockRestore()
    const response = await audit('manager', { mode: 'batch', collections: ['posts'], locales: ['fr', 'en'], filter: { id: { equals: '99999' } } })
    expect(response.status).toBe(202)
    const { run, jobID } = await response.json()
    expect(run).toMatchObject({ state: 'queued', collections: ['posts'], locales: ['fr', 'en'], actor: { userID: String(f.users.manager.id) }, jobID: String(jobID) })
    const job = await f.payload.findByID({ collection: 'payload-jobs', id: jobID })
    expect(job).toMatchObject({ taskSlug: 'nim-seo-run-audit', input: { runID: String(run.id) } })
  })
  test('host queue denial rolls back the run and preserves safe errors', async () => {
    const access = f.payload.config.jobs.access!.queue
    f.payload.config.jobs.access!.queue = () => false
    const before = (await f.payload.find({ collection: 'seo-runs' })).totalDocs
    try {
      const response = await audit('manager', { mode: 'batch', collections: ['posts'], locales: ['fr'] })
      expect(response.status).toBe(403)
      expect((await f.payload.find({ collection: 'seo-runs' })).totalDocs).toBe(before)
    } finally { f.payload.config.jobs.access!.queue = access }
  })
  test('single generation/audit remain available without bulk or a worker', async () => {
    const options = { ...f.options, bulk: false }
    expect((await auditEndpoint(options).handler(await f.request('manager', { mode: 'batch', collections: ['posts'], locales: ['fr'] }))).status).toBe(400)
    const post = await f.post()
    expect((await generateProposalEndpoint(options).handler(await f.request('editor', { collection: 'posts', sourceID: post.id, locale: 'fr' }))).status).toBe(201)
  })
})
