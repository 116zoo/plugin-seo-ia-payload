'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { AuditDocument } from '../services/auditListing.js'
import { errorCopy, panelStyle, requestJSON, useSeoContext } from './shared.js'

interface Run {
  id: string | number; locales: string[]; state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress?: { total?: number; completed?: number; failed?: number }
  errors?: { code: string; sourceID?: string; locale?: string }[]
}
interface Listing { docs: AuditDocument[]; totalDocs: number; hasNextPage: boolean }
export interface AuditDashboardProps { locales: string[]; collections: string[]; bulk: boolean }

export function AuditDashboard({ locales, collections, bulk }: AuditDashboardProps) {
  const { locale, localeLabel, copy, api, permissions, supported } = useSeoContext(locales)
  const heading = useId()
  const [collection, setCollection] = useState(collections[0] ?? '')
  const [status, setStatus] = useState('all')
  const [minScore, setMinScore] = useState(0)
  const [maxScore, setMaxScore] = useState(100)
  const [page, setPage] = useState(1)
  const scope = `${api}:${locale}:${collection}:${status}:${minScore}:${maxScore}:${page}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const [selected, setSelected] = useState<string[]>([])
  const [listing, setListing] = useState<{ scope: string; value: Listing }>()
  const [runs, setRuns] = useState<{ locale: string; docs: Run[] }>()
  const [busy, setBusy] = useState<string>()
  const [notice, setNotice] = useState<{ scope: string; text: string; error?: boolean }>()
  const canAudit = permissions?.generate || permissions?.apply || permissions?.manage
  const loadRuns = useCallback(async (signal?: AbortSignal) => {
    if (!permissions?.manage || !supported || !bulk) return
    const query = new URLSearchParams({ 'where[locales][contains]': locale, sort: '-createdAt', limit: '10', depth: '0' })
    const response = await requestJSON<{ docs: Run[] }>(`${api}/seo-runs?${query}`, undefined, 'GET', signal)
    if (!signal?.aborted) setRuns({ locale, docs: response.docs.filter((run) => run.locales.includes(locale)) })
  }, [api, locale, permissions?.manage, supported, bulk])
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!canAudit || !supported) return
    setSelected([])
    const value = await requestJSON<Listing>(`${api}/nim-seo/audit`, { mode: 'list', collection, locale, status, minScore, maxScore, page }, 'POST', signal)
    if (scopeRef.current === scope && !signal?.aborted) setListing({ scope, value })
  }, [api, canAudit, supported, collection, locale, status, minScore, maxScore, page, scope])
  useEffect(() => {
    const controller = new AbortController()
    setSelected([]); setNotice(undefined); setBusy(undefined)
    void load(controller.signal).catch((error: unknown) => { if (!controller.signal.aborted && scopeRef.current === scope) setNotice({ scope, error: true, text: errorCopy(error, copy) }) })
    return () => controller.abort()
  }, [load, scope])
  useEffect(() => {
    const controller = new AbortController()
    void loadRuns(controller.signal).catch(() => undefined)
    return () => controller.abort()
  }, [loadRuns])
  const visible = listing?.scope === scope ? listing.value : undefined
  async function schedule() {
    const documents = visible?.docs.filter((doc) => selected.includes(doc.sourceID)).map(({ collection, sourceID, locale }) => ({ collection, sourceID, locale })) ?? []
    if (!documents.length) return
    setBusy(scope); setNotice(undefined)
    try {
      await requestJSON(`${api}/nim-seo/audit`, { mode: 'batch', collections: [collection], locales: [locale], documents })
      await loadRuns()
      if (scopeRef.current === scope) { setSelected([]); setNotice({ scope, text: copy.queued }) }
    } catch (error) { if (scopeRef.current === scope) setNotice({ scope, error: true, text: errorCopy(error, copy) }) }
    finally { if (scopeRef.current === scope) setBusy(undefined) }
  }
  if (!canAudit || !supported) return null
  return <section aria-labelledby={heading} style={panelStyle} aria-busy={busy === scope}>
    <h2 id={heading}>{copy.auditTitle} — {localeLabel}</h2>
    <p>{copy.localeNotice}</p><p>{copy.scoreNotice}</p>
    <fieldset disabled={busy === scope}><legend>{copy.auditFilters}</legend>
      <label>{copy.collection} <select value={collection} onChange={(event) => { setCollection(event.target.value); setPage(1) }}>{collections.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>{' '}
      <label>{copy.documentStatus} <select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1) }}><option value="all">{copy.allStatuses}</option><option value="incomplete">{copy.incomplete}</option><option value="complete">{copy.complete}</option></select></label>{' '}
      <label>{copy.minScore} <input type="number" min={0} max={100} value={minScore} onChange={(event) => { setMinScore(Number(event.target.value)); setPage(1) }} /></label>{' '}
      <label>{copy.maxScore} <input type="number" min={0} max={100} value={maxScore} onChange={(event) => { setMaxScore(Number(event.target.value)); setPage(1) }} /></label>
      <button type="button" onClick={() => void load().catch((error: unknown) => setNotice({ scope, error: true, text: errorCopy(error, copy) }))}>{copy.refreshAudits}</button>
    </fieldset>
    <p>{copy.documents}: {visible?.totalDocs ?? '…'}</p>
    {visible ? visible.docs.length ? <table><thead><tr><th>{copy.selectDocument}</th><th>{copy.document}</th><th>{copy.score}</th><th>{copy.documentStatus}</th></tr></thead><tbody>{visible.docs.map((doc) => <tr key={doc.sourceID}>
      <td>{bulk && permissions?.manage && <input type="checkbox" aria-label={`${copy.selectDocument}: ${doc.title} (${doc.sourceID})`} disabled={busy === scope} checked={selected.includes(doc.sourceID)} onChange={(event) => setSelected((previous) => event.target.checked ? [...previous, doc.sourceID] : previous.filter((id) => id !== doc.sourceID))} />}</td>
      <td>{doc.title} ({doc.sourceID})</td><td>{doc.audit.score}%</td><td>{doc.audit.completeness === 'complete' ? copy.complete : copy.incomplete}</td>
    </tr>)}</tbody></table> : <p>{copy.noDocuments}</p> : <p>{copy.loading}</p>}
    <button type="button" disabled={busy === scope || page === 1} onClick={() => setPage((value) => value - 1)}>{copy.previousPage}</button>
    <button type="button" disabled={busy === scope || !visible?.hasNextPage} onClick={() => setPage((value) => value + 1)}>{copy.nextPage}</button>
    <p role={notice?.scope === scope && notice.error ? 'alert' : 'status'} aria-live="polite">{notice?.scope === scope ? notice.text : ''}</p>
    {!bulk ? <p>{copy.bulkDisabled}</p> : permissions?.manage && <>
      <p>{copy.batchNotice}</p>
      <button type="button" disabled={busy === scope || !visible || selected.length === 0} onClick={() => void schedule()}>{copy.schedule} ({selected.length})</button>
      <button type="button" disabled={busy === scope} onClick={() => void loadRuns().catch((error: unknown) => setNotice({ scope, error: true, text: errorCopy(error, copy) }))}>{copy.refreshRuns}</button>
      <h3>{copy.runs}</h3>
      {runs?.locale === locale && runs.docs.length ? <ul>{runs.docs.map((run) => <li key={run.id}>
        {copy.run} {String(run.id)}: {copy.runStates[run.state]} — {copy.total}: {run.progress?.total ?? 0}, {copy.completed}: {run.progress?.completed ?? 0}, {copy.failures}: {run.progress?.failed ?? 0}
        {run.errors?.length ? <p>{copy.diagnostics}: {run.errors.map(({ code, sourceID }) => `${code}${sourceID ? ` (${sourceID})` : ''}`).join(', ')}</p> : null}
      </li>)}</ul> : <p>{copy.noRuns}</p>}
    </>}
  </section>
}
