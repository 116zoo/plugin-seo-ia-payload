import { z } from 'zod'

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
const usageSchema = z.object({ promptTokens: counter, completionTokens: counter, totalTokens: counter })
export type NimUsage = z.infer<typeof usageSchema>

/** Only known numeric counters cross the provider boundary, never arbitrary metadata. */
export const validateUsage = (value: unknown): NimUsage | undefined => {
  const parsed = usageSchema.safeParse(value)
  return parsed.success && Object.values(parsed.data).some((count) => count !== undefined) ? parsed.data : undefined
}

export const providerUsage = (value: unknown): NimUsage | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const usage = value as Record<string, unknown>
  return validateUsage({ promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens })
}

/** Derive totals from persisted per-document outcomes so resume cannot double count. */
export const aggregateUsage = (results: { usage?: unknown }[]): NimUsage | undefined => {
  const total: NimUsage = {}
  for (const result of results) {
    const usage = validateUsage(result.usage)
    if (!usage) continue
    for (const key of ['promptTokens', 'completionTokens', 'totalTokens'] as const) {
      if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key]
    }
  }
  return validateUsage(total)
}
