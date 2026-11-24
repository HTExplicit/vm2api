import {
  personaInjectFromPreset,
  personaPresetFromCompat,
} from '@/lib/persona-template'

type Compat = Record<string, unknown>

export function isOpenAiPromptOnlyPatch(compat: Compat) {
  const keys = Object.keys(compat)
  return keys.length === 1 && keys[0] === 'openai_system_prompt'
}

/**
 * 系统提示词页保存体：只发 `compatibility` 里改过的键。PUT /routing 按段合并、
 * compatibility 内再浅合并，整份回写会把别处（设置页、其它标签）改过的值回滚。
 * 保存其他提示词时仍带 persona_preset / persona_inject，供后端同步内核人设。
 */
export function compatibilityPatch(
  draft: Compat,
  server: Compat | undefined
): { compatibility: Compat } {
  const out: Compat = {}
  for (const [key, value] of Object.entries(draft)) {
    if (JSON.stringify(value) !== JSON.stringify(server?.[key]))
      out[key] = value
  }
  if (!isOpenAiPromptOnlyPatch(out)) {
    const preset = personaPresetFromCompat(draft)
    out.persona_preset = preset
    out.persona_inject = personaInjectFromPreset(preset, draft.persona_inject)
  }
  return { compatibility: out }
}
