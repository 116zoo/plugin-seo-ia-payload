import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { getPayload, type Payload } from 'payload'

const databaseDir = await mkdtemp(path.join(os.tmpdir(), 'payload-nim-seo-'))
process.env.DATABASE_URL = `file:${path.join(databaseDir, 'fixture.db')}`

let payload: Payload | undefined

try {
  const { default: config } = await import('./payload.config.js')
  payload = await getPayload({ config })

  assert.ok(payload.collections.media, 'The fixture must register media')
  assert.ok(payload.collections.posts, 'The fixture must register posts')

  const post = await payload.create({
    collection: 'posts',
    locale: 'fr',
    data: { title: 'Bonjour', slug: 'bonjour', content: 'Contenu français.' },
  })
  await payload.update({
    collection: 'posts',
    id: post.id,
    locale: 'en',
    data: { title: 'Hello', slug: 'hello', content: 'English content.' },
  })

  const french = await payload.findByID({
    collection: 'posts', id: post.id, locale: 'fr', fallbackLocale: false,
  })
  const english = await payload.findByID({
    collection: 'posts', id: post.id, locale: 'en', fallbackLocale: false,
  })
  assert.equal(french.title, 'Bonjour')
  assert.equal(english.title, 'Hello')
  console.log('Fixture startup passed: SQLite, media, posts, independent fr/en content.')
} finally {
  await payload?.destroy()
  await rm(databaseDir, { recursive: true, force: true })
}
