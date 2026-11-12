import type { Config, Field, Tab } from 'payload'

import type {
  EditorialField, EditorialFieldOptions, EditorialFieldType, EditorialRegistry,
  EditorialRelationOptions, NimSeoPluginOptions, ValidatedPluginOptions,
} from '../types.js'

function error(message: string): never {
  throw new Error(`[payload-plugin-nim-seo] ${message}`)
}
const containsPath = (parent: string, child: string): boolean =>
  parent === child || child.startsWith(`${parent}.`)
const validPath = (path: unknown): path is string => typeof path === 'string'
  && path.split('.').every((part) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(part))

// These names are never eligible, including inside explicitly allowed containers.
const technicalNames = new Set([
  'id', 'slug', 'route', 'routing', 'url', 'path', 'pathname', 'permalink',
  'seo', 'nimseopanel', 'status', 'createdat', 'updatedat', 'createdby', 'updatedby',
  'author', 'systemauthor', 'owner', 'access', 'permissions', 'permission', 'roles', 'role',
  'email', 'password', 'salt', 'hash', 'token', 'apikey', 'sessions', 'resetpasswordtoken',
  'resetpasswordexpiration', 'loginattempts', 'lockuntil', 'verified', 'verificationtoken',
  'versions', 'version', 'payment', 'payments', 'price', 'amount', 'currency',
  'stripe', 'customerid', 'subscription', 'invoice', 'billing', 'transaction',
  'filename', 'filesize', 'mimetype', 'sizes', 'width', 'height', 'focalx', 'focaly',
  'blocktype', 'blockname', 'enablerichtextlink',
  'constructor', 'prototype',
])
const assertEditorialPath = (collection: string, path: string): void => {
  for (const part of path.split('.')) {
    if (part.toLowerCase() === 'content') error(`${collection}.${path}: content is excluded from editorial generation.`)
    if (part.startsWith('_') || technicalNames.has(part.toLowerCase())) {
      error(`${collection}.${path}: technical fields are excluded from editorial generation.`)
    }
  }
}
const supportedTypes = new Set<EditorialFieldType>([
  'text', 'textarea', 'richText', 'number', 'date', 'checkbox', 'select',
  'relationship', 'upload', 'group', 'array', 'blocks',
])

type SchemaNode = Omit<EditorialField, 'type' | 'children'> & {
  type: Field['type']; children?: SchemaNode[]; restricted: boolean
}

/** Layout-only wrappers still govern the eligibility of their descendants. */
const isRestricted = (field: Field | Tab): boolean => Boolean(
  ('hidden' in field && field.hidden)
  || ('virtual' in field && field.virtual)
  || (field.admin && (('hidden' in field.admin && field.admin.hidden)
    || ('readOnly' in field.admin && field.admin.readOnly))),
)

/** Preserve schema namespaces, while discarding layout-only wrappers. */
const schemaNodes = (
  fields: Field[], config: Config, prefix = '', ancestors: EditorialField['ancestors'] = [], depth = 0,
  inheritedRestriction = false,
): SchemaNode[] => {
  if (depth > 30) return error(`${prefix}: editorial schema nesting is too deep or cyclic.`)
  const nodes: SchemaNode[] = []
  const pathFor = (name: string) => prefix ? `${prefix}.${name}` : name
  for (const field of fields) {
    const restricted = inheritedRestriction || isRestricted(field)
    if (field.type === 'tabs') {
      for (const tab of field.tabs) {
        const tabRestricted = restricted || isRestricted(tab)
        if ('name' in tab && tab.name) {
          const path = pathFor(tab.name)
          const group: Field = { ...tab, type: 'group' }
          nodes.push({ path, type: 'group', field: group, ancestors, restricted: tabRestricted,
            children: schemaNodes(tab.fields, config, path, [...ancestors, { path, type: 'group' }], depth + 1, tabRestricted) })
        } else nodes.push(...schemaNodes(tab.fields, config, prefix, ancestors, depth + 1, tabRestricted))
      }
    } else if ('name' in field && field.name) {
      const path = pathFor(field.name)
      const node: SchemaNode = { path, type: field.type, field, ancestors, restricted }
      if (field.type === 'group' || field.type === 'array') {
        node.children = schemaNodes(field.fields, config, path, [...ancestors, { path, type: field.type }], depth + 1, restricted)
      } else if (field.type === 'blocks') {
        node.children = []
        for (const reference of [...field.blocks, ...(field.blockReferences ?? [])]) {
          const block = typeof reference === 'string' ? config.blocks?.find(({ slug }) => slug === reference) : reference
          if (!block) error(`${path}: referenced block ${String(reference)} must exist in Payload config.blocks.`)
          node.children.push(...schemaNodes(block.fields, config, `${path}.${block.slug}`, [
            ...ancestors, { path, type: 'blocks', blockSlug: block.slug },
          ], depth + 1, restricted))
        }
      }
      nodes.push(node)
    } else if ('fields' in field) nodes.push(...schemaNodes(field.fields, config, prefix, ancestors, depth + 1, restricted))
  }
  return nodes
}
const flatten = (nodes: SchemaNode[]): SchemaNode[] => nodes.flatMap((node) => [node, ...flatten(node.children ?? [])])

const assertWritable = (collection: string, node: SchemaNode): void => {
  if (node.restricted) {
    error(`${collection}.${node.path}: hidden, read-only or virtual fields are not editorial fields.`)
  }
}

const validatePaths = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || !value.every(validPath)) error(`${label}: expected an array of exact schema paths.`)
  if (new Set(value).size !== value.length) error(`${label}: duplicate paths are not allowed.`)
  return value
}

/**
 * Runtime callers consume the startup cache. The optional host config resolves raw
 * options for startup validation and schema-focused tests only.
 */
export const resolveEditorialRegistry = (
  options: NimSeoPluginOptions | ValidatedPluginOptions,
  collection: string,
  config?: Config,
): EditorialRegistry => {
  if (!config) {
    if ('editorialRegistries' in options && Object.hasOwn(options.editorialRegistries, collection)) {
      return options.editorialRegistries[collection]
    }
    return error(`${collection}: editorial registry requires validated options or a host config.`)
  }
  const host = config.collections?.find(({ slug }) => slug === collection)
  if (!host || !Object.hasOwn(options.collections, collection)) error(`${collection}: configured collection must exist.`)
  const settings: EditorialFieldOptions | undefined = options.collections[collection].editorialFields
  if (settings === undefined) return { collection, fields: [], exclude: ['content'], relations: {} }
  if (!settings || typeof settings !== 'object') error(`${collection}.editorialFields must be a field configuration.`)
  const include = validatePaths(settings.include, `${collection}.editorialFields.include`)
  const exclude = validatePaths(settings.exclude === undefined ? [] : settings.exclude, `${collection}.editorialFields.exclude`)
  const nodes = flatten(schemaNodes(host.fields, config))
  const lookup = new Map(nodes.map((node) => [node.path, node]))
  // content can always be explicitly excluded, even when the host has no such field.
  for (const path of exclude) {
    if (path !== 'content' && !lookup.has(path)) error(`${collection}.${path}: excluded path must exist in the host schema.`)
  }
  for (const path of include) {
    assertEditorialPath(collection, path)
    if (!lookup.has(path)) error(`${collection}.${path}: editorial field path must exist in the host schema.`)
    if (include.some((other) => other !== path && containsPath(other, path))) {
      error(`${collection}.${path}: overlapping include paths are not allowed.`)
    }
  }
  const selected = include.filter((path) => !exclude.some((excluded) => containsPath(excluded, path)))
  const policy = settings.relations === undefined ? {} : settings.relations
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) error(`${collection}.editorialFields.relations must be a policy map.`)
  const relations: Record<string, EditorialRelationOptions> = {}
  const resolveNode = (node: SchemaNode): EditorialField => {
    assertEditorialPath(collection, node.path)
    if (!supportedTypes.has(node.type as EditorialFieldType)) error(`${collection}.${node.path}: field type ${node.type} has no editorial adapter.`)
    assertWritable(collection, node)
    if (exclude.some((path) => containsPath(node.path, path))) {
      error(`${collection}.${node.path}: container overlaps an excluded child; include its safe child paths instead.`)
    }
    let relation: EditorialRelationOptions | undefined
    if (node.field.type === 'relationship' || node.field.type === 'upload') {
      const declaration = Object.hasOwn(policy, node.path) ? policy[node.path] : undefined
      if (!declaration || typeof declaration !== 'object') error(`${collection}.${node.path}: relationship/upload requires an explicit relation policy.`)
      if (typeof declaration.allowCreate !== 'boolean') error(`${collection}.${node.path}: relation allowCreate must be explicitly true or false.`)
      const target = declaration.relationTo
      const targets = typeof target === 'string' ? [target] : target
      const actual = typeof node.field.relationTo === 'string' ? [node.field.relationTo] : node.field.relationTo
      if (!Array.isArray(targets) || targets.length === 0 || !targets.every((slug) => typeof slug === 'string' && slug.length > 0)
        || new Set(targets).size !== targets.length || targets.length !== actual.length || !actual.every((slug) => targets.includes(slug))) {
        error(`${collection}.${node.path}: relationTo must match the Payload field targets exactly.`)
      }
      for (const slug of targets) {
        if (!config.collections?.some((candidate) => candidate.slug === slug)) error(`${collection}.${node.path}: relation target ${slug} must exist.`)
        if (declaration.allowCreate && !options.collections[slug]?.editorialFields?.include?.length) {
          error(`${collection}.${node.path}: creation target ${slug} must declare its own editorialFields.include.`)
        }
        if (declaration.allowCreate && !options.collections[slug].editorialFields!.include.some((path) =>
          !(options.collections[slug].editorialFields!.exclude ?? []).some((excluded) => containsPath(excluded, path)))) {
          error(`${collection}.${node.path}: creation target ${slug} must have enabled editorialFields.`)
        }
      }
      relation = { relationTo: typeof target === 'string' ? target : [...target], allowCreate: declaration.allowCreate }
      relations[node.path] = relation
    }
    return { path: node.path, field: node.field, ancestors: node.ancestors, type: node.type as EditorialFieldType,
      ...(node.children ? { children: node.children.map(resolveNode) } : {}), ...(relation ? { relation } : {}) }
  }
  const fields = selected.map((path) => {
    const node = lookup.get(path)!
    if (!('localized' in node.field) || node.field.localized !== true) {
      error(`${collection}.${path}: editorial field must explicitly set localized: true.`)
    }
    return resolveNode(node)
  })
  for (const path of Object.keys(policy)) {
    if (!selected.some((included) => containsPath(included, path))) error(`${collection}.${path}: relation policy must reference an included editorial path.`)
    if (!Object.hasOwn(relations, path)) error(`${collection}.${path}: relation policy must target a relationship or upload field.`)
  }
  return { collection, fields, exclude: [...new Set(['content', ...exclude])], relations }
}
