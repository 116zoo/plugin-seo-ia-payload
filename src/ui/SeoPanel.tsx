'use client'

import { useDocumentInfo, useForm, useFormBackgroundProcessing, useFormModified, useFormProcessing } from '@payloadcms/ui'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { SeoAudit } from '../services/audit.js'
import type { SeoProposalPayload } from '../types.js'
import { errorCopy, panelStyle, preStyle, requestJSON, useSeoContext, WorkflowError } from './shared.js'
import { EditorialProposalTree, editorialSelectionIssues, emptyEditorialSelection, type EditorialSelection } from './EditorialProposalTree.js'

type Group = Exclude<keyof SeoProposalPayload, 'editorial'>
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
  const processing = useFormProcessing()
  const backgroundProcessing = useFormBackgroundProcessing()
  const hostBusy = processing || backgroundProcessing
  const { locale, localeLabel, copy, api, permissions, supported } = useSeoContext(locales)
  const headingID = useId()
  const scope = `${api}:${collectionSlug}:${id}:${locale}`
  const currentScope = useRef(scope)
  currentScope.current = scope
  const [state, setState] = useState<PanelState>()
  const [selection, setSelection] = useState<{ scope: string; id: string }>()
  const [groupSelection, setGroupSelection] = useState<{ proposalKey: string; values: Group[] }>()
  const [editorialSelection, setEditorialSelection] = useState<{ proposalKey: string; values: EditorialSelection }>()
  const [selectedMedia, setSelectedMedia] = useState<(string | number)[]>([])
  const [pending, setPending] = useState<string>()
  const [notice, setNotice] = useState<{ scope: string; text: string; error?: boolean }>()
  const active = state?.scope === scope ? state : undefined
  const proposals = active?.proposals ?? []
  const proposal = proposals.find((item) => String(item.id) === (selection?.scope === scope ? selection.id : undefined)) ?? proposals[0]
  const proposalKey = JSON.stringify([scope, proposal?.id])
  const groups = groupSelection?.proposalKey === proposalKey ? groupSelection.values : []
  const editorial = proposal?.output?.editorial?.locale === locale ? proposal.output.editorial : undefined
  const editorialValues = editorialSelection?.proposalKey === proposalKey && editorial ? editorialSelection.values : emptyEditorialSelection()
  const editorialReady = !editorial || editorialSelectionIssues(editorial, editorialValues).length === 0
  const hasSelection = groups.length > 0 || editorialValues.editorialPaths.length > 0 || editorialValues.applyGraph
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
    setGroupSelection(undefined); setEditorialSelection(undefined); setSelectedMedia([]); setPending(undefined); setNotice(undefined)
    void load(controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted && currentScope.current === scope) setNotice({ scope, text: errorCopy(error, copy), error: true })
    })
    return () => controller.abort()
  }, [load, scope])

  // Automatic fallback after apply/reject needs a fresh editorial selection too.
  useEffect(() => { setGroupSelection(undefined); setEditorialSelection(undefined) }, [proposalKey])

  async function perform(action: 'generate' | 'apply' | 'reject' | 'refresh') {
    if (busy) return
    setPending(scope); setNotice(undefined)
    let unlockForm: (() => void) | undefined
    try {
      if (action === 'generate') {
        const result = await requestJSON<{ proposal: Proposal }>(`${api}/nim-seo/generate`, { collection: collectionSlug, sourceID: id, locale, selectedMedia })
        if (currentScope.current !== scope) return
        if (!matches(result.proposal)) throw new Error('Mismatched proposal')
        setSelection({ scope, id: String(result.proposal.id) }); setGroupSelection(undefined)
        await load()
        if (currentScope.current === scope) setNotice({ scope, text: result.proposal.state === 'failed' ? copy.failed : copy.generated, error: result.proposal.state === 'failed' })
      } else if (action === 'apply' && proposal && matches(proposal) && hasSelection && editorialReady && saved && !form.disabled && !hostBusy) {
        // The response replaces saved form values: prevent edits and host saves until
        // both the API mutation and the asynchronous form reset have completed.
        form.setDisabled(true)
        form.setProcessing(true)
        unlockForm = () => {
          form.setProcessing(false)
          form.setDisabled(false)
        }
        const result = await requestJSON<{ doc: Record<string, unknown> }>(`${api}/nim-seo/apply`, { proposalID: proposal.id, locale, groups, ...editorialValues })
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
    } finally {
      unlockForm?.()
      if (currentScope.current === scope) setPending(undefined)
    }
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
    {proposals.length > 1 && <label>{copy.selectProposal}<select value={String(proposal?.id ?? '')} disabled={busy} onChange={(event) => { setSelection({ scope, id: event.target.value }); setGroupSelection(undefined) }}>
      {proposals.map((item) => <option key={item.id} value={String(item.id)}>{String(item.id)} ({item.locale})</option>)}
    </select></label>}
    {!proposal && <p>{copy.noProposal}</p>}
    {proposal?.errors?.length ? <p>{copy.diagnostics}: {proposal.errors.map(({ code, path }) => `${code}${path ? ` (${path})` : ''}`).join(', ')}</p> : null}
    {proposal?.warnings?.length ? <p>{copy.warnings}: {proposal.warnings.join(', ')}</p> : null}
    {output && <>
      <h3>{copy.changes}</h3>
      <fieldset disabled={busy || !permissions.apply || proposal.state !== 'draft'}><legend>{copy.selectGroups}</legend>
        {(Object.keys(labels) as Group[]).map((group) => <div key={group}>
          <label><input type="checkbox" disabled={group === 'schema' && editorialValues.applyGraph} checked={groups.includes(group)} onChange={(event) => setGroupSelection((previous) => {
            const values = previous?.proposalKey === proposalKey ? previous.values : []
            return { proposalKey, values: event.target.checked ? [...values, group] : values.filter((value) => value !== group) }
          })} /> {labels[group]}</label>
          <table style={{ width: '100%', tableLayout: 'fixed' }}><thead><tr><th>{copy.current}</th><th>{copy.proposed}</th></tr></thead>
            <tbody><tr><td><pre style={preStyle}>{JSON.stringify(seo[group] ?? null, null, 2)}</pre></td><td><pre style={preStyle}>{JSON.stringify(output[group], null, 2)}</pre></td></tr></tbody>
          </table>
        </div>)}
      </fieldset>
      {editorial && <EditorialProposalTree key={proposalKey} proposal={editorial} locale={locale} current={data} selection={editorialValues}
        disabled={busy || !permissions.apply || proposal.state !== 'draft'} graphDisabled={groups.includes('schema')}
        onChange={(values) => setEditorialSelection({ proposalKey, values })} />}
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
        <button type="button" disabled={busy || hostBusy || form.disabled || !saved || !hasSelection || !editorialReady || proposal.state !== 'draft'} onClick={() => void perform('apply')}>{editorial ? copy.applySelection : copy.apply}</button>
        <button type="button" disabled={busy || proposal.state !== 'draft'} onClick={() => void perform('reject')}>{copy.reject}</button>
      </>}
    </>}
  </section>
}
