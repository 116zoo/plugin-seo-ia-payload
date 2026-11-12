import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { auditEndpoint } from '../../src/endpoints/audit.js'
import { generateDocumentProposal, generateProposalTask } from '../../src/jobs/generateProposal.js'
import { runAuditTask } from '../../src/jobs/runAudit.js'
import { fixture } from './endpointFixture.js'

let f: Awaited<ReturnType<typeof fixture>>
beforeAll(async () => { f = await fixture() }, 30_000)
afterAll(async () => { await f?.cleanup() })
const schedule = async (sourceID: string | number, locales = ['fr', 'en']) => {
  const response = await auditEndpoint(f.options).handler(await f.request('manager', { mode: 'batch', collections: ['posts'], locales, filter: { id: { equals: sourceID } } }))
  expect(response.status).toBe(202)
  return response.json()
}

describe('Payload jobs create proposals without application', () => {
  test('registers both plugin tasks alongside the host task and preserves host access', () => {
    expect(f.payload.config.jobs.tasks!.map(({ slug }) => slug)).toEqual(expect.arrayContaining(['host-task', 'nim-seo-generate-proposal', 'nim-seo-run-audit']))
    expect(generateProposalTask(f.options).slug).toBe('nim-seo-generate-proposal')
    expect(runAuditTask(f.options).slug).toBe('nim-seo-run-audit')
  })
  test('real unauthenticated worker restores the authorized manager and persists locale progress', async () => {
    const post = await f.post()
    const before = await f.payload.findByID({ collection: 'posts', id: post.id, locale: 'all', draft: true, depth: 0 })
    const { run, jobID } = await schedule(post.id)
    const job = await f.payload.findByID({ collection: 'payload-jobs', id: jobID })
    await f.payload.jobs.runByID({ id: jobID, overrideAccess: true, silent: true })
    const saved = await f.payload.findByID({ collection: 'seo-runs', id: run.id })
    expect(saved).toMatchObject({ state: 'completed', progress: { total: 2, completed: 2, failed: 0 }, startedAt: expect.any(String), finishedAt: expect.any(String) })
    expect(saved.results).toHaveLength(2)
    expect(saved.results).toEqual(expect.arrayContaining([expect.objectContaining({ sourceCollection: 'posts', sourceID: String(post.id), locale: 'fr', proposalID: expect.any(String), state: 'draft', audit: expect.objectContaining({ locale: 'fr' }) })]))
    const proposals = await f.payload.find({ collection: 'seo-proposals', where: { run: { equals: run.id } } })
    expect(proposals.docs).toHaveLength(2)
    expect(proposals.docs.map((doc) => doc.locale).sort()).toEqual(['en', 'fr'])
    expect(proposals.docs.every((doc) => doc.state === 'draft')).toBe(true)
    expect(await f.payload.findByID({ collection: 'posts', id: post.id, locale: 'all', draft: true, depth: 0 })).toEqual(before)
    const handler = runAuditTask(f.options).handler
    if (typeof handler !== 'function') throw new Error('Missing task handler')
    await handler({ input: { runID: String(run.id) }, req: await f.request(), job, tasks: {}, inlineTask: async () => ({ output: {} }) } as unknown as Parameters<typeof handler>[0])
    expect((await f.payload.find({ collection: 'seo-proposals', where: { run: { equals: run.id } } })).totalDocs).toBe(2)
  })
  test('records a per-document generation failure and continues other locales without leaking provider details', async () => {
    const post = await f.post()
    const { run, jobID } = await schedule(post.id)
    f.transport.mockImplementationOnce(async () => { throw new Error(`private body ${f.options.nim.apiKey}`) })
    await f.payload.jobs.runByID({ id: jobID, overrideAccess: true, silent: true })
    const saved = await f.payload.findByID({ collection: 'seo-runs', id: run.id })
    expect(saved).toMatchObject({ state: 'completed', progress: { total: 2, completed: 1, failed: 1 }, errors: [{ sourceCollection: 'posts', sourceID: String(post.id), locale: 'fr', code: 'transport_error' }] })
    expect(JSON.stringify(saved)).not.toContain(f.options.nim.apiKey)
    expect((await f.payload.find({ collection: 'seo-proposals', where: { run: { equals: run.id } } })).docs.map((proposal) => proposal.state).sort()).toEqual(['draft', 'failed'])
  })
  test('a forged second queued job cannot borrow the original manager run', async () => {
    const post = await f.post()
    const { run } = await schedule(post.id)
    const forged = await f.payload.jobs.queue({ task: 'nim-seo-run-audit', input: { runID: String(run.id) }, overrideAccess: true })
    const calls = f.transport.mock.calls.length
    await f.payload.jobs.runByID({ id: forged.id, overrideAccess: true, silent: true })
    expect((await f.payload.findByID({ collection: 'payload-jobs', id: forged.id })).hasError).toBe(true)
    expect(f.transport).toHaveBeenCalledTimes(calls)
    expect((await f.payload.findByID({ collection: 'seo-runs', id: run.id })).state).toBe('queued')
  })
  test('single generation task enforces authorization before reads and creates only proposals', async () => {
    const post = await f.post()
    const before = await f.payload.findByID({ collection: 'posts', id: post.id, locale: 'en', draft: true, depth: 0 })
    const denied = await f.payload.jobs.queue({ task: 'nim-seo-generate-proposal', input: { collection: 'posts', sourceID: String(post.id), locale: 'en' }, overrideAccess: true })
    const calls = f.transport.mock.calls.length
    await f.payload.jobs.runByID({ id: denied.id, overrideAccess: true, silent: true })
    expect((await f.payload.findByID({ collection: 'payload-jobs', id: denied.id })).hasError).toBe(true)
    expect(f.transport).toHaveBeenCalledTimes(calls)
    const allowed = await f.payload.jobs.queue({ task: 'nim-seo-generate-proposal', input: { collection: 'posts', sourceID: String(post.id), locale: 'en' }, overrideAccess: true })
    await f.payload.jobs.runByID({ id: allowed.id, req: await f.request('generator'), overrideAccess: true, silent: true })
    expect((await f.payload.find({ collection: 'seo-proposals', where: { sourceID: { equals: String(post.id) } } })).docs).toEqual([expect.objectContaining({ state: 'draft', locale: 'en' })])
    expect(await f.payload.findByID({ collection: 'posts', id: post.id, locale: 'en', draft: true, depth: 0 })).toEqual(before)
  })
  test('rechecks current manager permission before reading any source content', async () => {
    const post = await f.post()
    const { run, jobID } = await schedule(post.id)
    await f.payload.update({ collection: 'users', id: f.users.manager.id, data: { role: 'viewer' } })
    const calls = f.transport.mock.calls.length
    await f.payload.jobs.runByID({ id: jobID, overrideAccess: true, silent: true })
    expect(f.transport).toHaveBeenCalledTimes(calls)
    expect(await f.payload.findByID({ collection: 'seo-runs', id: run.id })).toMatchObject({ state: 'failed', errors: [expect.objectContaining({ code: 'permission_denied' })] })
    expect((await f.payload.find({ collection: 'seo-proposals', where: { run: { equals: run.id } } })).totalDocs).toBe(0)
    await f.payload.update({ collection: 'users', id: f.users.manager.id, data: { role: 'manager' } })
  })
  test('resumes persisted proposal bookkeeping without a second generation', async () => {
    const post = await f.post()
    const { run, jobID } = await schedule(post.id, ['fr'])
    await generateDocumentProposal(f.options, await f.request('manager'), { collection: 'posts', sourceID: post.id, locale: 'fr' }, run.id)
    await f.payload.update({ collection: 'seo-runs', id: run.id, data: { state: 'running' } })
    const calls = f.transport.mock.calls.length
    await f.payload.jobs.runByID({ id: jobID, overrideAccess: true, silent: true })
    expect(f.transport).toHaveBeenCalledTimes(calls)
    expect(await f.payload.findByID({ collection: 'seo-runs', id: run.id })).toMatchObject({ state: 'completed', progress: { total: 1, completed: 1, failed: 0 } })
    expect((await f.payload.find({ collection: 'seo-proposals', where: { run: { equals: run.id } } })).totalDocs).toBe(1)
  })
  test('paginates all matching documents and persists each document before advancing', async () => {
    const ids: (string | number)[] = []
    for (let index = 0; index < 51; index += 1) ids.push((await f.post(`Batch ${index}`)).id)
    const response = await auditEndpoint(f.options).handler(await f.request('manager', { mode: 'batch', collections: ['posts'], locales: ['fr'], filter: { id: { in: ids } } }))
    const { run, jobID } = await response.json()
    const checkpoints: number[] = []
    const hooks = f.payload.collections['seo-runs'].config.hooks.afterChange
    const hook: NonNullable<typeof hooks>[number] = ({ doc }) => { if (doc.id === run.id && doc.state === 'running') checkpoints.push(doc.progress.completed) }
    hooks.push(hook)
    try {
      await f.payload.jobs.runByID({ id: jobID, overrideAccess: true, silent: true })
      const saved = await f.payload.findByID({ collection: 'seo-runs', id: run.id })
      expect(saved).toMatchObject({ state: 'completed', progress: { total: 51, completed: 51, failed: 0 } })
      expect(saved.results).toHaveLength(51)
      expect(checkpoints).toEqual(Array.from({ length: 52 }, (_, index) => index))
      expect((await f.payload.find({ collection: 'seo-proposals', where: { run: { equals: run.id } } })).totalDocs).toBe(51)
    } finally { hooks.splice(hooks.indexOf(hook), 1) }
  }, 30_000)
  test('respects host source read filters during batch enumeration', async () => {
    const hidden = await f.post('Hidden')
    const { run, jobID } = await schedule(hidden.id)
    await f.payload.jobs.runByID({ id: jobID, overrideAccess: true, silent: true })
    expect(await f.payload.findByID({ collection: 'seo-runs', id: run.id })).toMatchObject({ state: 'completed', progress: { total: 0, completed: 0, failed: 0 } })
    expect((await f.payload.find({ collection: 'seo-proposals', where: { run: { equals: run.id } } })).totalDocs).toBe(0)
  })
})
