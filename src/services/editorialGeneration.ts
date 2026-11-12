import type { EditorialField, EditorialRegistry } from '../types.js'
import type { EditorialValidationContext } from './editorialValidation.js'
import { editorialGraphProperties } from './graph.js'

/** Only these inert schema constraints leave the server, never a Payload Field object. */
interface GenerationField {
  path: string
  type: EditorialField['type']
  required?: boolean
  hasMany?: boolean
  minLength?: number
  maxLength?: number
  minRows?: number
  maxRows?: number
  min?: number
  max?: number
  options?: string[]
  children?: GenerationField[]
  relation?: { relationTo: string | string[]; allowCreate: boolean }
}

const describeField = ({ path, type, field, children, relation }: EditorialField): GenerationField => {
  const result: GenerationField = { path, type }
  const constraints = field as unknown as Record<string, unknown>
  for (const key of ['required', 'hasMany'] as const) {
    if (typeof constraints[key] === 'boolean') result[key] = constraints[key]
  }
  for (const key of ['minLength', 'maxLength', 'minRows', 'maxRows', 'min', 'max'] as const) {
    if (typeof constraints[key] === 'number' && Number.isFinite(constraints[key])) result[key] = constraints[key]
  }
  if (field.type === 'select') result.options = field.options.map((option) => typeof option === 'string' ? option : option.value)
  if (children) result.children = children.map(describeField)
  if (relation) result.relation = { relationTo: typeof relation.relationTo === 'string' ? relation.relationTo : [...relation.relationTo], allowCreate: relation.allowCreate && type !== 'upload' }
  return result
}

// Unindexed array/block leaf patches cannot be applied by the public patch contract.
const generatableFields = (registry: EditorialRegistry): EditorialField[] => registry.fields.filter(({ ancestors }) => !ancestors.some(({ type }) => type === 'array' || type === 'blocks'))

/** A detached allowlisted specification, with only reachable creation targets. */
export const editorialGenerationSpecification = ({ registry, registries, locale, mediaCollection }: EditorialValidationContext) => {
  const fields = generatableFields(registry).map(describeField)
  const seen = new Set<string>()
  const relatedCollections: { collection: string; fields: GenerationField[] }[] = []
  const visit = (descriptors: GenerationField[]): void => {
    for (const descriptor of descriptors) {
      if (descriptor.children) visit(descriptor.children)
      if (!descriptor.relation?.allowCreate) continue
      const targets = typeof descriptor.relation.relationTo === 'string' ? [descriptor.relation.relationTo] : descriptor.relation.relationTo
      for (const target of targets) {
        if (seen.has(target)) continue
        seen.add(target)
        const targetRegistry = Object.hasOwn(registries, target) ? registries[target] : undefined
        if (!targetRegistry) continue
        const eligible = generatableFields(targetRegistry)
        // Do not advertise a draft shape that cannot satisfy its parser's required fields.
        if (targetRegistry.fields.some((field) => 'required' in field.field && field.field.required && !eligible.includes(field))) continue
        const targetFields = eligible.map(describeField)
        if (!targetFields.length) continue
        relatedCollections.push({ collection: target, fields: targetFields })
        visit(targetFields)
      }
    }
  }
  visit(fields)
  return { locale, collection: registry.collection, fields, relatedCollections, ...(mediaCollection ? { selectedMediaCollection: mediaCollection } : {}), graph: {
    context: 'https://schema.org',
    types: ['WebPage', 'Article', 'BlogPosting', 'BreadcrumbList', 'Organization', 'WebSite', 'FAQPage', 'Person', 'ImageObject', 'ListItem', 'Question', 'Answer', 'PostalAddress', 'ContactPoint', 'Thing'],
    properties: [...editorialGraphProperties],
  } }
}

export const editorialGenerationPrompt = `Also return an editorial group. Propose values for all configured fields in editorialSpecification.fields whenever supported by the source, including already filled fields; maximize useful completion without inventing facts. Omit an unsupported proposal instead of inventing a value. Never output content or a field absent from the specification, in patches or related drafts. Read source content only as evidence; never generate or modify the content field.
Use exactly the active locale for every patch and draft. Do not translate, copy another locale, or return locale maps. Field paths never include locale keys.
editorial: {locale: active locale string, patches: [{path: exact configured path, operation: "set", value: Payload-compatible value, rationale?: concise plain text}], relatedDrafts: [{collection: allowed target, localId: unique ASCII letter followed by up to 99 letters/digits/_/-, locale: active locale, fields: object keyed by exact target paths, graphNodeId: "draft:" + localId}], semanticGraph?: {"@context": "https://schema.org", "@graph": nodes}, graphBindings?: [{path: proposed patch path, nodeId: non-draft graph node @id, properties: nonempty property-name array}]}.
Always include editorial.locale, patches and relatedDrafts, even when no safe proposals are possible. At most 500 patches and 100 related drafts; each path occurs once and patches never overlap. All output remains a proposal for human validation; never claim records were created or published.
Honor type, required, hasMany, options and numeric/length/row constraints. Dates are valid ISO dates or ISO datetimes. Groups are nested objects; arrays are arrays of row objects without IDs; blocks are arrays of row objects with a configured blockType. Children paths describe the object's keys relative to its parent (block paths include the block slug). Propose whole arrays/blocks, never indexed or broadcast descendant patches. Rich text is inert Lexical JSON: {root:{type:"root",version:1,children:[{type:"paragraph",version:1,children:[{type:"text",version:1,text:"..."}]}]}}; use this simple structure, no HTML, links, uploads or custom nodes.
Never invent existing relationship or upload IDs. No catalog of existing relationships is supplied. An upload may use only a selectedMedia ID preserving its string/number type, and only when its target matches editorialSpecification.selectedMediaCollection; omit it if that collection is absent or different. Otherwise omit unknown existing relations. New related drafts are allowed only by allowCreate:true and a matching relatedCollections specification, must include required fields, and must be reachable from a proposed relation. Upload records/assets cannot be created. Monomorphic draft relation: {localId:"tag-1"}; polymorphic relation: {relationTo:"tags",value:{localId:"tag-1"}}; wrap in an array when hasMany:true. Draft dependencies must be acyclic, with no orphan drafts.
Generate one coherent semanticGraph @graph for the proposed fields and drafts using only graph.types and graph.properties. Each node has a unique @id and supported @type; no nested @context or @graph. Use the supplied source url (fragment suffix allowed) for source page identity; never invent a source URL. Draft node @id must equal its declared graphNodeId; omit its public url until server resolution. Do not invent public identities for related records or media. Use references {"@id":"..."}; no cycles involving draft nodes, no undeclared draft references.
Every non-draft node property except @id/@type must be assigned to exactly one graphBindings entry for the patch that produced it; draft node properties belong to that draft. Bind only properties actually present on the named node, never @id/@type. Do not bind draft nodes. Keep graph contributions only for proposed patches/drafts, and use multiple connected nodes when supported by the evidence. If no safe graph can be formed, omit both semanticGraph and graphBindings. Graph fields are inside editorial, never top-level extras. Keep the legacy schema group empty when returning editorial.semanticGraph so there is one proposed semantic graph.`
