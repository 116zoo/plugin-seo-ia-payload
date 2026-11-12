import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { getPayload } from 'payload'

const directory = await mkdtemp(path.join(os.tmpdir(), 'nim-seo-browser-'))
const provider = createServer(async (req, res) => {
  let body = ''
  for await (const part of req) body += part
  const input = JSON.parse(JSON.parse(body).messages.find((message: { role: string }) => message.role === 'user').content) as { locale: string; title: string; url?: string }
  const french = input.locale === 'fr'
  const output = {
    meta: { title: french ? 'Proposition FR' : 'Proposal EN', description: french ? 'Description proposée en français.' : 'Proposed English description.' },
    social: { ogTitle: french ? 'Partage FR' : 'Share EN', ogDescription: 'Social preview', imageAlt: 'Example image', imageFilename: 'example.webp', imageCaption: 'Example caption', recommendedWidth: 1200, recommendedHeight: 630 },
    schema: [], citability: { summary: french ? 'Résumé proposé FR' : 'Proposed summary EN' },
    ...(input.title.startsWith('Editorial fixture') ? { editorial: {
      locale: input.locale,
      patches: [
        { path: 'title', operation: 'set', value: french ? 'Titre éditorial proposé FR' : 'Proposed editorial title EN' },
        { path: 'excerpt', operation: 'set', value: french ? 'Chapô proposé FR' : 'Proposed English excerpt' },
        { path: 'tags', operation: 'set', value: [{ localId: 'new-tag' }] },
      ],
      relatedDrafts: [{ collection: 'tags', localId: 'new-tag', locale: input.locale, fields: { name: french ? 'Art numérique' : 'Digital art' }, graphNodeId: 'draft:new-tag' }],
      semanticGraph: { '@context': 'https://schema.org', '@graph': [
        { '@id': input.url, '@type': 'Article', headline: french ? 'Titre éditorial proposé FR' : 'Proposed editorial title EN', description: french ? 'Chapô proposé FR' : 'Proposed English excerpt', about: { '@id': 'draft:new-tag' } },
        { '@id': 'draft:new-tag', '@type': 'Thing', name: french ? 'Art numérique' : 'Digital art' },
      ] },
      graphBindings: [
        { path: 'title', nodeId: input.url, properties: ['headline'] },
        { path: 'excerpt', nodeId: input.url, properties: ['description'] },
        { path: 'tags', nodeId: input.url, properties: ['about'] },
      ],
    } } : {}),
  }
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }))
})
await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
const address = provider.address()
if (!address || typeof address === 'string') throw new Error('Provider fixture failed to start')
Object.assign(process.env, {
  DATABASE_URL: `file:${path.join(directory, 'browser.db')}`,
  NIM_BASE_URL: `http://127.0.0.1:${address.port}/v1`, NIM_API_KEY: 'local-browser-provider',
  NIM_SEO_E2E: 'true', NEXT_TELEMETRY_DISABLED: '1',
})
const { default: config } = await import('./payload.config.js')
const payload = await getPayload({ config })
for (const role of ['admin', 'editor', 'viewer']) await payload.create({ collection: 'users', data: { email: `${role}@example.test`, password: 'local-browser-fixture-password', role } })
const post = await payload.create({ collection: 'posts', locale: 'fr', data: { title: 'Bonjour', slug: 'bonjour', content: 'Contenu français enregistré.', seo: { meta: { title: 'Validé FR' }, citability: { summary: 'Résumé validé FR' } } } })
await payload.update({ collection: 'posts', id: post.id, locale: 'en', data: { title: 'Hello', slug: 'hello', content: 'Saved English content.', seo: { meta: { title: 'Approved EN' } } } })
await payload.destroy()
const child = spawn('pnpm', ['exec', 'next', 'dev', 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', '3187'], { stdio: 'inherit', env: process.env })
let closing = false
async function close() {
  if (closing) return
  closing = true
  child.kill('SIGTERM')
  provider.close()
  await rm(directory, { recursive: true, force: true })
}
process.on('SIGTERM', () => { void close() })
process.on('SIGINT', () => { void close() })
child.on('exit', async (code) => { await close(); process.exit(code ?? 0) })
