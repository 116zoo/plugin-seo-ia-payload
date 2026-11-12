'use client'

import { useDocumentInfo, useForm, useFormModified } from '@payloadcms/ui'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { SeoAudit } from '../services/audit.js'
import type { SeoProposalPayload } from '../types.js'
import { errorCopy, panelStyle, preStyle, requestJSON, useSeoContext, WorkflowError } from './shared.js'

type Group = keyof SeoProposalPayload
type Proposal = {
  id: string | number; sourceCollection: string; sourceID: string; locale: string; state: string
  output?: SeoProposalPayload; errors?: { code: string; path?: string }[]; warnings?: string[]
}
interface Media { id: string | number; filename?: string; alt?: string }
interface PanelState { scope: string; audit?: SeoAudit; proposals: Proposal[]; media: Media[] }
export interface SeoPanelProps { locales: string[]; mediaCollection: string }

/** Registered as a UI field; all persistence goes through authorized Payload HTTP APIs. */
export function SeoPanel({ locales, mediaCollection }: SeoPanelProps) {
  const { id, collectionSlug, data, setData } = useDocumentInfo()
  const form = useForm()
  const modified = useFormModified()
  const { locale, localeLabel, copy, api, permissions, supported } = useSeoContext(locales)
  const headingID = useId()
  const scope = `${api}:${collectionSlug}:${id}:${locale}`
  const currentScope = useRef(scope)
  currentScope.current = scope
  const [state, setState] = useState<PanelState>()
  const [selection, setSelection] = useState<{ scope: string; id: string }>()
  const [groups, setGroups] = useState<Group[]>([])
  const [selectedMedia, setSelectedMedia] = useState<(string | number)[]>([])
  const [pending, setPending] = useState<string>()
  const [notice, setNotice] = useState<{ scope: string; text: string; error?: boolean }>()
  const active = state?.scope === scope ? state : undefined
  const proposals = active?.proposals ?? []
  const proposal = proposals.find((item) => String(item.id) === (selection?.scope === scope ? selection.id : undefined)) ?? proposals[0]
  const busy = pending === scope
  const canRead = permissions && (permissions.generate || permissions.apply || permissions.manage)
  const saved = id !== undefined && Boolean(collectionSlug) && !modified
  const matches = useCallback((item: Proposal) => item.locale === locale && item.sourceCollection === collectionSlug && String(item.sourceID) === String(id), [locale, collectionSlug, id])

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!supported || !canRead || id === undefined || !collectionSlug) return
    const where = new URLSearchParams({
      'where[and][0][sourceCollection][equals]': collectionSlug,
      'where[and][1][sourceID][equals]': String(id), 'where[and][2][locale][equals]': locale,
      'where[and][3][state][in]': 'draft,failed', limit: '25', sort: '-createdAt', depth: '0',
    })
    const [audit, list, media] = await Promise.all([
      requestJSON<{ audit: SeoAudit }>(`${api}/nim-seo/audit`, { collection: collectionSlug, sourceID: id, locale }, 'POST', signal),
      requestJSON<{ docs: Proposal[] }>(`${api}/seo-proposals?${where}`, undefined, 'GET', signal),
      requestJSON<{ docs: Media[] }>(`${api}/${encodeURIComponent(mediaCollection)}?locale=${encodeURIComponent(locale)}&fallback-locale=none&depth=0&limit=100`, undefined, 'GET', signal)
        .catch((error: unknown) => {
          // Optional media access must not hide an otherwise authorized document workflow.
          if (error instanceof WorkflowError && (error.status === 403 || error.status === 404)) return { docs: [] }
          throw error
        }),
    ])
    if (currentScope.current === scope && !signal?.aborted) setState({ scope, audit: audit.audit.locale === locale ? audit.audit : undefined, proposals: list.docs.filter(matches), media: media.docs })
  }, [supported, canRead, id, collectionSlug, locale, api, mediaCollection, scope, matches])

  useEffect(() => {
    const controller = new AbortController()
    setGroups([]); setSelectedMedia([]); setPending(undefined); setNotice(undefined)
    void load(controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted && currentScope.current === scope) setNotice({ scope, text: errorCopy(error, copy), error: true })
    })
    return () => controller.abort()
  }, [load, scope])

  async function perform(action: 'generate' | 'apply' | 'reject' | 'refresh') {
    if (busy) return
    setPending(scope); setNotice(undefined)
    try {
      if (action === 'generate') {
        const result = await requestJSON<{ proposal: Proposal }>(`${api}/nim-seo/generate`, { collection: collectionSlug, sourceID: id, locale, selectedMedia })
        if (currentScope.current !== scope) return
        if (!matches(result.proposal)) throw new Error('Mismatched proposal')
        setSelection({ scope, id: String(result.proposal.id) }); setGroups([])
        await load()
        if (currentScope.current === scope) setNotice({ scope, text: result.proposal.state === 'failed' ? copy.failed : copy.generated, error: result.proposal.state === 'failed' })
      } else if (action === 'apply' && proposal && matches(proposal) && groups.length && saved) {
        const result = await requestJSON<{ doc: Record<string, unknown> }>(`${api}/nim-seo/apply`, { proposalID: proposal.id, locale, groups })
        if (currentScope.current !== scope) return
        // Replace the form's saved values so a subsequent Save cannot restore old SEO.
        await form.reset(result.doc)
        setData(result.doc)
        await load()
        if (currentScope.current === scope) setNotice({ scope, text: copy.applied })
      } else if (action === 'reject' && proposal && matches(proposal)) {
        await requestJSON(`${api}/seo-proposals/${encodeURIComponent(String(proposal.id))}`, { state: 'discarded' }, 'PATCH')
        await load()
        if (currentScope.current === scope) setNotice({ scope, text: copy.rejected })
      } else if (action === 'refresh') await load()
    } catch (error) {
      if (currentScope.current === scope) setNotice({ scope, text: errorCopy(error, copy), error: true })
    } finally { if (currentScope.current === scope) setPending(undefined) }
  }

  if (!supported) return <p>{copy.unsupportedLocale}</p>
  if (!canRead) return null
  const seo = (data?.seo ?? {}) as Partial<SeoProposalPayload>
  const output = proposal?.output
  const labels = { meta: copy.meta, social: copy.social, schema: copy.schema, citability: copy.citability }
  return <section aria-labelledby={headingID} style={panelStyle} aria-busy={busy}>
    <h2 id={headingID}>{copy.title} — {localeLabel}</h2>
    <p>{copy.localeNotice}</p>
    {!saved && <p>{copy.saveFirst}</p>}
    {active?.audit && <div>
      <h3>{copy.score}: {active.audit.score}/100</h3>
      <meter min={0} max={100} value={active.audit.score} aria-label={copy.score} />
      <p>{copy.scoreNotice}</p>
      {active.audit.missing.length > 0 && <p>{copy.missing}: {active.audit.missing.join(', ')}</p>}
      {active.audit.invalid.length > 0 && <p>{copy.invalid}: {active.audit.invalid.map(({ path, code }) => `${path} (${code})`).join(', ')}</p>}
    </div>}
    <p role={notice?.error && notice.scope === scope ? 'alert' : 'status'} aria-live="polite">{notice?.scope === scope ? notice.text : busy ? copy.busy : ''}</p>
    {permissions.generate && <>
      <fieldset disabled={busy || !saved}><legend>{copy.media}</legend>
        {active?.media.length ? active.media.map((media) => <label key={media.id} style={{ display: 'block' }}>
          <input type="checkbox" checked={selectedMedia.includes(media.id)} onChange={(event) => setSelectedMedia((previous) => event.target.checked ? [...previous, media.id] : previous.filter((id) => id !== media.id))} /> {media.filename ?? media.alt ?? String(media.id)}
        </label>) : <p>{copy.noMedia}</p>}
      </fieldset>
      <p>{copy.mediaNotice}</p>
      <button type="button" disabled={busy || !saved} onClick={() => void perform('generate')}>{busy ? copy.generating : copy.generate}</button>
    </>}
    <button type="button" disabled={busy || id === undefined} onClick={() => void perform('refresh')}>{copy.refresh}</button>
    {proposals.length > 1 && <label>{copy.selectProposal}<select value={String(proposal?.id ?? '')} disabled={busy} onChange={(event) => { setSelection({ scope, id: event.target.value }); setGroups([]) }}>
      {proposals.map((item) => <option key={item.id} value={String(item.id)}>{String(item.id)} ({item.locale})</option>)}
    </select></label>}
    {!proposal && <p>{copy.noProposal}</p>}
    {proposal?.errors?.length ? <p>{copy.diagnostics}: {proposal.errors.map(({ code, path }) => `${code}${path ? ` (${path})` : ''}`).join(', ')}</p> : null}
    {proposal?.warnings?.length ? <p>{copy.warnings}: {proposal.warnings.join(', ')}</p> : null}
    {output && <>
      <h3>{copy.changes}</h3>
      <fieldset disabled={busy || !permissions.apply || proposal.state !== 'draft'}><legend>{copy.selectGroups}</legend>
        {(Object.keys(labels) as Group[]).map((group) => <div key={group}>
          <label><input type="checkbox" checked={groups.includes(group)} onChange={(event) => setGroups((previous) => event.target.checked ? [...previous, group] : previous.filter((value) => value !== group))} /> {labels[group]}</label>
          <table style={{ width: '100%', tableLayout: 'fixed' }}><thead><tr><th>{copy.current}</th><th>{copy.proposed}</th></tr></thead>
            <tbody><tr><td><pre style={preStyle}>{JSON.stringify(seo[group] ?? null, null, 2)}</pre></td><td><pre style={preStyle}>{JSON.stringify(output[group], null, 2)}</pre></td></tr></tbody>
          </table>
        </div>)}
      </fieldset>
      <h3>{copy.ogPreview}</h3><strong>{output.social.ogTitle ?? output.meta.title}</strong><p>{output.social.ogDescription ?? output.meta.description}</p>
      <h3>{copy.imagePreview}</h3><dl>
        <dt>{copy.image}</dt><dd>{output.social.image ?? '—'}</dd>
        <dt>{copy.alt}</dt><dd>{output.social.imageAlt ?? '—'}</dd>
        <dt>{copy.filename}</dt><dd>{output.social.imageFilename ?? '—'}</dd>
        <dt>{copy.caption}</dt><dd>{output.social.imageCaption ?? '—'}</dd>
        <dt>{copy.dimensions}</dt><dd>{output.social.recommendedWidth ?? '—'} × {output.social.recommendedHeight ?? '—'}</dd>
      </dl>
      <h3>{copy.schema}</h3><pre style={preStyle}>{JSON.stringify(output.schema, null, 2)}</pre>
      {permissions.apply && <>
        <button type="button" disabled={busy || !saved || groups.length === 0 || proposal.state !== 'draft'} onClick={() => void perform('apply')}>{copy.apply}</button>
        <button type="button" disabled={busy || proposal.state !== 'draft'} onClick={() => void perform('reject')}>{copy.reject}</button>
      </>}
    </>}
  </section>
}
