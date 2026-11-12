import { afterAll, beforeAll, expect, test } from 'vitest'
import { auditEndpoint } from '../../src/endpoints/audit.js'
import { fixture } from './endpointFixture.js'

let f: Awaited<ReturnType<typeof fixture>>
beforeAll(async () => { f = await fixture() }, 30_000)
afterAll(async () => { await f?.cleanup() })
const audit = async (body: Record<string, unknown>, role = 'manager') => auditEndpoint(f.options).handler(await f.request(role, body))

test('central audit listing filters approved score/status before pagination without generation or writes', async () => {
  const complete = await f.post('Complet')
  const incomplete = await f.post('Incomplet')
  await f.post('Hidden')
  const media = await f.payload.create({ collection: 'media', data: { alt: 'Image' } })
  await f.payload.update({ collection: 'posts', id: complete.id, locale: 'fr', data: { seo: { meta: { title: 'Titre', description: 'Description' }, social: { image: media.id, imageAlt: 'Image', ogTitle: 'Titre', ogDescription: 'Description' }, schema: [{ '@context': 'https://schema.org', '@type': 'Article' }], citability: { summary: 'Résumé' } } } })
  const before = await f.payload.findByID({ collection: 'posts', id: complete.id, locale: 'all', draft: true })
  const calls = f.transport.mock.calls.length
  const response = await audit({ mode: 'list', collection: 'posts', locale: 'fr', status: 'complete', minScore: 100, maxScore: 100 })
  expect(response.status).toBe(200)
  const full = await response.json()
  expect(full.totalDocs).toBe(1)
  expect(full.docs).toEqual([expect.objectContaining({ sourceID: String(complete.id), title: 'Complet', locale: 'fr', audit: expect.objectContaining({ score: 100, completeness: 'complete' }) })])
  expect(full.docs[0]).not.toHaveProperty('content')
  const partial = await (await audit({ mode: 'list', collection: 'posts', locale: 'fr', status: 'incomplete', maxScore: 99 })).json()
  expect(partial.docs.map((doc: { sourceID: string }) => doc.sourceID)).toEqual([String(incomplete.id)])
  const first = await (await audit({ mode: 'list', collection: 'posts', locale: 'fr', limit: 1 })).json()
  const second = await (await audit({ mode: 'list', collection: 'posts', locale: 'fr', limit: 1, page: 2 })).json()
  expect(first).toMatchObject({ totalDocs: 2, hasNextPage: true })
  expect(second).toMatchObject({ totalDocs: 2, hasNextPage: false })
  expect(first.docs[0].sourceID).not.toBe(second.docs[0].sourceID)
  const english = await (await audit({ mode: 'list', collection: 'posts', locale: 'en', status: 'complete' })).json()
  expect(english.totalDocs).toBe(0)
  expect(f.transport).toHaveBeenCalledTimes(calls)
  expect((await f.payload.find({ collection: 'seo-runs' })).totalDocs).toBe(0)
  expect((await f.payload.find({ collection: 'seo-proposals' })).totalDocs).toBe(0)
  expect(await f.payload.findByID({ collection: 'posts', id: complete.id, locale: 'all', draft: true })).toEqual(before)
  expect((await audit({ mode: 'list', collection: 'posts', locale: 'fr' }, 'viewer')).status).toBe(403)
  expect((await audit({ mode: 'list', collection: 'posts', locale: 'all' })).status).toBe(400)
  const noBulk = await auditEndpoint({ ...f.options, bulk: false }).handler(await f.request('editor', { mode: 'list', collection: 'posts', locale: 'fr' }))
  expect(noBulk.status).toBe(200)
})

test('batch scheduling requires explicit document identities and generates only that immutable selection', async () => {
  const selected = await f.post('Selected')
  const unselected = await f.post('Unselected')
  const base = { mode: 'batch', collections: ['posts'], locales: ['fr'] }
  expect((await audit(base)).status).toBe(400)
  expect((await audit({ ...base, documents: [] })).status).toBe(400)
  expect((await audit({ ...base, documents: [{ collection: 'posts', sourceID: selected.id, locale: 'en' }] })).status).toBe(400)
  const response = await audit({ ...base, documents: [{ collection: 'posts', sourceID: selected.id, locale: 'fr' }] })
  expect(response.status).toBe(202)
  const { run, jobID } = await response.json()
  const changed = await f.payload.update({ collection: 'seo-runs', id: run.id, req: await f.request('manager'), overrideAccess: false, data: { documents: [{ collection: 'posts', sourceID: unselected.id, locale: 'fr' }] } })
  expect(changed.documents).toEqual(run.documents)
  await f.payload.jobs.runByID({ id: jobID, overrideAccess: true, silent: true })
  const proposals = await f.payload.find({ collection: 'seo-proposals', where: { run: { equals: run.id } } })
  expect(proposals.docs.map((proposal) => proposal.sourceID)).toEqual([String(selected.id)])
})
