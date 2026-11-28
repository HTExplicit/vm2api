import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import { Info } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { PageHeader } from '@/components/page-header'
import { QueryGate } from '@/components/query-gate'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { routingQueryOptions } from '@/features/settings/queries'
import { SaveBar } from '@/features/settings/save-bar'
import { SettingsSkeleton } from '@/features/settings/settings-skeleton'
import {
  CragGeminiPanel,
  cragGeminiPromptProblem,
} from '@/features/system/craggemini-panel'
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
  type SystemPromptKernelSet,
} from './compat-patch'

type RoutingSaveResult = {
  compatibility?: Record<string, unknown>
  kernel_persona?: { updated?: number; skipped?: number } | null
}

function followError(message: string) {
  if (/config_missing|kernel_start_failed|wrap_cli_missing/i.test(message)) {
    return '内核文件缺失，先到内核页拉取 wrap/crag 二进制再同步'
  }
  return message
}

export function SystemPromptPage() {
  const routing = useQuery(routingQueryOptions())
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [personaProblems, setPersonaProblems] = useState<string[]>([])
  const [discardKey, setDiscardKey] = useState(0)
  const [kernelSet, setKernelSet] = useState<
    SystemPromptKernelSet | 'openai'
  >('claude')
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
          kernelSet === 'openai' ? 'claude' : kernelSet,
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
  const cragGeminiProblem = cragGeminiPromptProblem(
    draft.compatibility as Record<string, unknown> | undefined
  )
  const problems = cragGeminiProblem
    ? [...personaProblems, cragGeminiProblem]
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
    <PageHeader title={VIEW_TITLES.system}>
      <div className={cn(dirty && 'pb-16')}>
        <Alert className='mb-4'>
          <Info className='size-4' />
          <AlertTitle>
            全局默认兜底（仅作用于选择「继承全局」的 Anthropic 分组池）
          </AlertTitle>
          <AlertDescription className='flex flex-wrap items-center gap-x-2 gap-y-1'>
            <span>
              本页配置仅作为 Anthropic
              分组池选择「继承全局（inherit_global）」时的默认兜底；各 Anthropic
              分组池的独立 System Prompt
              策略优先级高于全局默认，保存全局配置不会清空任何分组池或单槽覆盖。
            </span>
            <Link
              to='/pools'
              className='font-medium text-primary underline underline-offset-4'
            >
              前往分组池配置独立策略 →
            </Link>
          </AlertDescription>
        </Alert>
        <QueryGate
          loading={routing.isLoading}
          error={routing.error}
          skeleton={<SettingsSkeleton />}
        >
          <div
            role='tablist'
            aria-label='系统提示词配置'
            className='mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4'
          >
            {(
              [
                ['claude', 'Claude 系统提示词', 'CLI 和 CRAG 内核共用'],
                [
                  'craggemini',
                  'CRAGGemini (Antigravity)',
                  'agy 官方 / 0 提示词',
                ],
                ['openai', 'OpenAI', '订阅和 API 提示词追加'],
              ] as const
            ).map(([value, label, detail]) => {
              const selected = kernelSet === value
              return (
                <button
                  key={value}
                  type='button'
                  role='tab'
                  aria-selected={selected}
                  onClick={() => setKernelSet(value)}
                  className={cn(
                    'cursor-pointer rounded-xl border px-3.5 py-2.5 text-left transition-colors duration-200 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                    selected
                      ? 'border-primary/50 bg-primary/5'
                      : 'border-border/60 bg-card hover:border-border hover:bg-muted/40'
                  )}
                >
                  <span className='block text-sm font-medium'>{label}</span>
                  <span className='text-[11px] text-muted-foreground'>
                    {detail}
                  </span>
                </button>
              )
            })}
          </div>
          <div hidden={kernelSet !== 'claude'}>
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
          <div hidden={kernelSet !== 'craggemini'}>
            <CragGeminiPanel
              compat={
                (draft.compatibility as Record<string, unknown> | undefined) ||
                {}
              }
              onChange={(next) => setDraft({ ...draft, compatibility: next })}
            />
          </div>
          <div hidden={kernelSet !== 'openai'}>
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
