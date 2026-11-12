import { afterEach, expect, test } from 'vitest'
import { adminCapabilitiesEndpoint } from '../../src/endpoints/admin.js'
import { fixture } from './endpointFixture.js'

let context: Awaited<ReturnType<typeof fixture>> | undefined
afterEach(async () => { await context?.cleanup(); context = undefined })

test('admin capabilities evaluate real host predicates and expose only action flags', async () => {
  context = await fixture()
  const endpoint = adminCapabilitiesEndpoint(context.options)
  for (const [role, expected] of [
    ['viewer', { generate: false, apply: false, manage: false }],
    ['generator', { generate: true, apply: false, manage: false }],
    ['reviewer', { generate: false, apply: true, manage: false }],
    ['manager', { generate: true, apply: true, manage: true }],
  ] as const) {
    expect(await (await endpoint.handler(await context.request(role))).json()).toEqual(expected)
  }
  expect((await endpoint.handler(await context.request())).status).toBe(403)
})
