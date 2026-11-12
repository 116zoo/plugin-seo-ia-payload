import { createLocalReq, type PayloadRequest, type Where } from 'payload'
import { allowSeo } from '../collections/shared.js'
import type { SeoAudit } from '../services/audit.js'
import type { ValidatedPluginOptions } from '../types.js'
import type { GenerateProposalInput } from './generateProposal.js'
import type { NimUsage } from '../services/usage.js'

export interface RunError { sourceCollection?: string; sourceID?: string; locale?: string; code: string; message: string }
export interface RunResult { sourceCollection: string; sourceID: string; locale: string; proposalID?: string; state: string; audit?: SeoAudit; usage?: NimUsage }
export interface SeoRun {
  id: string | number
  jobID?: string
  kind: 'batch' | 'document'
  document?: GenerateProposalInput
  collections: string[]
  locales: string[]
  filter?: Where
  actor?: { collection?: string; userID?: string }
  state: string
  progress: { total: number; completed: number; failed: number }
  errors?: RunError[]
  results?: RunResult[]
}

/** Restore only immutable scheduling identity; the queue-draining request grants no authority. */
export const loadScheduledRun = async (options: ValidatedPluginOptions, workerReq: PayloadRequest, runID: string, jobID: string | number, kind: SeoRun['kind']) => {
  if (!options.bulk) throw new Error('SEO bulk jobs are disabled.')
  if (typeof runID !== 'string' || !runID.trim()) throw new Error('An authorized SEO scheduling record is required.')
  // Identity bootstrap only. Never read source content with privileged access.
  const run = await workerReq.payload.findByID({ collection: 'seo-runs', id: runID, depth: 0, req: workerReq, overrideAccess: true }) as unknown as SeoRun
  if (!run.jobID || run.jobID !== String(jobID) || (run.kind ?? 'batch') !== kind) throw new Error('SEO job does not match its authorized run.')
  const actor = run.actor
  const authCollection = actor?.collection ? workerReq.payload.collections[actor.collection] : undefined
  let req: PayloadRequest | undefined
  if (authCollection?.config.auth && actor?.collection && actor.userID) {
    try {
      const user = await workerReq.payload.findByID({ collection: actor.collection, id: actor.userID, depth: 0, req: workerReq, overrideAccess: true })
      req = await createLocalReq({ user: { ...user, collection: actor.collection } as NonNullable<PayloadRequest['user']> }, workerReq.payload)
    } catch { /* Deleted identities are rejected without exposing auth/database errors. */ }
  }
  if (!req || !await allowSeo(options, kind === 'batch' ? ['manage'] : ['generate', 'manage'])({ req })) {
    if (run.state === 'queued' || run.state === 'running') await workerReq.payload.update({
      collection: 'seo-runs', id: run.id, req: workerReq, overrideAccess: true,
      data: { state: 'failed', finishedAt: new Date().toISOString(), errors: [...(run.errors ?? []), { code: 'permission_denied', message: 'SEO scheduling permission is no longer available.' }] },
    })
    throw new Error('SEO scheduling permission is no longer available.')
  }
  return { run, req }
}
