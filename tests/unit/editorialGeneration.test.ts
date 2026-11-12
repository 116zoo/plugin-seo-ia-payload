import type { Field } from 'payload'
import { describe, expect, test } from 'vitest'

import { editorialGenerationSpecification } from '../../src/services/editorialGeneration.js'
import type { EditorialField, EditorialRegistry } from '../../src/types.js'

const descriptor = (path: string, field: Field, children?: EditorialField[]): EditorialField => ({ path, type: field.type as EditorialField['type'], field, ancestors: [], ...(children ? { children } : {}) })
const registry = (collection: string, fields: EditorialField[]): EditorialRegistry => ({ collection, fields, exclude: ['content'], relations: {} })
const relation = (path: string, target: string, allowCreate: boolean): EditorialField => ({ ...descriptor(path, { name: path, type: 'relationship', relationTo: target }), relation: { relationTo: target, allowCreate } })

describe('editorial generation specification', () => {
  test('projects nested compatible field shapes and whitelisted constraints without leaking host configuration', () => {
    const question = descriptor('faq.question', { name: 'question', type: 'text', required: true, maxLength: 100, custom: { private: 'never-send' } })
    const heading = descriptor('layout.hero.heading', { name: 'heading', type: 'text' })
    const fields = [
      descriptor('faq', { name: 'faq', type: 'array', fields: [question.field], minRows: 1, maxRows: 5 }, [question]),
      descriptor('layout', { name: 'layout', type: 'blocks', blocks: [{ slug: 'hero', fields: [heading.field] }] }, [heading]),
      descriptor('choices', { name: 'choices', type: 'select', hasMany: true, options: [{ value: 'one', label: { fr: 'Privé FR', en: 'Private EN' } }, 'two'] }),
      descriptor('count', { name: 'count', type: 'number', min: 0, max: 5 }),
      { ...descriptor('rows.label', { name: 'label', type: 'text' }), ancestors: [{ path: 'rows', type: 'array' as const }] },
    ]
    const source = registry('posts', fields)
    const spec = editorialGenerationSpecification({ registry: source, registries: { posts: source }, locale: 'fr' })
    expect(spec.fields).toEqual([
      { path: 'faq', type: 'array', minRows: 1, maxRows: 5, children: [{ path: 'faq.question', type: 'text', required: true, maxLength: 100 }] },
      { path: 'layout', type: 'blocks', children: [{ path: 'layout.hero.heading', type: 'text' }] },
      { path: 'choices', type: 'select', hasMany: true, options: ['one', 'two'] },
      { path: 'count', type: 'number', min: 0, max: 5 },
    ])
    for (const excluded of ['never-send', 'Privé FR', 'Private EN', 'rows.label']) expect(JSON.stringify(spec)).not.toContain(excluded)
    spec.fields[0].children![0].maxLength = 20
    expect(question.field).toMatchObject({ maxLength: 100 })
  })

  test('describes only reachable create targets, handles cycles and permits a related document in the source collection', () => {
    const posts = registry('posts', [relation('related', 'posts', true), relation('tags', 'tags', true), relation('category', 'categories', false)])
    const tags = registry('tags', [descriptor('name', { name: 'name', type: 'text', required: true }), relation('parent', 'tags', true)])
    const categories = registry('categories', [descriptor('name', { name: 'name', type: 'text' })])
    const spec = editorialGenerationSpecification({ registry: posts, registries: { posts, tags, categories }, locale: 'en' })
    expect(spec.relatedCollections.map(({ collection }) => collection)).toEqual(['posts', 'tags'])
    expect(spec.fields[2].relation).toEqual({ relationTo: 'categories', allowCreate: false })
  })

  test('never advertises upload creation or target shapes with unaddressable required fields', () => {
    const posts = registry('posts', [relation('tags', 'tags', true), { ...descriptor('image', { name: 'image', type: 'upload', relationTo: 'media' }), relation: { relationTo: 'media', allowCreate: true } }])
    const tags = registry('tags', [descriptor('name', { name: 'name', type: 'text' }), { ...descriptor('rows.label', { name: 'label', type: 'text', required: true }), ancestors: [{ path: 'rows', type: 'array' as const }] }])
    const spec = editorialGenerationSpecification({ registry: posts, registries: { posts, tags, media: registry('media', [descriptor('alt', { name: 'alt', type: 'text' })]) }, locale: 'fr' })
    expect(spec.relatedCollections).toEqual([])
    expect(spec.fields[1].relation?.allowCreate).toBe(false)
  })
})
