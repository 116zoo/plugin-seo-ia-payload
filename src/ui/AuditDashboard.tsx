'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { errorCopy, panelStyle, requestJSON, useSeoContext } from './shared.js'

interface Run {
  id: string | number; locales: string[]; state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress?: { total?: number; completed?: number; failed?: number }
  errors?: { code: string; sourceID?: string; locale?: string }[]
}
export interface AuditDashboardProps { locales: string[]; collections: string[]; bulk: boolean }

export function AuditDashboard({ locales, collections, bulk }: AuditDashboardProps) {
  const { locale, localeLabel, copy, api, permissions, supported } = useSeoContext(locales)
  const heading = useId()
  const scope = `${api}:${locale}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const [selected, setSelected] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [runs, setRuns] = useState<{ scope: string; docs: Run[] }>()
  const [busy, setBusy] = useState<string>()
  const [notice, setNotice] = useState<{ scope: string; text: string; error?: boolean }>()
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!permissions?.manage || !supported || !bulk) return
    const query = new URLSearchParams({ 'where[locales][contains]': locale, sort: '-createdAt', limit: '10', depth: '0' })
    const response = await requestJSON<{ docs: Run[] }>(`${api}/seo-runs?${query}`, undefined, 'GET', signal)
    if (scopeRef.current === scope && !signal?.aborted) setRuns({ scope, docs: response.docs.filter((run) => run.locales.includes(locale)) })
  }, [api, locale, scope, permissions?.manage, supported, bulk])
  useEffect(() => {
    const controller = new AbortController()
    setSelected([]); setFilter(''); setNotice(undefined); setBusy(undefined)
    void load(controller.signal).catch((error: unknown) => { if (!controller.signal.aborted && scopeRef.current === scope) setNotice({ scope, error: true, text: errorCopy(error, copy) }) })
    return () => controller.abort()
  }, [load, scope])
  async function schedule() {
    let where: Record<string, unknown> | undefined
    if (filter.trim()) {
      try {
        const value: unknown = JSON.parse(filter)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid filter')
        where = value as Record<string, unknown>
      } catch { setNotice({ scope, error: true, text: copy.invalidFilter }); return }
    }
    setBusy(scope); setNotice(undefined)
    try {
      await requestJSON(`${api}/nim-seo/audit`, { mode: 'batch', collections: selected, locales: [locale], ...(where ? { filter: where } : {}) })
      await load()
      if (scopeRef.current === scope) setNotice({ scope, text: copy.queued })
    } catch (error) { if (scopeRef.current === scope) setNotice({ scope, error: true, text: errorCopy(error, copy) }) }
    finally { if (scopeRef.current === scope) setBusy(undefined) }
  }
  if (!permissions?.manage || !supported) return null
  return <section aria-labelledby={heading} style={panelStyle} aria-busy={busy === scope}>
    <h2 id={heading}>{copy.auditTitle} — {localeLabel}</h2>
    <p>{copy.localeNotice}</p>
    {!bulk ? <p>{copy.bulkDisabled}</p> : <>
      <p>{copy.batchNotice}</p>
      <fieldset disabled={busy === scope}><legend>{copy.collections}</legend>{collections.map((collection) => <label key={collection} style={{ display: 'block' }}>
        <input type="checkbox" checked={selected.includes(collection)} onChange={(event) => setSelected((previous) => event.target.checked ? [...previous, collection] : previous.filter((item) => item !== collection))} /> {collection}
      </label>)}</fieldset>
      <label style={{ display: 'block' }}>{copy.filter}<textarea value={filter} disabled={busy === scope} onChange={(event) => setFilter(event.target.value)} /></label>
      <button type="button" disabled={busy === scope || selected.length === 0} onClick={() => void schedule()}>{copy.schedule}</button>
      <button type="button" disabled={busy === scope} onClick={() => void load().catch((error: unknown) => setNotice({ scope, error: true, text: errorCopy(error, copy) }))}>{copy.refreshRuns}</button>
      <p role={notice?.scope === scope && notice.error ? 'alert' : 'status'} aria-live="polite">{notice?.scope === scope ? notice.text : ''}</p>
      <h3>{copy.runs}</h3>
      {runs?.scope === scope && runs.docs.length ? <ul>{runs.docs.map((run) => <li key={run.id}>
        {copy.run} {String(run.id)}: {copy.runStates[run.state]} — {copy.total}: {run.progress?.total ?? 0}, {copy.completed}: {run.progress?.completed ?? 0}, {copy.failures}: {run.progress?.failed ?? 0}
        {run.errors?.length ? <p>{copy.diagnostics}: {run.errors.map(({ code, sourceID }) => `${code}${sourceID ? ` (${sourceID})` : ''}`).join(', ')}</p> : null}
      </li>)}</ul> : <p>{copy.noRuns}</p>}
    </>}
  </section>
}
