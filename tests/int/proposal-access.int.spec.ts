import { afterAll, beforeAll, expect, test } from 'vitest'
import { generateDocumentProposal } from '../../src/jobs/generateProposal.js'
import { fixture } from './endpointFixture.js'

let f: Awaited<ReturnType<typeof fixture>>
beforeAll(async () => {
  f = await fixture()
  for (const role of ['editor', 'manager']) {
    const user = await f.payload.create({ collection: 'users', data: { email: `limited-${role}@example.test`, password: 'fixture-password', role, scope: 'limited' } })
    f.users[`limited-${role}`] = { ...user, collection: 'users' } as typeof f.users[string]
  }
}, 30_000)
afterAll(async () => { await f?.cleanup() })

test('proposal lists, counts, direct reads and reject mutations honor cross-user source access', async () => {
  const restricted = await f.post('Restricted')
  const { proposal } = await generateDocumentProposal(f.options, await f.request('manager'), { collection: 'posts', sourceID: restricted.id, locale: 'fr' })
  const accessible = await f.post('Accessible')
  const { proposal: visible } = await generateDocumentProposal(f.options, await f.request('manager'), { collection: 'posts', sourceID: accessible.id, locale: 'fr' })
  const req = await f.request('limited-editor')
  const found = await f.payload.find({ collection: 'seo-proposals', req, overrideAccess: false, where: { id: { in: [proposal.id, visible.id] } } })
  expect(found.totalDocs).toBe(1)
  expect(found.docs.map(({ id }) => id)).toEqual([visible.id])
  expect(JSON.stringify(found)).not.toContain('Restricted')
  expect(await f.payload.count({ collection: 'seo-proposals', req, overrideAccess: false, where: { id: { in: [proposal.id, visible.id] } } })).toMatchObject({ totalDocs: 1 })
  await expect(f.payload.findByID({ collection: 'seo-proposals', id: proposal.id, req, overrideAccess: false })).rejects.toMatchObject({ status: 404 })
  await expect(f.payload.update({ collection: 'seo-proposals', id: proposal.id, req, overrideAccess: false, data: { state: 'discarded' } })).rejects.toThrow()
  await expect(f.payload.update({ collection: 'seo-proposals', id: proposal.id, req, overrideAccess: false, data: { state: 'discarded', sourceID: String(accessible.id) } })).rejects.toThrow()
  const bulk = await f.payload.update({ collection: 'seo-proposals', where: { id: { equals: proposal.id } }, req, overrideAccess: false, data: { state: 'discarded' } })
  expect(bulk.docs).toEqual([])
  await expect(f.payload.delete({ collection: 'seo-proposals', id: proposal.id, req: await f.request('limited-manager'), overrideAccess: false })).rejects.toThrow()
  await expect(f.payload.create({ collection: 'seo-proposals', req, overrideAccess: false, data: { sourceCollection: 'posts', sourceID: String(restricted.id), locale: 'fr', sourceFingerprint: 'forged' } })).rejects.toThrow()
  expect((await f.payload.findByID({ collection: 'seo-proposals', id: proposal.id })).state).toBe('draft')
  expect((await f.payload.update({ collection: 'seo-proposals', id: visible.id, req, overrideAccess: false, data: { state: 'discarded', sourceID: String(restricted.id), locale: 'en' } }))).toMatchObject({ state: 'discarded', sourceID: String(accessible.id), locale: 'fr' })
})

test('revoked source access immediately removes existing proposal visibility and mutation rights per locale', async () => {
  const source = await f.post()
  const req = await f.request('manager')
  const fr = (await generateDocumentProposal(f.options, req, { collection: 'posts', sourceID: source.id, locale: 'fr' })).proposal
  const en = (await generateDocumentProposal(f.options, req, { collection: 'posts', sourceID: source.id, locale: 'en' })).proposal
  expect((await f.payload.findByID({ collection: 'seo-proposals', id: fr.id, req, overrideAccess: false })).id).toBe(fr.id)
  await f.payload.update({ collection: 'posts', id: source.id, locale: 'fr', data: { title: 'Hidden' } })
  const freshReq = await f.request('manager')
  const found = await f.payload.find({ collection: 'seo-proposals', req: freshReq, overrideAccess: false, where: { sourceID: { equals: String(source.id) } } })
  expect(found.totalDocs).toBe(1)
  expect(found.docs[0].id).toBe(en.id)
  await expect(f.payload.findByID({ collection: 'seo-proposals', id: fr.id, req: freshReq, overrideAccess: false })).rejects.toMatchObject({ status: 404 })
  await expect(f.payload.update({ collection: 'seo-proposals', id: fr.id, req: freshReq, overrideAccess: false, data: { state: 'discarded' } })).rejects.toThrow()
  await expect(f.payload.delete({ collection: 'seo-proposals', id: fr.id, req: freshReq, overrideAccess: false })).rejects.toThrow()
  expect((await f.payload.findByID({ collection: 'seo-proposals', id: fr.id })).state).toBe('draft')
})
