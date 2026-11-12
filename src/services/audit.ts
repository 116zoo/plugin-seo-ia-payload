import { parseProposalOutput, ProposalValidationError, type ProposalValidationDiagnostic } from './validation.js'

export interface SeoAudit {
  locale: string
  /** Completeness and validity of approved values, not a search-ranking prediction. */
  score: number
  completeness: 'incomplete' | 'complete'
  missing: string[]
  invalid: ProposalValidationDiagnostic[]
  recommendations: ProposalValidationDiagnostic[]
}

const requiredFields = [
  'meta.title', 'meta.description', 'social.image', 'social.imageAlt',
  'social.ogTitle', 'social.ogDescription', 'schema', 'citability.summary',
] as const

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

// Payload stores unset optional scalar fields as null; the model contract uses absence.
const fields = (value: unknown): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record(value)).filter(([, field]) => field !== null))

/** Accept a locale-loaded document or Payload's `locale: 'all'` shape; never fall back. */
export const auditSeo = (doc: Record<string, unknown>, locale: string): SeoAudit => {
  if (!locale.trim() || locale === 'all' || locale === '*') throw new Error('A single SEO locale is required.')
  const allSeo = record(doc.seo)
  const seo = ['meta', 'social', 'schema', 'citability', 'status'].some((key) => Object.hasOwn(allSeo, key))
    ? allSeo : record(allSeo[locale])
  const approved = {
    meta: fields(seo.meta), social: fields(seo.social),
    schema: seo.schema ?? [], citability: fields(seo.citability),
  }
  // A depth-populated approved media relation is equivalent to its stored ID.
  const image = approved.social.image
  if (image !== null && typeof image === 'object') approved.social.image = record(image).id
  const selectedImage = approved.social.image
  const missing = requiredFields.filter((path) => {
    const [group, field] = path.split('.')
    const value = field ? record(approved[group as keyof typeof approved])[field] : approved.schema
    return value === undefined || value === null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && value.length === 0)
  })
  let invalid: ProposalValidationDiagnostic[] = []
  try {
    // A nonempty URL keeps page graphs eligible for validation; it is never emitted.
    // Only approved fields enter validation. Source content, status and drafts cannot improve the score.
    parseProposalOutput(approved, {
      url: 'https://audit.invalid',
      selectedMedia: typeof selectedImage === 'string' || typeof selectedImage === 'number' ? [{ id: selectedImage }] : [],
    })
  } catch (error) {
    if (!(error instanceof ProposalValidationError)) throw error
    invalid = error.diagnostics.filter(({ path }) => !missing.some((field) => path === field || path.startsWith(`${field}.`)))
  }
  const failedRequired = requiredFields.filter((field) => missing.includes(field) || invalid.some(({ path }) => path === field || path.startsWith(`${field}.`) || field.startsWith(`${path}.`)))
  const optionalFailures = invalid.filter(({ path }) => !requiredFields.some((field) => path === field || path.startsWith(`${field}.`) || field.startsWith(`${path}.`)))
  const score = Math.round(100 * (requiredFields.length - failedRequired.length) / (requiredFields.length + optionalFailures.length))
  return {
    locale, score, completeness: missing.length || invalid.length ? 'incomplete' : 'complete', missing, invalid,
    recommendations: [
      ...missing.map((path) => ({ path, code: 'missing', message: `Add approved ${path} for locale ${locale}.` })),
      ...invalid.map((issue) => ({ ...issue, message: `Correct approved ${issue.path}: ${issue.message}` })),
    ],
  }
}
