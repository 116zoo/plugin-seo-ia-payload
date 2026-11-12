import { afterEach, describe, expect, test, vi } from 'vitest'

import { buildGenerationInput } from '../../src/services/content.js'
import { createNimClient, NimGenerationError } from '../../src/services/nim.js'
import type { ValidatedPluginOptions } from '../../src/types.js'

const config = { baseURL: 'https://nim.test/v1/', apiKey: 'private-fixture-key', model: 'configured-model' }
const options: ValidatedPluginOptions = {
  collections: { posts: { titleField: 'title', localizedSourceFields: ['title', 'content'], mediaCollection: 'media', extractContent: ({ doc }) => String(doc.content), resolveURL: () => 'https://site.test/en/post' } },
  locales: ['fr', 'en'], bulk: false,
  editorialRegistries: {},
  nim: config,
  site: { defaultLocale: 'fr', organization: { name: 'Site', url: 'https://site.test' } },
  permissions: { generate: () => true, apply: () => true, manage: () => false },
}
const makeInput = () => buildGenerationInput({
  options, collection: 'posts', locale: 'en',
  doc: { id: 12, title: 'Title', content: 'English source', media: [{ id: 'unselected-media-id' }], seo: { meta: { title: 'approved-private-title' } } },
  selectedMedia: [{ id: 7, filename: 'photo.jpg', secret: 'private-media-field', related: { id: 'unselected-media-id' } }],
})
const output = () => ({ meta: { title: 'Proposed title', description: 'Description' }, social: { image: 7 }, schema: [], citability: { summary: 'Summary' } })
const completion = (content: unknown = JSON.stringify(output()), finish_reason = 'stop') => ({ choices: [{ message: { role: 'assistant', content }, finish_reason }] })
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

afterEach(() => vi.unstubAllGlobals())

describe('createNimClient', () => {
  test('posts JSON-only normalized selected-media context with the configured server bearer and parses the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(completion()))
    vi.stubGlobal('fetch', fetchMock)
    expect(await createNimClient(config).generate(await makeInput())).toEqual({ output: output() })
    expect(fetchMock).toHaveBeenCalledWith('https://nim.test/v1/chat/completions', expect.objectContaining({ method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer private-fixture-key' }, signal: expect.any(AbortSignal) }))
    const request = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(request).toMatchObject({ model: 'configured-model', stream: false, response_format: { type: 'json_object' } })
    expect(request.messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('2000') })
    expect(request.messages[0].content).toContain('schema')
    expect(JSON.parse(request.messages[1].content)).toMatchObject({ locale: 'en', content: 'English source', selectedMedia: [{ id: 7, filename: 'photo.jpg' }] })
    for (const excluded of ['private-fixture-key', 'unselected-media-id', 'private-media-field', 'approved-private-title']) expect(fetchMock.mock.calls[0][1].body).not.toContain(excluded)
  })

  test('supports a root NIM URL without duplicating the v1 prefix', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(completion()))
    vi.stubGlobal('fetch', fetchMock)
    await createNimClient({ ...config, baseURL: 'https://nim.test' }).generate(await makeInput())
    expect(fetchMock.mock.calls[0][0]).toBe('https://nim.test/v1/chat/completions')
  })

  test('retains only validated provider token counters separately from proposal output', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ...completion(), usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, secret: 'private-fixture-key', cost: 'untrusted billing' } })))
    const result = await createNimClient(config).generate(await makeInput())
    expect(result).toEqual({ output: output(), usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 } })
    expect(JSON.stringify(result)).not.toContain('private-fixture-key')
  })

  test.each([{ total_tokens: -1 }, { prompt_tokens: 'private-fixture-key' }, { completion_tokens: 1.5 }, { total_tokens: Number.MAX_SAFE_INTEGER + 1 }, { unknown: 'private' }])('ignores invalid or unknown usage without failing a valid proposal (%j)', async (usage) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ...completion(), usage })))
    expect(await createNimClient(config).generate(await makeInput())).toEqual({ output: output() })
  })

  test('retains safe usage for paid model or validation failures', async () => {
    for (const response of [completion('private raw output'), completion(JSON.stringify(output()), 'length')]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ...response, usage: { total_tokens: 18 } })))
      const failure = await createNimClient(config).generate(await makeInput()).catch((error: unknown) => error)
      expect(failure).toMatchObject({ usage: { totalTokens: 18 } })
      expect(JSON.stringify(failure)).not.toContain('private raw output')
    }
  })

  test.each([
    ['transport_error', () => Promise.reject(new Error('private-fixture-key raw-private-body'))],
    ['http_error', () => Promise.resolve(new Response('private-fixture-key raw-private-body', { status: 401 }))],
    ['invalid_response', () => Promise.resolve(new Response('raw-private-body', { status: 200 }))],
    ['invalid_response', () => Promise.resolve(reply({ choices: [] }))],
    ['invalid_response', () => Promise.resolve(reply(completion(null)))],
    ['model_error', () => Promise.resolve(reply({ error: { message: 'private-fixture-key raw-private-body' } }))],
    ['model_error', () => Promise.resolve(reply(completion(JSON.stringify(output()), 'length')))],
    ['model_error', () => Promise.resolve(reply({ choices: [{ message: { content: JSON.stringify(output()), refusal: 'raw-private-body' }, finish_reason: 'stop' }] }))],
    ['invalid_output', () => Promise.resolve(reply(completion('raw-private-body')))],
    ['invalid_output', () => Promise.resolve(reply(completion(JSON.stringify({ ...output(), social: { image: 'unselected-media-id' } }))))],
    ['invalid_output', () => Promise.resolve(reply(completion(JSON.stringify({ ...output(), citability: { summary: 'x'.repeat(2001) } }))))],
  ])('returns a safe typed %s without retaining raw content', async (code, fetchResponse) => {
    vi.stubGlobal('fetch', vi.fn(fetchResponse))
    const input = await makeInput()
    const error = await createNimClient(config).generate(input).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(NimGenerationError)
    expect(error).toMatchObject({ code, message: expect.any(String), diagnostics: expect.any(Array) })
    expect(error).not.toHaveProperty('cause')
    for (const secret of ['private-fixture-key', 'raw-private-body', 'unselected-media-id', 'x'.repeat(2001)]) expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(secret)
  })

  test.each(['https://user:secret@nim.test/v1', 'https://nim.test/v1?token=secret', 'javascript:alert(1)'])('rejects unsafe endpoint configuration without echoing it (%s)', (baseURL) => {
    expect(() => createNimClient({ ...config, baseURL })).toThrow(NimGenerationError)
  })

  test('refuses browser execution before touching the secret or transport', () => {
    vi.stubGlobal('window', {})
    expect(() => createNimClient(config)).toThrow(/server/i)
  })
})
