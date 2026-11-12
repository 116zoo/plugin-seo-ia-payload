import type { PayloadRequest } from 'payload'
import { z } from 'zod'
import type { ValidatedPluginOptions } from '../types.js'

export class SeoRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

export const identifier = z.union([z.string().trim().min(1), z.number().finite()])
export const sourceSchema = (options: ValidatedPluginOptions) => z.object({
  collection: z.string().refine((value) => Object.hasOwn(options.collections, value), 'Unknown SEO collection.'),
  sourceID: identifier,
  locale: z.string().refine((value) => options.locales.includes(value), 'Unsupported SEO locale.'),
  selectedMedia: z.array(identifier).max(100).default([]),
})

export const readBody = async <T>(req: PayloadRequest, schema: z.ZodType<T>): Promise<T> => {
  let body: unknown
  try { body = await req.json!() } catch { throw new SeoRequestError(400, 'invalid_request', 'A JSON request body is required.') }
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new SeoRequestError(400, 'invalid_request', 'Invalid SEO request parameters.')
  return parsed.data
}

/** Do not echo host hooks, database errors, provider responses or request content. */
export const errorResponse = (error: unknown): Response => {
  if (error instanceof SeoRequestError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
  const message = error instanceof Error ? error.message : ''
  if (['Only draft SEO proposals can be applied.', 'SEO proposal locale must match the active locale.', 'SEO proposal is stale; regenerate it before applying.', 'Editorial proposal is stale; regenerate it before applying.'].includes(message)) {
    return Response.json({ error: { code: 'proposal_conflict', message } }, { status: 409 })
  }
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined
  if (status === 403 || status === 404) return Response.json({ error: { code: status === 403 ? 'forbidden' : 'not_found', message: 'SEO resource is unavailable.' } }, { status })
  return Response.json({ error: { code: 'operation_failed', message: 'The SEO operation could not be completed.' } }, { status: 500 })
}

export const forbidden = (): Response => Response.json({ error: { code: 'forbidden', message: 'SEO permission is required.' } }, { status: 403 })
