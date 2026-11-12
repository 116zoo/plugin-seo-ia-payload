import type { EditorialField, EditorialPatch, EditorialProposalPayload, EditorialRegistry, RelatedDraft } from '../types.js'
import { ProposalValidationError } from './validation.js'
import { parseEditorialGraph } from './graph.js'

/** Trusted startup schema; never reconstructed from model output or persisted snapshots. */
export interface EditorialValidationContext {
  registry: EditorialRegistry
  registries: Record<string, EditorialRegistry>
  locale: string
}

const fail = (message: string, path = 'editorial'): never => {
  throw new ProposalValidationError([{ code: 'invalid_editorial', path, message }])
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
// Reject markup and unsafe control characters in generated text.
// eslint-disable-next-line no-control-regex
const text = (value: unknown): value is string => typeof value === 'string' && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
const keys = (value: Record<string, unknown>, allowed: string[]): void => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail('Unexpected editorial field or locale metadata.')
}
const pathAllowed = (path: unknown, registry: EditorialRegistry): EditorialField => {
  if (typeof path !== 'string') return fail('Expected a configured editorial path.')
  if (path.split('.').some((part) => part.toLowerCase() === 'content')) return fail('The content path is excluded.')
  if (registry.exclude.some((excluded) => path === excluded || path.startsWith(`${excluded}.`))) return fail('Editorial path is excluded.')
  return registry.fields.find((field) => field.path === path) ?? fail('Editorial path is not configured.')
}
const id = (value: unknown): boolean => (typeof value === 'string' && value.length > 0 && value.length <= 200 && text(value) && !value.startsWith('draft:'))
  || (typeof value === 'number' && Number.isSafeInteger(value))
const localID = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(value)

/** Reject non-JSON values, prototype keys, cycles and excessive trees before any traversal/clone. */
const assertJSON = (value: unknown): void => {
  const ancestors = new Set<object>()
  let nodes = 0
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 10000 || depth > 32) fail('Editorial value exceeds validation limits.')
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object' || ancestors.has(item) || (!Array.isArray(item) && !record(item))) return fail('Expected safe editorial JSON values.')
    ancestors.add(item)
    for (const [key, entry] of Object.entries(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('Unsafe editorial field.')
      visit(entry, depth + 1)
    }
    ancestors.delete(item)
  }
  visit(value, 0)
}

interface Reference { localId: string; collection: string; owner?: string }

/** Validate only explicit patches and drafts; this function performs no reads or writes. */
export const parseEditorialProposal = (
  value: unknown, registry: EditorialRegistry, locale: string,
  registries: Record<string, EditorialRegistry> = {}, sourceURL?: string,
): EditorialProposalPayload => {
  assertJSON(value)
  if (!record(value)) return fail('Expected an editorial proposal object.')
  keys(value, ['locale', 'patches', 'relatedDrafts', 'semanticGraph', 'graphBindings'])
  if (value.locale !== undefined && value.locale !== locale) fail('Editorial locale must match the active locale.')
  if (!Array.isArray(value.patches)) return fail('Expected an editorial patches array.')
  if (value.patches.length > 500 || (Array.isArray(value.relatedDrafts) && value.relatedDrafts.length > 100)) fail('Editorial proposal exceeds validation limits.')
  if (value.relatedDrafts !== undefined && !Array.isArray(value.relatedDrafts)) fail('Expected a related drafts array.')
  const references: Reference[] = []
  const validateValue = (item: unknown, descriptor: EditorialField, owner?: string): void => {
    const { field, type, children = [] } = descriptor
    const invalid = (): never => fail('Value does not match the configured Payload field type.', `editorial.${descriptor.path}`)
    if (item === null) {
      if ('required' in field && field.required) invalid()
      return
    }
    const length = (size: number): void => {
      if ('minLength' in field && field.minLength !== undefined && size < field.minLength) invalid()
      if ('maxLength' in field && field.maxLength !== undefined && size > field.maxLength) invalid()
    }
    if (Array.isArray(item)) {
      if ('required' in field && field.required && item.length === 0) invalid()
      if ('minRows' in field && field.minRows !== undefined && item.length < field.minRows) invalid()
      if ('maxRows' in field && field.maxRows !== undefined && item.length > field.maxRows) invalid()
    }
    switch (type) {
      case 'text': case 'textarea': {
        if ('hasMany' in field && field.hasMany) {
          if (!Array.isArray(item) || !item.every(text)) invalid()
          for (const entry of item as string[]) length(entry.length)
        } else {
          if (!text(item)) invalid()
          length((item as string).length)
          if ('required' in field && field.required && !(item as string).trim()) invalid()
        }
        break
      }
      case 'number': {
        if (field.type !== 'number') return invalid()
        const items = field.hasMany ? item : [item]
        if (!Array.isArray(items) || !items.every((entry) => typeof entry === 'number' && Number.isFinite(entry)
          && (field.min === undefined || entry >= field.min) && (field.max === undefined || entry <= field.max))) invalid()
        break
      }
      case 'checkbox': if (typeof item !== 'boolean') invalid(); break
      case 'date':
        if (typeof item !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(item) || !Number.isFinite(Date.parse(item)) || new Date(`${item.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== item.slice(0, 10)) invalid()
        break
      case 'select': {
        if (field.type !== 'select') return invalid()
        const allowed = field.options.map((option) => typeof option === 'string' ? option : option.value)
        const items = field.hasMany ? item : [item]
        if (!Array.isArray(items) || !items.every((entry) => typeof entry === 'string' && allowed.includes(entry)) || new Set(items).size !== items.length) invalid()
        break
      }
      case 'relationship': case 'upload': {
        const policy = descriptor.relation
        if (!policy || (field.type !== 'relationship' && field.type !== 'upload')) return invalid()
        const targets = typeof policy.relationTo === 'string' ? [policy.relationTo] : policy.relationTo
        const items = field.hasMany ? item : [item]
        if (!Array.isArray(items)) return invalid()
        for (let entry of items) {
          let collection = targets[0]
          if (Array.isArray(field.relationTo)) {
            if (!record(entry)) return invalid()
            keys(entry, ['relationTo', 'value'])
            if (typeof entry.relationTo !== 'string' || !targets.includes(entry.relationTo)) return invalid()
            collection = entry.relationTo
            entry = entry.value
          }
          if (record(entry)) {
            keys(entry, ['localId'])
            if (!policy.allowCreate || !localID(entry.localId)) return invalid()
            references.push({ localId: entry.localId, collection, ...(owner ? { owner } : {}) })
          } else if (!id(entry)) invalid()
        }
        break
      }
      case 'group': case 'array': case 'blocks': {
        const items = type === 'group' ? [item] : item
        if (!Array.isArray(items)) return invalid()
        if ((field.type === 'array' || field.type === 'blocks') && ((field.minRows !== undefined && items.length < field.minRows) || (field.maxRows !== undefined && items.length > field.maxRows))) invalid()
        for (const entry of items) {
          if (!record(entry)) return invalid()
          const slug = type === 'blocks' ? entry.blockType : undefined
          const prefix = type === 'blocks' ? `${descriptor.path}.${String(slug)}.` : `${descriptor.path}.`
          const members = children.filter((child) => child.path.startsWith(prefix))
          if (type === 'blocks' && (typeof slug !== 'string' || !members.length)) return invalid()
          const allowed = members.map((child) => child.path.slice(prefix.length))
          keys(entry, [...allowed, ...(type === 'blocks' ? ['blockType'] : [])])
          for (const child of members) {
            const key = child.path.slice(prefix.length)
            if (Object.hasOwn(entry, key)) validateValue(entry[key], child, owner)
            else if ('required' in child.field && child.field.required) invalid()
          }
        }
        break
      }
      case 'richText': {
        // Only inert Lexical text structure; custom/link/upload nodes require an explicit future adapter.
        if (!record(item) || !record(item.root)) return invalid()
        keys(item, ['root'])
        const childTypes: Record<string, readonly string[]> = {
          root: ['paragraph', 'heading', 'quote', 'list'],
          paragraph: ['text', 'linebreak'], heading: ['text', 'linebreak'], quote: ['text', 'linebreak'],
          list: ['listitem'], listitem: ['text', 'linebreak', 'list'],
          text: [], linebreak: [],
        }
        const visit = (node: unknown, parent?: string): void => {
          if (!record(node) || typeof node.type !== 'string' || !Object.hasOwn(childTypes, node.type)
            || (parent === undefined ? node.type !== 'root' : !childTypes[parent].includes(node.type))) invalid()
          const current = node as Record<string, unknown>
          keys(current, ['type', 'version', 'children', 'direction', 'format', 'indent', 'text', 'detail', 'mode', 'style', 'tag', 'listType', 'start', 'value', 'checked', 'textFormat', 'textStyle'])
          if (current.tag !== undefined && !['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ol', 'ul'].includes(current.tag as string)) invalid()
          if (current.direction !== undefined && ![null, 'ltr', 'rtl'].includes(current.direction as null | string)) invalid()
          for (const key of ['indent', 'detail', 'textFormat', 'start', 'value']) {
            if (current[key] !== undefined && (typeof current[key] !== 'number' || !Number.isSafeInteger(current[key]) || (current[key] as number) < 0)) invalid()
          }
          if (current.format !== undefined && !(typeof current.format === 'number' && Number.isSafeInteger(current.format) && current.format >= 0)
            && !['', 'left', 'center', 'right', 'justify', 'start', 'end'].includes(current.format as string)) invalid()
          if (current.checked !== undefined && typeof current.checked !== 'boolean') invalid()
          if (current.mode !== undefined && !['normal', 'token', 'segmented'].includes(current.mode as string)) invalid()
          if (current.listType !== undefined && !['bullet', 'number', 'check'].includes(current.listType as string)) invalid()
          if (current.style || current.textStyle || (current.text !== undefined && !text(current.text))) invalid()
          if (current.version !== 1) invalid()
          if (current.type === 'text' && typeof current.text !== 'string') invalid()
          if (current.type !== 'text' && Object.hasOwn(current, 'text')) invalid()
          if (['text', 'linebreak'].includes(current.type as string)) {
            if (Object.hasOwn(current, 'children')) invalid()
          } else {
            if (!Array.isArray(current.children)) return invalid()
            current.children.forEach((child) => visit(child, current.type as string))
          }
        }
        visit(item.root)
        break
      }
      default: invalid()
    }
  }
  const patches: EditorialPatch[] = value.patches.map((patch) => {
    if (!record(patch)) return fail('Expected an editorial patch object.')
    keys(patch, ['path', 'operation', 'value', 'rationale', 'locale'])
    if (patch.locale !== undefined && patch.locale !== locale) fail('Patch locale must match the active locale.')
    const descriptor = pathAllowed(patch.path, registry)
    if (patch.operation !== 'set') fail('Unsupported editorial operation.')
    if (!Object.hasOwn(patch, 'value')) fail('Editorial patch requires a value.')
    if (patch.rationale !== undefined && (!text(patch.rationale) || patch.rationale.length > 2000)) fail('Invalid editorial rationale.')
    validateValue(patch.value, descriptor)
    return { path: descriptor.path, operation: 'set', value: patch.value, ...(typeof patch.rationale === 'string' ? { rationale: patch.rationale } : {}) }
  })
  for (const [index, patch] of patches.entries()) {
    if (patches.slice(0, index).some(({ path }) => path === patch.path || path.startsWith(`${patch.path}.`) || patch.path.startsWith(`${path}.`))) fail('Duplicate or overlapping editorial paths.')
  }
  const relatedDrafts: RelatedDraft[] = ((value.relatedDrafts ?? []) as unknown[]).map((draft) => {
    if (!record(draft)) return fail('Expected a related draft object.')
    keys(draft, ['collection', 'localId', 'locale', 'fields', 'graphNodeId'])
    if (draft.locale !== locale) fail('Related draft locale must match the active locale.')
    if (!localID(draft.localId) || draft.graphNodeId !== `draft:${draft.localId}`) return fail('Invalid local draft or graph node ID.')
    if (typeof draft.collection !== 'string' || !Object.hasOwn(registries, draft.collection)) return fail('Related draft requires a cached target registry.')
    const target = registries[draft.collection]
    if (!target.fields.length || !record(draft.fields) || !Object.keys(draft.fields).length) return fail('Related draft requires configured editorial fields.')
    for (const [path, item] of Object.entries(draft.fields)) validateValue(item, pathAllowed(path, target), draft.localId)
    for (const descriptor of target.fields) {
      if ('required' in descriptor.field && descriptor.field.required && !Object.hasOwn(draft.fields, descriptor.path)) fail('Related draft is missing a required configured field.')
    }
    return { collection: draft.collection, localId: draft.localId, locale, fields: draft.fields, graphNodeId: `draft:${draft.localId}` }
  })
  const drafts = new Map(relatedDrafts.map((draft) => [draft.localId, draft]))
  if (drafts.size !== relatedDrafts.length) fail('Duplicate local draft IDs.')
  for (const reference of references) {
    if (drafts.get(reference.localId)?.collection !== reference.collection) fail('Unresolved or cross-collection local draft reference.')
  }
  // Creation is authorized only by a reachable, allowCreate relationship from this proposal.
  const reachable = new Set<string>()
  for (let pass = 0; pass <= relatedDrafts.length; pass++) {
    for (const reference of references) if (!reference.owner || reachable.has(reference.owner)) reachable.add(reference.localId)
  }
  if (relatedDrafts.some(({ localId }) => !reachable.has(localId))) fail('Related draft collection creation is not authorized by an editorial relation.')
  const active = new Set<string>(), visited = new Set<string>()
  const visitDraft = (id: string): void => {
    if (active.has(id)) fail('Cyclic local draft graph reference.')
    if (visited.has(id)) return
    active.add(id)
    references.filter((reference) => reference.owner === id).forEach((reference) => visitDraft(reference.localId))
    active.delete(id)
    visited.add(id)
  }
  relatedDrafts.forEach(({ localId }) => visitDraft(localId))
  const graph = parseEditorialGraph(value.semanticGraph, value.graphBindings, patches, relatedDrafts, sourceURL, registry)
  return structuredClone({ locale, patches, relatedDrafts, ...graph })
}
