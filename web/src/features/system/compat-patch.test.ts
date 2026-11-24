import { describe, expect, it } from 'vitest'
import { compatibilityPatch } from './compat-patch'

describe('system prompt save body', () => {
  it('sends only compatibility, never other routing sections', () => {
    const body = compatibilityPatch({ persona_preset: 'zero' }, {})
    expect(Object.keys(body)).toEqual(['compatibility'])
  })

  it('leaves untouched compatibility keys out so other pages are not rolled back', () => {
    const server = {
      persona_preset: 'zero',
      persona_inject: 'zero',
      cache_ttl: '1h',
      persona_templates: { a: 1 },
    }
    const body = compatibilityPatch(
      { ...server, persona_templates: { a: 2 } },
      server
    )
    expect(body.compatibility).toEqual({
      persona_templates: { a: 2 },
      persona_preset: 'zero',
      persona_inject: 'zero',
    })
  })

  it('saves an OpenAI-only edit without scheduling kernel persona changes', () => {
    const server = { persona_templates: { a: 1 }, cache_ttl: '1h' }
    const prompt = {
      enabled: true,
      text: 'Gateway prompt',
    }
    const draft = { ...server, openai_system_prompt: prompt }
    expect(compatibilityPatch(draft, server)).toEqual({
      compatibility: { openai_system_prompt: prompt },
    })
  })
})
