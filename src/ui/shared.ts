'use client'

import { useConfig, useLocale, useTranslation } from '@payloadcms/ui'
import { useEffect, useState } from 'react'
import { translations } from '../translations/index.js'

export interface ActionPermissions { generate: boolean; apply: boolean; manage: boolean }
export class WorkflowError extends Error {
  constructor(readonly status: number) { super('SEO request failed') }
}
export async function requestJSON<T>(url: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method, credentials: 'same-origin', cache: 'no-store', signal,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new WorkflowError(response.status)
  return response.json() as Promise<T>
}

export const errorCopy = (error: unknown, copy: ReturnType<typeof translations>): string =>
  error instanceof WorkflowError && error.status === 403 ? copy.forbidden : error instanceof WorkflowError && error.status === 409 ? copy.conflict : copy.error

export function useSeoContext(locales: string[]) {
  const { config } = useConfig()
  const active = useLocale()
  const { i18n } = useTranslation()
  const locale = active?.code ?? ''
  const copy = translations(locale === 'fr' || locale === 'en' ? locale : i18n.language === 'fr' ? 'fr' : 'en')
  const api = config.routes.api.replace(/\/$/u, '')
  const [permissionState, setPermissions] = useState<{ api: string; value: ActionPermissions }>()
  useEffect(() => {
    const controller = new AbortController()
    void requestJSON<ActionPermissions>(`${api}/nim-seo/capabilities`, undefined, 'GET', controller.signal)
      .then((value) => setPermissions({ api, value })).catch(() => undefined)
    return () => controller.abort()
  }, [api])
  return {
    locale, copy, api, supported: locales.includes(locale),
    permissions: permissionState?.api === api ? permissionState.value : undefined,
    localeLabel: locale === 'fr' ? copy.fr : locale === 'en' ? copy.en : locale,
  }
}

export const panelStyle = { border: '1px solid var(--theme-elevation-200)', borderRadius: 4, padding: '1.5rem', marginBlock: '1.5rem' }
export const preStyle = { whiteSpace: 'pre-wrap' as const, overflowWrap: 'anywhere' as const, maxHeight: '20rem', overflow: 'auto', background: 'var(--theme-elevation-50)', padding: '0.75rem' }
