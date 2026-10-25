import {
  Children,
  isValidElement,
  type ChangeEvent,
  type ReactNode,
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PERSONA_TEMPLATES } from '@/lib/persona-template'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { PromptFields } from './prompt-fields'

function elements(
  node: ReactNode
): React.ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<{ children?: ReactNode }>(child)
      ? [child, ...elements(child.props.children)]
      : []
  )
}

function render(preset: 'official' | 'official_full' | 'zero', compat = {}) {
  return renderToStaticMarkup(
    <PromptFields
      preset={preset}
      blocks={DEFAULT_PERSONA_TEMPLATES[preset]}
      compat={compat}
      server={{}}
      onBlocksChange={() => {}}
      onCompatChange={() => {}}
    />
  )
}

describe('prompt fields', () => {
  it('shows only the system editor for the lean official preset', () => {
    const html = render('official')
    expect(html).toContain('aria-label="system"')
    expect(html).toContain('{{harness_303}}')
    expect(html).toContain('{{guidance_303}}')
    expect(html).toContain('{{caller_system}}')
    expect(html).not.toContain('role=system')
    expect(html).not.toContain('role="switch"')
    for (const text of [
      '常驻约束内容',
      'usage 遮罩',
      'cache ttl',
      'cache scope',
      'JSONL',
      '块选择',
    ]) {
      expect(html).not.toContain(text)
    }
  })

  it('keeps the full environment controls in the same editor, off by default for optional fields', () => {
    const html = render('official_full')
    expect(html).toContain('aria-label="messages role=system"')
    expect(html).toMatch(
      /<button(?=[^>]*aria-label="加载环境")(?=[^>]*aria-checked="true")/
    )
    for (const label of ['环境说明', '时区', '语言', '模型附加句']) {
      expect(html).toMatch(
        new RegExp(
          `<button(?=[^>]*aria-label="加载${label}")(?=[^>]*aria-checked="false")`
        )
      )
    }
    expect(html).not.toContain('完整环境说明来自 303')
    expect(html).not.toContain('抓包工具')
  })

  it('disables environment fields when the master switch is off', () => {
    const html = render('official_full', {
      persona_env_presets: { official_full: false },
      persona_timezone_presets: { official_full: true },
    })
    expect(html).toMatch(
      /<button(?=[^>]*aria-label="加载环境")(?=[^>]*aria-checked="false")/
    )
    expect(html).toMatch(
      /<textarea[^>]*id="prompt-official_full-5"[^>]*disabled=""/
    )
    expect(html).toMatch(
      /<button(?=[^>]*aria-label="加载时区")(?=[^>]*disabled="")/
    )
  })

  it('still exposes billing text in the billing-only preset', () => {
    expect(render('zero')).toContain('{{billing_semi}}')
  })

  it('changes only text, preserving block order, cache breakpoints and other metadata', () => {
    const blocks = structuredClone(DEFAULT_PERSONA_TEMPLATES.official_full)
    const before = structuredClone(blocks)
    const onBlocksChange = vi.fn()
    const tree = PromptFields({
      preset: 'official_full',
      blocks,
      compat: {},
      server: {},
      onBlocksChange,
      onCompatChange: vi.fn(),
    })
    const field = elements(tree).find(
      (element) =>
        element.type === Textarea &&
        element.props.id === 'prompt-official_full-2'
    )!
    const change = field.props.onChange as (
      event: ChangeEvent<HTMLTextAreaElement>
    ) => void
    change({
      target: { value: 'EDITED_HARNESS' },
    } as ChangeEvent<HTMLTextAreaElement>)
    expect(onBlocksChange).toHaveBeenCalledWith(
      before.map((block, index) =>
        index === 2 ? { ...block, text: 'EDITED_HARNESS' } : block
      )
    )
    expect(blocks).toEqual(before)
  })

  it('enables saved disabled optional fields without changing unrelated compatibility settings', () => {
    const compat = {
      cc_entrypoint: 'cli',
      cache_ttl: '1h',
      model_env_extra: { model: 'KEEP' },
      persona_block_presets: {
        official_full: { env_timezone: false },
        official: { identity: false },
      },
    }
    const snapshot = structuredClone(compat)
    const onCompatChange = vi.fn()
    const tree = PromptFields({
      preset: 'official_full',
      blocks: DEFAULT_PERSONA_TEMPLATES.official_full,
      compat,
      server: {},
      onBlocksChange: vi.fn(),
      onCompatChange,
    })
    const toggle = elements(tree).find(
      (element) =>
        element.type === Switch && element.props['aria-label'] === '加载时区'
    )!
    const change = toggle.props.onCheckedChange as (enabled: boolean) => void
    change(true)
    const saved = onCompatChange.mock.calls[0][0]
    expect(saved).toMatchObject({
      cc_entrypoint: 'cli',
      cache_ttl: '1h',
      model_env_extra: { model: 'KEEP' },
      persona_timezone_presets: { official_full: true },
      persona_block_presets: { official: { identity: false } },
    })
    expect(saved.persona_block_presets.official_full).toBeUndefined()
    expect(compat).toEqual(snapshot)
  })

  it('keeps saved environment blocks editable without silently deleting them from lean presets', () => {
    const html = renderToStaticMarkup(
      <PromptFields
        preset='official'
        blocks={[
          ...DEFAULT_PERSONA_TEMPLATES.official,
          { id: 'env', type: 'text', text: 'SAVED_ENV' },
        ]}
        compat={{}}
        server={{}}
        onBlocksChange={() => {}}
        onCompatChange={() => {}}
      />
    )
    expect(html).toContain('messages role=system')
    expect(html).toContain('SAVED_ENV')
  })
})
