import { getGptModelPolicy } from '../protocol/gpt-model-policy.mjs'
import { isGptSeriesId } from '../protocol/gpt-ids.mjs'
import { normalizeCodexModelMappings } from '../protocol/codex-model-mapping.mjs'

/** The account API uses the panel's OpenAI catalog, without generated Fast aliases. */
export function accountApiModels(policy = getGptModelPolicy(), routing = {}) {
  const rows = Object.entries(policy.models || {})
    .filter(([id]) => isGptSeriesId(id))
    .sort(([a, x], [b, y]) => (x.sort || 80) - (y.sort || 80) || a.localeCompare(b))
  const actual = new Map(rows.map(([id, row]) => [id.toLowerCase(), { id, row }]))
  const models = new Map()
  for (const [id, row] of rows) {
    if (row.enabled === false) continue
    models.set(id.toLowerCase(), { name: id, alias: id, display_name: row.display_name || id })
  }
  for (const [id, row] of rows) {
    if (row.enabled === false) continue
    for (const value of row.aliases || []) {
      const alias = String(value || '').trim()
      const key = alias.toLowerCase()
      if (!alias || actual.has(key) || models.has(key)) continue
      models.set(key, { name: id, alias, display_name: alias })
    }
  }
  const mappings = normalizeCodexModelMappings(routing.codex?.model_mappings)
  for (const [alias, target] of Object.entries(mappings)) {
    const key = alias.toLowerCase()
    if (actual.has(key)) continue
    // An explicit mapping replaces a plain alias even when its target is disabled.
    models.delete(key)
    const match = actual.get(String(target).toLowerCase())
    if (!match || match.row.enabled === false) continue
    models.set(key, { name: match.id, alias, display_name: alias })
  }
  return [...models.values()]
}
