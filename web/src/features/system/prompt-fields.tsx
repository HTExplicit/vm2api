import type { PersonaPreset } from '@/types/panel-routing'
import {
  presetFlagEnabled,
  selectedPreviewBlocks,
  setPresetFlag,
  setTemplateBlock,
  templateBlockEnabled,
  type PresetFlagField,
  type RawBlock,
} from '@/lib/persona-template'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

type Compat = Record<string, unknown>

const ENV_FLAGS: Record<string, PresetFlagField> = {
  env_extra: 'model_env_extra_presets',
  env_instructions: 'persona_env_instructions_presets',
  env_timezone: 'persona_timezone_presets',
  env_locale: 'persona_locale_presets',
}

const ENV_LABELS: Record<string, string> = {
  env: '环境',
  env_extra: '模型附加句',
  env_instructions: '环境说明',
  env_timezone: '时区',
  env_locale: '语言',
}

/** Edit prompt text without exposing or rebuilding cache and routing metadata. */
export function PromptFields({
  preset,
  blocks,
  compat,
  server,
  onBlocksChange,
  onCompatChange,
}: {
  preset: PersonaPreset
  blocks: RawBlock[]
  compat: Compat
  server: Compat | undefined
  onBlocksChange: (blocks: RawBlock[]) => void
  onCompatChange: (next: Compat) => void
}) {
  const routed = selectedPreviewBlocks(blocks, undefined, preset)
  const envOn = presetFlagEnabled(compat, 'persona_env_presets', preset)
  const fields = (environment: boolean) =>
    routed.flatMap((block, index) => {
      const id = String(block.id ?? '')
      if ((block.role === 'system') !== environment) return []
      if (id === 'dynamic_boundary' || (id === 'billing' && preset !== 'zero'))
        return []
      const flag = environment ? ENV_FLAGS[id] : undefined
      const selected = templateBlockEnabled(compat, preset, id)
      const on = selected && (!flag || presetFlagEnabled(compat, flag, preset))
      const label = environment
        ? ENV_LABELS[id] || id
        : id || `system ${index + 1}`
      const inputId = `prompt-${preset}-${index}`
      return [
        <div key={inputId} className='space-y-2'>
          <div className='flex items-center justify-between gap-2'>
            <label htmlFor={inputId} className='text-xs text-muted-foreground'>
              {label}
            </label>
            {environment && (flag || id !== 'env') ? (
              <Switch
                aria-label={`加载${label}`}
                checked={on}
                disabled={!envOn}
                onCheckedChange={(enabled) => {
                  const next =
                    !flag || enabled
                      ? setTemplateBlock(compat, preset, id, enabled)
                      : compat
                  onCompatChange(
                    flag
                      ? setPresetFlag(next, flag, preset, enabled, server)
                      : next
                  )
                }}
              />
            ) : !selected ? (
              <Button
                type='button'
                size='sm'
                variant='ghost'
                onClick={() =>
                  onCompatChange(setTemplateBlock(compat, preset, id, true))
                }
              >
                启用
              </Button>
            ) : null}
          </div>
          <Textarea
            id={inputId}
            className='min-h-20 font-mono text-xs leading-relaxed'
            spellCheck={false}
            value={String(block.text ?? '')}
            disabled={environment ? !envOn || !on : !selected}
            onChange={(event) =>
              onBlocksChange(
                blocks.map((item, at) =>
                  at === index ? { ...item, text: event.target.value } : item
                )
              )
            }
          />
        </div>,
      ]
    })

  const environment = fields(true)
  return (
    <div className='space-y-5'>
      <section className='space-y-3' aria-label='system'>
        <h3 className='text-sm font-medium'>system</h3>
        {fields(false)}
      </section>
      {environment.length ? (
        <section
          className='space-y-3 border-t border-border/60 pt-4'
          aria-label='messages role=system'
        >
          <div className='flex items-center justify-between gap-2'>
            <h3 className='text-sm font-medium'>messages · role=system</h3>
            <Switch
              aria-label='加载环境'
              checked={envOn}
              onCheckedChange={(enabled) =>
                onCompatChange(
                  setPresetFlag(
                    compat,
                    'persona_env_presets',
                    preset,
                    enabled,
                    server
                  )
                )
              }
            />
          </div>
          {environment}
        </section>
      ) : null}
    </div>
  )
}
