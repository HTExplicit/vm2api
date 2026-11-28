import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import Anthropic from '@lobehub/icons/es/Anthropic/components/Mono'
import GoogleColor from '@lobehub/icons/es/Google/components/Color'
import { ArrowUpRight, Info } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/page-header'
import { QueryGate } from '@/components/query-gate'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { routingQueryOptions } from '@/features/settings/queries'
import { SaveBar } from '@/features/settings/save-bar'
import { SettingsSkeleton } from '@/features/settings/settings-skeleton'
import { CragGeminiPanel } from '@/features/system/craggemini-panel'
import { cragGeminiPromptProblem } from '@/features/system/google-prompt'
import { SystemPromptWorkspace } from '@/features/system/prompt-workspace'
import {
  DEFAULT_OPENAI_SYSTEM_PROMPT,
  OpenAiPromptPanel,
  type OpenAiSystemPrompt,
} from './openai-prompt-panel'
import {
  compatibilityPatch,
  isOpenAiPromptOnlyPatch,
  systemPromptSaveToast,
  type SystemPromptBrand,
} from './compat-patch'
import { SlidingTabs } from './sliding-tabs'

type RoutingSaveResult = {
  compatibility?: Record<string, unknown>
  kernel_persona?: { updated?: number; skipped?: number } | null
}

function followError(message: string) {
  if (/config_missing|kernel_start_failed|wrap_cli_missing/i.test(message)) {
    return '运行组件尚未就绪，请先在内核页完成拉取后再同步'
  }
  return message
}

const BRAND_TABS = [
  {
    value: 'anthropic' as const,
    label: 'Anthropic',
    icon: <Anthropic className='size-4 shrink-0' aria-hidden />,
  },
  {
    value: 'google' as const,
    label: 'Google',
    icon: <GoogleColor className='size-4 shrink-0' aria-hidden />,
  },
  { value: 'openai' as const, label: 'OpenAI' },
]

export function SystemPromptPage() {
  const routing = useQuery(routingQueryOptions())
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [personaProblems, setPersonaProblems] = useState<string[]>([])
  const [discardKey, setDiscardKey] = useState(0)
  const [brand, setBrand] = useState<SystemPromptBrand | 'openai'>('anthropic')
  const compatibility = (draft.compatibility as Record<string, unknown>) || {}
  const serverCompatibility = routing.data?.compatibility as
    Record<string, unknown> | undefined

  useEffect(() => {
    if (routing.data) setDraft(routing.data)
  }, [routing.data])

  const save = useMutation({
    mutationFn: (body: ReturnType<typeof compatibilityPatch>) => {
      return api<RoutingSaveResult>('/api/panel/routing', {
        method: 'PUT',
        body: JSON.stringify(body),
      })
    },
    onSuccess: async (saved, body) => {
      if (isOpenAiPromptOnlyPatch(body.compatibility)) {
        toast.success('OpenAI 系统提示词已保存')
        await qc.invalidateQueries({ queryKey: routingQueryOptions().queryKey })
        return
      }
      const compat =
        saved?.compatibility ||
        (draft.compatibility as Record<string, unknown> | undefined)
      toast.success(
        systemPromptSaveToast(
          brand === 'openai' ? 'anthropic' : brand,
          compat,
          saved?.kernel_persona
        )
      )
      await Promise.all([
        qc.invalidateQueries({ queryKey: routingQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
    },
    onError: (error: Error) => toast.error(followError(error.message)),
  })

  const serverJson = routing.data ? JSON.stringify(routing.data) : null
  const dirty =
    serverJson !== null &&
    Object.keys(draft).length > 0 &&
    JSON.stringify(draft) !== serverJson
  const googleProblem = cragGeminiPromptProblem(
    draft.compatibility as Record<string, unknown> | undefined
  )
  const problems = googleProblem
    ? [...personaProblems, googleProblem]
    : personaProblems
  const blocked = problems.length > 0
  const saveDraft = () =>
    save.mutate(compatibilityPatch(compatibility, serverCompatibility))

  const discard = () => {
    setDraft(routing.data ?? {})
    setPersonaProblems([])
    setDiscardKey((k) => k + 1)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 's') return
      e.preventDefault()
      if (!dirty || save.isPending) return
      if (blocked) {
        toast.error(problems[0])
        return
      }
      saveDraft()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <PageHeader
      title={VIEW_TITLES.system}
      extra={
        <SlidingTabs
          variant='segmented'
          ariaLabel='服务商'
          items={BRAND_TABS}
          value={brand}
          onChange={setBrand}
        />
      }
    >
      <div className={cn('space-y-5', dirty && 'pb-16')}>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-muted/45 px-3.5 py-2 text-xs text-muted-foreground'>
          <Info className='size-3.5 shrink-0 text-primary' aria-hidden />
          {brand === 'anthropic' ? (
            <>
              <span>
                全局默认策略，作用于选择「继承全局」的 Anthropic
                分组池；池级独立策略优先。
              </span>
              <Link
                to='/pools'
                className='ml-auto inline-flex items-center gap-0.5 font-medium text-primary underline-offset-4 hover:underline'
              >
                分组池策略
                <ArrowUpRight className='size-3.5' aria-hidden />
              </Link>
            </>
          ) : brand === 'google' ? (
            <span>作用于 Google 请求的全局系统提示词策略。</span>
          ) : (
            <span>作用于 OpenAI 订阅与 API 请求的追加提示词。</span>
          )}
        </div>

        <QueryGate
          loading={routing.isLoading}
          error={routing.error}
          skeleton={<SettingsSkeleton />}
        >
          <div
            hidden={brand !== 'anthropic'}
            className={
              brand === 'anthropic' ? 'animate-prompt-pane-in' : 'hidden'
            }
          >
            <SystemPromptWorkspace
              key={discardKey}
              compat={
                (draft.compatibility as Record<string, unknown> | undefined) ||
                {}
              }
              server={
                routing.data?.compatibility as
                  Record<string, unknown> | undefined
              }
              onChange={(next) => setDraft({ ...draft, compatibility: next })}
              onProblemsChange={setPersonaProblems}
            />
          </div>
          <div
            hidden={brand !== 'google'}
            className={brand === 'google' ? 'animate-prompt-pane-in' : 'hidden'}
          >
            <CragGeminiPanel
              compat={
                (draft.compatibility as Record<string, unknown> | undefined) ||
                {}
              }
              onChange={(next) => setDraft({ ...draft, compatibility: next })}
            />
          </div>
          <div
            hidden={brand !== 'openai'}
            className={brand === 'openai' ? 'animate-prompt-pane-in' : 'hidden'}
          >
            <OpenAiPromptPanel
              value={
                (compatibility.openai_system_prompt as
                  OpenAiSystemPrompt | undefined) ??
                DEFAULT_OPENAI_SYSTEM_PROMPT
              }
              onChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  compatibility: {
                    ...(current.compatibility as Record<string, unknown>),
                    openai_system_prompt: value,
                  },
                }))
              }
            />
          </div>
        </QueryGate>
      </div>
      {dirty ? (
        <SaveBar
          blockedReason={blocked ? problems[0] : undefined}
          saving={save.isPending}
          onSave={saveDraft}
          onDiscard={discard}
        />
      ) : null}
    </PageHeader>
  )
}
