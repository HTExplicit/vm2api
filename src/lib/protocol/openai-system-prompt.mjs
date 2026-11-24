import { codexTextInput } from './codex-convert.mjs'

export function normalizeOpenAiSystemPrompt(config) {
  return {
    enabled: config?.enabled === true,
    text: typeof config?.text === 'string' ? config.text : '',
  }
}

export function appendOpenAiSystemPrompt(body, config) {
  const { enabled, text } = normalizeOpenAiSystemPrompt(config)
  if (!enabled || !text.trim()) return body

  // The upstream already owns the earlier developer messages for a delta request.
  if (body.previous_response_id) return body

  const input = typeof body.input === 'string' ? codexTextInput(body.input) : (body.input ?? [])
  if (!Array.isArray(input)) return body
  const firstOther = input.findIndex((item) => {
    if (item?.type === 'additional_tools') return false
    const isMessage = item?.type == null || item.type === 'message'
    return !isMessage || !['system', 'developer'].includes(item?.role)
  })
  const insertAt = firstOther === -1 ? input.length : firstOther
  const message = { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }
  return { ...body, input: [...input.slice(0, insertAt), message, ...input.slice(insertAt)] }
}
