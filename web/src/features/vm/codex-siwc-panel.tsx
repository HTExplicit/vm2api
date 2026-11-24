import { useId, useState } from 'react'
import type { Vm } from '@/types/panel-vm'
import { ApiError, api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SlotBrowserDialog } from './openai-platform-browser-dialog'

type Attempt = { session_id: string; auth_url: string; expires_at: number }

function stateLabel(vm: Vm) {
  const state = vm.codex_siwc
  if (state?.status === 'reauth_required') return '需要重新绑定'
  if (state?.status === 'refresh_outcome_unknown') return '续期结果未确认'
  if (state?.status === 'refresh_pending') return '正在续期'
  if (state?.enabled) return '已启用'
  return state?.bound ? '已绑定，当前使用普通 Codex' : '未绑定'
}

export function CodexSiwcPanel({
  vm,
  onChanged,
}: {
  vm: Vm
  onChanged: () => unknown
}) {
  const path = '/api/panel/vms/' + encodeURIComponent(vm.id) + '/siwc'
  const state = vm.codex_siwc
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [callback, setCallback] = useState('')
  const [browserOpen, setBrowserOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const urlId = useId()
  const callbackId = useId()

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setMessage('')
    try {
      await action()
    } catch (error) {
      setMessage(
        error instanceof ApiError ? error.message : 'SIWC 操作失败，请重试。'
      )
    } finally {
      setBusy(false)
    }
  }

  function begin(browser: boolean) {
    void run(async () => {
      const session = await api<Attempt>(path + '/bind', { method: 'POST' })
      setAttempt(session)
      setCallback('')
      setBrowserOpen(browser)
    })
  }

  function bound() {
    setBrowserOpen(false)
    setAttempt(null)
    setCallback('')
    setMessage('SIWC 已绑定并启用。')
    void onChanged()
  }

  async function copyLink() {
    if (!attempt) return
    try {
      await navigator.clipboard.writeText(attempt.auth_url)
      setMessage('已复制授权链接。')
    } catch {
      setMessage('无法访问剪贴板，请选中授权链接并手动复制。')
    }
  }

  const models = state?.models?.filter((model) => model.visible) || []
  return (
    <section
      className='space-y-2 border-t pt-3'
      aria-label='Sign in with ChatGPT'
    >
      <div className='flex flex-wrap items-baseline gap-x-2 gap-y-1'>
        <h3 className='text-sm font-medium'>Sign in with ChatGPT（SIWC）</h3>
        <span className='text-xs text-muted-foreground'>{stateLabel(vm)}</span>
      </div>
      <p className='text-xs text-muted-foreground'>
        使用当前槽位的 ChatGPT 计划调用模型。
        <a
          className='ms-1 underline underline-offset-2'
          href='https://chatgpt.com/settings/usage'
          target='_blank'
          rel='noreferrer'
        >
          管理 ChatGPT 用量
        </a>
      </p>
      {state?.expires_at ? (
        <p className='text-xs text-muted-foreground'>
          访问令牌到期 {new Date(state.expires_at).toLocaleString()}
        </p>
      ) : null}
      <div className='flex flex-wrap gap-2'>
        <Button
          type='button'
          size='sm'
          disabled={busy}
          onClick={() => begin(true)}
        >
          {state?.bound ? '在槽位浏览器重新绑定' : '在槽位浏览器绑定'}
        </Button>
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={busy}
          onClick={() => begin(false)}
        >
          手动授权
        </Button>
        {state?.bound || state?.enabled ? (
          <>
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={busy || (!state.enabled && !state.has_token)}
              onClick={() =>
                void run(async () => {
                  await api(path, {
                    method: 'PATCH',
                    body: JSON.stringify({ enabled: !state.enabled }),
                  })
                  setAttempt(null)
                  setMessage(
                    state.enabled ? '已切回普通 Codex。' : '已启用 SIWC。'
                  )
                  void onChanged()
                })
              }
            >
              {state.enabled ? '切回普通 Codex' : '启用 SIWC'}
            </Button>
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api(path, { method: 'DELETE' })
                  setAttempt(null)
                  setMessage('已解除本地 SIWC 绑定。')
                  void onChanged()
                })
              }
            >
              本地解绑
            </Button>
          </>
        ) : null}
        {state?.bound && state.has_token ? (
          <Button
            type='button'
            size='sm'
            variant='outline'
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api(path + '/models', { method: 'POST' })
                setMessage('已刷新 SIWC 模型目录。')
                void onChanged()
              })
            }
          >
            刷新账号模型
          </Button>
        ) : null}
      </div>
      {models.length ? (
        <details className='text-xs text-muted-foreground'>
          <summary className='cursor-pointer'>账号可用模型</summary>
          <ul className='mt-1 flex flex-wrap gap-x-3 gap-y-1'>
            {models.map((model) => (
              <li key={model.id}>{model.name}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {attempt ? (
        <>
          <div className='space-y-2 rounded-md border p-3'>
            <Label htmlFor={urlId}>SIWC 授权链接</Label>
            <div className='flex gap-2'>
              <Input
                id={urlId}
                readOnly
                value={attempt.auth_url}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button
                type='button'
                size='sm'
                variant='outline'
                onClick={() => void copyLink()}
              >
                复制授权链接
              </Button>
            </div>
            <p className='text-xs text-muted-foreground'>
              请在 5 分钟内完成授权，并从地址栏复制完整回调
              URL。回调页打不开时也可复制地址。
            </p>
            <Label htmlFor={callbackId}>回调 URL</Label>
            <Input
              id={callbackId}
              value={callback}
              autoComplete='off'
              spellCheck={false}
              onChange={(event) => setCallback(event.target.value)}
            />
            <div className='flex flex-wrap gap-2'>
              <Button
                type='button'
                size='sm'
                disabled={busy || !callback.trim()}
                onClick={() =>
                  void run(async () => {
                    await api(path + '/callback', {
                      method: 'POST',
                      body: JSON.stringify({
                        session_id: attempt.session_id,
                        callback_url: callback.trim(),
                      }),
                    })
                    bound()
                  })
                }
              >
                提交回调
              </Button>
              <Button
                type='button'
                size='sm'
                variant='outline'
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(path + '/cancel', {
                      method: 'POST',
                      body: JSON.stringify({ session_id: attempt.session_id }),
                    })
                    setAttempt(null)
                    setCallback('')
                  })
                }
              >
                取消授权
              </Button>
            </div>
          </div>
          {browserOpen ? (
            <SlotBrowserDialog
              vmId={vm.id}
              email={vm.email}
              purpose='oauth'
              siwcSession={attempt.session_id}
              open={browserOpen}
              onOpenChange={setBrowserOpen}
              onComplete={bound}
            />
          ) : null}
        </>
      ) : null}
      <p role='status' className='text-xs text-muted-foreground'>
        {message}
      </p>
    </section>
  )
}
