'use client'

import { useId } from 'react'
import type { EditorialPatch, EditorialProposalPayload } from '../types.js'
import { translations } from '../translations/index.js'
import { preStyle } from './shared.js'

export interface EditorialSelection { editorialPaths: string[]; relatedDraftIDs: string[]; applyGraph: boolean }
export const emptyEditorialSelection = (): EditorialSelection => ({ editorialPaths: [], relatedDraftIDs: [], applyGraph: false })
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const safePatch = ({ path }: EditorialPatch) => !path.split('.').some((part) => ['content', '__proto__', 'prototype', 'constructor'].includes(part.toLowerCase()))
const refs = (value: unknown): string[] => Array.isArray(value) ? value.flatMap(refs) : record(value)
  ? [...(typeof value.localId === 'string' ? [value.localId] : []), ...Object.values(value).flatMap(refs)] : []

/** UI feedback only: the server revalidates selection, schema, identities and authorization. */
export function editorialSelectionIssues(proposal: EditorialProposalPayload, selection: EditorialSelection): string[] {
  const selected = new Set(selection.relatedDraftIDs), required = new Set<string>()
  const visit = (value: unknown) => {
    for (const id of refs(value)) {
      if (required.has(id)) continue
      required.add(id)
      const draft = proposal.relatedDrafts.find((item) => item.localId === id)
      if (draft) visit(draft.fields)
    }
  }
  proposal.patches.filter((patch) => safePatch(patch) && selection.editorialPaths.includes(patch.path)).forEach((patch) => visit(patch.value))
  return [...new Set([...required].filter((id) => !selected.has(id)).concat([...selected].filter((id) => !required.has(id))))]
}

/** Provisional selected graph. Local draft IDs stay visible until server resolution. */
export function selectedGraphPreview(proposal: EditorialProposalPayload, selection: EditorialSelection) {
  const graph = proposal.semanticGraph
  if (!graph || editorialSelectionIssues(proposal, selection).length) return { '@context': 'https://schema.org', '@graph': [] }
  const allIDs = new Set(graph['@graph'].map((node) => node['@id']))
  let nodes = graph['@graph'].flatMap((node) => {
    if (typeof node['@id'] !== 'string') return []
    if (node['@id'].startsWith('draft:')) return selection.relatedDraftIDs.includes(node['@id'].slice(6)) ? [node] : []
    const properties = new Set(proposal.graphBindings?.filter((binding) => binding.nodeId === node['@id'] && selection.editorialPaths.includes(binding.path)).flatMap((binding) => binding.properties))
    const entries = Object.entries(node).filter(([property]) => properties.has(property))
    return entries.length ? [{ '@id': node['@id'], '@type': node['@type'], ...Object.fromEntries(entries) }] : []
  })
  for (let pass = 0; pass <= graph['@graph'].length; pass++) {
    const retained = new Set(nodes.map((node) => node['@id']))
    const prune = (value: unknown): unknown => {
      if (Array.isArray(value)) { const values = value.map(prune).filter((item) => item !== undefined); return values.length ? values : undefined }
      if (!record(value)) return value
      if (typeof value['@id'] === 'string' && allIDs.has(value['@id']) && !retained.has(value['@id'])) return undefined
      return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => { const result = prune(entry); return result === undefined ? [] : [[key, result]] }))
    }
    const next = nodes.map((node) => prune(node) as Record<string, unknown>).filter((node) => Object.keys(node).some((key) => !['@id', '@type'].includes(key)))
    if (next.length === nodes.length) { nodes = next; break }
    nodes = next
  }
  return { '@context': 'https://schema.org', '@graph': nodes }
}

interface TreeNode { name: string; path: string; patch?: EditorialPatch; children: Map<string, TreeNode> }
export interface EditorialProposalTreeProps {
  proposal: EditorialProposalPayload
  locale: string
  current?: Record<string, unknown>
  selection: EditorialSelection
  onChange: (selection: EditorialSelection) => void
  disabled?: boolean
  graphDisabled?: boolean
}

export function EditorialProposalTree({ proposal, locale, current = {}, selection, onChange, disabled, graphDisabled }: EditorialProposalTreeProps) {
  const headingID = useId()
  const copy = translations(locale === 'fr' ? 'fr' : 'en')
  if (proposal.locale !== locale) return null
  const tree: TreeNode = { name: '', path: '', children: new Map() }
  for (const patch of proposal.patches.filter(safePatch)) {
    let node = tree
    for (const part of patch.path.split('.')) {
      if (!node.children.has(part)) node.children.set(part, { name: part, path: node.path ? `${node.path}.${part}` : part, children: new Map() })
      node = node.children.get(part)!
    }
    node.patch = patch
  }
  const toggle = (key: 'editorialPaths' | 'relatedDraftIDs', value: string, checked: boolean) => onChange({ ...selection, [key]: checked ? [...selection[key], value] : selection[key].filter((item) => item !== value) })
  const label = (name: string) => name === 'title' ? copy.editorialTitle : name === 'excerpt' ? copy.editorialExcerpt : name === 'tags' ? copy.editorialTags : name
  const read = (path: string) => path.split('.').reduce<unknown>((value, key) => record(value) ? value[key] : undefined, current)
  const render = (nodes: Map<string, TreeNode>) => <ul>{[...nodes.values()].map((node) => <li key={node.path}>
    {node.patch ? <>
      <label><input type="checkbox" checked={selection.editorialPaths.includes(node.path)} onChange={(event) => toggle('editorialPaths', node.path, event.target.checked)} /> {label(node.name)} ({node.path})</label>
      <table style={{ width: '100%', tableLayout: 'fixed' }}><thead><tr><th>{copy.current}</th><th>{copy.proposed}</th></tr></thead><tbody><tr>
        <td><pre style={preStyle}>{JSON.stringify(read(node.path) ?? null, null, 2)}</pre></td><td><pre style={preStyle}>{JSON.stringify(node.patch.value, null, 2)}</pre></td>
      </tr></tbody></table>
      {node.patch.rationale && <p>{copy.rationale}: {node.patch.rationale}</p>}
    </> : <strong>{label(node.name)}</strong>}
    {node.children.size > 0 && render(node.children)}
  </li>)}</ul>
  const issues = editorialSelectionIssues(proposal, selection)
  const drafts = proposal.relatedDrafts.filter((draft) => draft.locale === locale)
  return <section aria-labelledby={headingID}>
    <h3 id={headingID}>{copy.editorial}</h3>
    <p>{copy.contentPreserved}</p><p>{copy.editorialLocaleNotice}</p>
    <fieldset disabled={disabled}><legend>{copy.selectEditorial}</legend>{render(tree.children)}
      {drafts.length > 0 && <><h4>{copy.relatedDrafts}</h4><p>{copy.relatedNotice}</p>{drafts.map((draft) => <div key={draft.localId}>
        <label><input type="checkbox" checked={selection.relatedDraftIDs.includes(draft.localId)} onChange={(event) => toggle('relatedDraftIDs', draft.localId, event.target.checked)} /> {copy.createRelated}: {String(Object.values(draft.fields).find((value) => typeof value === 'string') ?? draft.localId)} ({draft.collection} · {draft.localId})</label>
        <pre style={preStyle}>{JSON.stringify(draft.fields, null, 2)}</pre>
      </div>)}</>}
      {proposal.semanticGraph && <><h4>{copy.semanticGraph}</h4>
        <label><input type="checkbox" disabled={graphDisabled} checked={selection.applyGraph} onChange={(event) => onChange({ ...selection, applyGraph: event.target.checked })} /> {copy.applyGraph}</label>
        <p>{copy.graphNotice}</p>
        {graphDisabled && <p>{copy.graphConflict}</p>}
        <pre data-testid="editorial-graph-preview" style={preStyle}>{JSON.stringify(selectedGraphPreview(proposal, selection), null, 2)}</pre>
      </>}
    </fieldset>
    {issues.length > 0 && <p role="alert">{copy.relatedRequired}: {issues.join(', ')}</p>}
  </section>
}
