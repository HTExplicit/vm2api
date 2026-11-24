import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

export type OpenAiSystemPrompt = {
  enabled: boolean
  text: string
}

export const DEFAULT_OPENAI_SYSTEM_PROMPT: OpenAiSystemPrompt = {
  enabled: false,
  text: '',
}

export function OpenAiPromptPanel({
  value,
  onChange,
}: {
  value: OpenAiSystemPrompt
  onChange: (value: OpenAiSystemPrompt) => void
}) {
  return (
    <div className='space-y-5 rounded-xl border bg-card px-5 py-4 sm:px-6'>
      <div className='flex items-start justify-between gap-4'>
        <div className='space-y-1'>
          <Label htmlFor='openai-prompt-enabled'>追加 OpenAI 系统提示词</Label>
          <p id='openai-prompt-scope' className='text-sm text-muted-foreground'>
            适用于 GPT/Codex 订阅和 OpenAI API 的文本推理请求，留空时不追加。
          </p>
        </div>
        <Switch
          id='openai-prompt-enabled'
          aria-describedby='openai-prompt-scope'
          checked={value.enabled}
          onCheckedChange={(enabled) => onChange({ ...value, enabled })}
        />
      </div>

      <div className='space-y-2'>
        <Label htmlFor='openai-prompt-text'>追加正文</Label>
        <Textarea
          id='openai-prompt-text'
          aria-describedby='openai-prompt-effect'
          rows={6}
          value={value.text}
          onChange={(event) => onChange({ ...value, text: event.target.value })}
          className='font-mono'
        />
      </div>

      <p id='openai-prompt-effect' className='text-sm text-muted-foreground'>
        正文作为 developer 消息接在开头的指令块之后，可纳入缓存前缀。
        保存后下一次携带完整历史的请求使用新配置，可能影响已有对话的缓存复用。
      </p>
    </div>
  )
}
