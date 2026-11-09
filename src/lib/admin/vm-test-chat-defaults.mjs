import { SettingsRepo } from '../db/repos/settings-repo.mjs'

const SETTINGS_KEY = 'vm_test_chat_defaults'
const DEFAULT_PROMPT = 'hello'
const MAX_PROMPT_LENGTH = 16_000

export function readVmTestChatDefaults(settings = new SettingsRepo()) {
  const saved = settings.get(SETTINGS_KEY)
  return { prompt: saved?.prompt || DEFAULT_PROMPT }
}

export function saveVmTestChatDefaults(input, settings = new SettingsRepo()) {
  const prompt = input?.prompt
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) {
    throw Object.assign(new RangeError('默认提示词必须是非空字符串，且不超过 16000 字符'), {
      code: 'invalid_test_chat_defaults',
      status: 400,
    })
  }
  return settings.set(SETTINGS_KEY, { prompt })
}

export function resolveVmTestChatPrompt(prompt, settings) {
  return String(prompt || '').trim() ? prompt : readVmTestChatDefaults(settings).prompt
}
