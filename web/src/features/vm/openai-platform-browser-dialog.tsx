import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { ExternalLink, RefreshCw, X } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { apiBase } from '@/lib/session'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  browserNeedsOpening,
  browserSocketUrl,
  browserStatusMessage,
  decodeBrowserFrame,
  LatestBrowserFrames,
  type BrowserFrameMetadata,
  type BrowserQuality,
  type DisplayedBrowserFrame,
} from '@/features/vm/browser-frames'
import { browserInputPoint } from '@/features/vm/browser-input'
import {
  CodexBrowserFinishError,
  finishCodexBrowserLogin,
  type FinishRetry,
} from '@/features/vm/codex-browser-finish'
import type { CommitResult } from '@/features/vm/credential-panel'

type BrowserPurpose = 'oauth' | 'platform'

type BrowserStatus = {
  type: 'status'
  status: string
  message?: string
  purpose?: BrowserPurpose
  result?: CommitResult
  warning?: string | null
  error?: string
}

type BrowserState = {
  active: boolean
  status?: string
  message?: string | null
  warning?: string | null
}

type BrowserNavigation = {
  type: 'navigation'
  url: string
  loading: boolean
  error?: string
  canReturnToAuthorization: boolean
  inputLocked?: boolean
}

function closeBrowser(
  requests: Map<string, Promise<BrowserState>>,
  vmId: string,
  base: string,
  starting?: Promise<unknown>
) {
  const existing = requests.get(vmId)
  if (existing) return existing
  const request = Promise.resolve(starting)
    .catch(() => {})
    .then(() => api<BrowserState>(`${base}/close`, { method: 'POST' }))
  requests.set(vmId, request)
  const clear = () => {
    if (requests.get(vmId) === request) requests.delete(vmId)
  }
  void request.then(clear, clear)
  return request
}

function isCloseFailure(reason: unknown) {
  return [
    'browser_close_failed',
    'browser_cleanup_failed',
    'browser_temp_cleanup_failed',
  ].includes((reason as { code?: string })?.code || '')
}

type SlotBrowserDialogProps = {
  vmId: string
  email?: string | null
  purpose: BrowserPurpose
  open: boolean
  onOpenChange: (open: boolean) => void
  onCredentialsSaved?: (result?: CommitResult) => void
  onComplete?: (result?: CommitResult) => void
}

type OauthFinish = {
  saved: boolean
  phase: 'idle' | 'starting' | 'checking' | 'scheduling' | 'failed' | 'ready'
  retry: FinishRetry
  result?: CommitResult
  warning: string
  error: string
}

function emptyOauthFinish(): OauthFinish {
  return { saved: false, phase: 'idle', retry: 'start', warning: '', error: '' }
}

export function OpenaiPlatformBrowserDialog(
  props: Omit<SlotBrowserDialogProps, 'purpose'>
) {
  return <SlotBrowserDialog {...props} purpose='platform' />
}

export function SlotBrowserDialog({
  vmId,
  email,
  purpose,
  open,
  onOpenChange,
  onCredentialsSaved,
  onComplete,
}: SlotBrowserDialogProps) {
  const socket = useRef<WebSocket | null>(null)
  const keyboard = useRef<HTMLTextAreaElement | null>(null)
  const viewport = useRef<HTMLDivElement | null>(null)
  const pressedPointer = useRef<{
    id: number
    button: 'left' | 'middle' | 'right'
    point: { x: number; y: number }
  } | null>(null)
  const lastMoveAt = useRef(0)
  const inputSeq = useRef(0)
  const retrying = useRef(false)
  const callbacks = useRef({ onOpenChange, onCredentialsSaved, onComplete })
  callbacks.current = { onOpenChange, onCredentialsSaved, onComplete }
  const lifecycle = useRef({ vmId: '', epoch: 0 })
  const opened = useRef('')
  const opening = useRef<{ vmId: string; promise: Promise<unknown> } | null>(
    null
  )
  const completed = useRef(new Set<string>())
  const resultReported = useRef(false)
  const qualityRef = useRef<BrowserQuality>('smooth')
  const purposeRef = useRef(purpose)
  const finishing = useRef(false)
  const finishReported = useRef(false)
  const completeOnClose = useRef(false)
  const finishRef = useRef<OauthFinish>(emptyOauthFinish())
  const closeRequests = useRef(new Map<string, Promise<BrowserState>>())
  const released = useRef<{ vmId: string; epoch: number } | null>(null)
  const closingRequested = useRef(false)
  const stopTransport = useRef<(() => void) | null>(null)
  const addressEdited = useRef(false)
  const addressFocused = useRef(false)
  const firstNavigation = useRef(true)
  const [finish, setFinish] = useState<OauthFinish>(emptyOauthFinish)
  const [frame, setFrame] = useState<DisplayedBrowserFrame | null>(null)
  const [currentPurpose, setCurrentPurpose] = useState(purpose)
  const [message, setMessage] = useState('正在连接槽位浏览器…')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('starting')
  const [connected, setConnected] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [originalSize, setOriginalSize] = useState(false)
  const [quality, setQuality] = useState<BrowserQuality>('smooth')
  const [switching, setSwitching] = useState(false)
  const [closing, setClosing] = useState(false)
  const [warning, setWarning] = useState('')
  const [address, setAddress] = useState('')
  const [navigation, setNavigation] = useState<BrowserNavigation>({
    type: 'navigation',
    url: '',
    loading: false,
    canReturnToAuthorization: false,
  })
  const [navigationReceived, setNavigationReceived] = useState(false)
  const [errorCode, setErrorCode] = useState('')
  const closeFailed = status === 'close_failed'
  const inputBlocked = closing || closeFailed
  const navigationBlocked =
    inputBlocked ||
    !connected ||
    !navigationReceived ||
    navigation.loading ||
    navigation.inputLocked
  const updateFinish = (next: OauthFinish) => {
    finishRef.current = next
    setFinish(next)
  }
  const finishBusy = ['starting', 'checking', 'scheduling'].includes(
    finish.phase
  )
  const oauthMessage =
    finish.phase === 'ready'
      ? '已开机，内核已就绪，调度已开启。点击“完成”结束登录。'
      : finish.phase === 'starting'
        ? '正在开机并启动内核…'
        : finish.phase === 'checking'
          ? '正在确认目标槽位的内核状态…'
          : finish.phase === 'scheduling'
            ? '内核已就绪，正在开启调度…'
            : '登录凭据已保存。点击“开机并完成”启动槽位并开启调度。'
  const finishActionLabel =
    finish.phase === 'starting'
      ? '正在开机…'
      : finish.phase === 'checking'
        ? '正在检查…'
        : finish.phase === 'scheduling'
          ? '正在开启调度…'
          : finish.phase === 'failed'
            ? finish.retry === 'schedule'
              ? '重试开启调度'
              : finish.retry === 'verify'
                ? '重新检查并完成'
                : '重试开机并完成'
            : '开机并完成'
  const base = `/api/panel/vms/${encodeURIComponent(vmId)}/browser`
  const platformBusy =
    switching ||
    ['queued', 'starting', 'opening', 'configuring'].includes(status)
  const platformActionLabel =
    status === 'api_ready'
      ? 'API 配置已完成'
      : platformBusy
        ? '正在配置…'
        : status === 'error'
          ? '重试配置'
          : status === 'awaiting_key_input'
            ? '检查创建结果'
            : status === 'key_save_failed'
              ? '重试保存'
              : '登录完成，继续配置'

  useEffect(() => {
    const element = viewport.current
    if (element)
      element.scrollLeft = originalSize
        ? (element.scrollWidth - element.clientWidth) / 2
        : 0
  }, [originalSize])

  useEffect(() => {
    const element = viewport.current
    if (!element || !open) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      if (
        !closingRequested.current &&
        socket.current?.readyState === WebSocket.OPEN
      )
        socket.current.send(
          JSON.stringify({
            type: 'scroll',
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            seq: ++inputSeq.current,
          })
        )
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [open])

  useEffect(() => {
    const requests = closeRequests.current
    const epoch = lifecycle.current.epoch + 1
    lifecycle.current = { vmId: open ? vmId : '', epoch }
    retrying.current = false
    finishing.current = false
    finishReported.current = false
    completeOnClose.current = false
    closingRequested.current = false
    released.current = null
    setClosing(false)
    setWarning('')
    addressEdited.current = false
    addressFocused.current = false
    firstNavigation.current = true
    setAddress('')
    setNavigation({
      type: 'navigation',
      url: '',
      loading: false,
      canReturnToAuthorization: false,
    })
    setNavigationReceived(false)
    updateFinish(emptyOauthFinish())
    setSwitching(false)
    if (!open) {
      opened.current = ''
      opening.current = null
      return
    }
    return () => {
      if (released.current?.vmId === vmId && released.current.epoch === epoch)
        return
      if (lifecycle.current.vmId === vmId && lifecycle.current.epoch === epoch)
        lifecycle.current = { vmId: '', epoch: epoch + 1 }
      // Reconnecting the transport keeps the browser alive. Closing the dialog
      // or leaving this slot releases it, including during an in-flight start.
      const starting =
        opening.current?.vmId === vmId ? opening.current.promise : undefined
      const pendingClose = requests.get(vmId)
      if (pendingClose) {
        void pendingClose.then(
          (result) => {
            if (result.warning) toast.warning(result.warning)
          },
          (reason: Error) =>
            toast.error(`账号浏览器未能关闭：${reason.message}`)
        )
        return
      }
      void Promise.resolve(starting)
        .catch(() => {})
        .then(() => {
          if (
            released.current?.vmId === vmId &&
            released.current.epoch >= epoch
          )
            return
          if (
            lifecycle.current.vmId !== vmId ||
            lifecycle.current.epoch === epoch
          )
            return closeBrowser(requests, vmId, base)
              .then((result) => {
                if (result.warning) toast.warning(result.warning)
              })
              .catch((reason: Error) => {
                toast.error(`账号浏览器未能关闭：${reason.message}`)
              })
        })
    }
  }, [open, vmId, base])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    let ws: WebSocket | null = null
    const frames = new LatestBrowserFrames(
      decodeBrowserFrame,
      (next) => {
        if (!cancelled) setFrame(next)
      },
      (url) => URL.revokeObjectURL(url),
      () => {
        if (!cancelled) setError('网页画面解码失败，请重新连接。')
      }
    )
    setConnected(false)
    setNavigationReceived(false)
    setFrame(null)
    setError('')
    setErrorCode('')
    setMessage('正在连接槽位浏览器…')
    async function connect() {
      await closeRequests.current.get(vmId)?.catch(() => {})
      if (cancelled || closingRequested.current) return
      const current = await api<BrowserState>(base)
      if (cancelled || closingRequested.current) return
      setWarning(current.warning || '')
      if (current.status === 'close_failed') {
        closingRequested.current = true
        setStatus('close_failed')
        setMessage(
          current.message || browserStatusMessage('close_failed', purpose)
        )
        setError(current.message || '浏览器清理未完成，请重试关闭。')
        setWarning(current.warning || '')
        return
      }
      const reopen = await browserNeedsOpening(
        vmId,
        opened.current,
        async () => current
      )
      if (cancelled) return
      if (reopen) {
        if (opened.current === vmId) {
          opened.current = ''
          opening.current = null
        }
        const targetPurpose = attempt ? purposeRef.current : purpose
        purposeRef.current = targetPurpose
        setCurrentPurpose(targetPurpose)
        completed.current.clear()
        resultReported.current = false
        if (opening.current?.vmId !== vmId) {
          const request = {
            vmId,
            promise: api(`${base}/open`, {
              method: 'POST',
              body: JSON.stringify({ purpose: targetPurpose }),
            }),
          }
          opening.current = request
          void request.promise.catch(() => {
            if (opening.current === request) opening.current = null
          })
        }
        await opening.current?.promise
        if (cancelled) return
        opened.current = vmId
      }
      if (cancelled) return
      const ticket = await api<{ ticket: string; url: string }>(
        `/api/panel/vms/${encodeURIComponent(vmId)}/browser-ticket`,
        { method: 'POST' }
      )
      if (cancelled) return
      ws = new WebSocket(
        browserSocketUrl(
          ticket.url,
          ticket.ticket,
          apiBase() || window.location.href
        )
      )
      ws.binaryType = 'blob'
      socket.current = ws
      ws.onopen = () => {
        if (cancelled || closingRequested.current || !ws) return
        setConnected(true)
        setError('')
        ws.send(JSON.stringify({ type: 'quality', mode: qualityRef.current }))
      }
      ws.onmessage = (event: MessageEvent<string | Blob>) => {
        if (cancelled) return
        if (typeof event.data !== 'string') {
          if (!closingRequested.current) frames.receive(event.data)
          return
        }
        const payload = JSON.parse(event.data) as
          | BrowserFrameMetadata
          | BrowserStatus
          | BrowserNavigation
          | { type: 'input_ack' }
        if (payload.type === 'frame') {
          if (!closingRequested.current) frames.describe(payload)
        } else if (payload.type === 'navigation') {
          setNavigation(payload)
          setNavigationReceived(true)
          if (
            firstNavigation.current ||
            (!addressEdited.current && !addressFocused.current)
          ) {
            setAddress(payload.url)
            addressEdited.current = false
          }
          firstNavigation.current = false
        } else if (payload.type === 'status') {
          const nextPurpose = payload.purpose || purposeRef.current
          purposeRef.current = nextPurpose
          setCurrentPurpose(nextPurpose)
          setStatus(payload.status)
          setWarning(payload.warning || '')
          setMessage(
            payload.message || browserStatusMessage(payload.status, nextPurpose)
          )
          if (payload.status === 'closed') {
            opened.current = ''
            opening.current = null
            closingRequested.current = false
            setClosing(false)
            setConnected(false)
            setFrame(null)
            frames.close()
            ws?.close()
          }
          if (payload.status === 'closing') {
            closingRequested.current = true
            setClosing(true)
            setConnected(false)
            setFrame(null)
            frames.close()
          } else if (payload.status === 'close_failed') {
            closingRequested.current = true
            setClosing(false)
            setConnected(false)
            setFrame(null)
            frames.close()
            ws?.close()
            setError(payload.message || '浏览器清理未完成，请重试关闭。')
          } else if (payload.status === 'error') {
            setError(payload.message || '浏览器任务失败，请重新连接。')
            setErrorCode(payload.error || '')
          } else {
            setError('')
            setErrorCode('')
          }
          if (purpose === 'oauth' && payload.status === 'oauth_complete') {
            const previous = finishRef.current
            updateFinish({
              ...previous,
              saved: true,
              result: payload.result || previous.result,
              warning: payload.message?.includes('会话保存失败')
                ? payload.message
                : previous.warning,
            })
            if (!previous.saved) {
              callbacks.current.onCredentialsSaved?.(payload.result)
            }
          } else if (purpose === 'platform' && payload.status === 'api_ready') {
            if (!completed.current.has(payload.status)) {
              completed.current.add(payload.status)
              callbacks.current.onComplete?.(payload.result)
              if (payload.result) resultReported.current = true
            } else if (payload.result && !resultReported.current) {
              resultReported.current = true
              callbacks.current.onComplete?.(payload.result)
            }
          }
        }
      }
      ws.onerror = () => {
        if (!cancelled && !closingRequested.current)
          setError('槽位浏览器连接失败，请重新连接。')
      }
      ws.onclose = () => {
        if (!cancelled) {
          setConnected(false)
        }
      }
    }
    void connect().catch((reason: Error) => {
      if (!cancelled && !closingRequested.current) {
        if (isCloseFailure(reason)) {
          closingRequested.current = true
          setStatus('close_failed')
          setMessage('浏览器清理未完成，请重试关闭。')
        }
        setError(reason.message)
        setErrorCode((reason as { code?: string }).code || '')
      }
    })
    const stop = () => {
      cancelled = true
      pressedPointer.current = null
      frames.close()
      ws?.close()
      if (socket.current === ws) socket.current = null
    }
    stopTransport.current = stop
    return () => {
      stop()
      if (stopTransport.current === stop) stopTransport.current = null
    }
  }, [open, vmId, purpose, attempt, base])

  const send = (payload: object) => {
    if (
      !closingRequested.current &&
      socket.current?.readyState === WebSocket.OPEN
    ) {
      socket.current.send(
        JSON.stringify({ ...payload, seq: ++inputSeq.current })
      )
    }
  }

  const navigate = () => {
    if (navigationBlocked || closingRequested.current) return
    const url = address.trim()
    try {
      const target = new URL(url)
      if (target.protocol !== 'http:' && target.protocol !== 'https:')
        throw new Error()
    } catch {
      setNavigation({
        ...navigation,
        error: '请输入 http:// 或 https:// 开头的完整网址。',
      })
      return
    }
    addressEdited.current = false
    addressFocused.current = false
    setAddress(url)
    setNavigation({ ...navigation, loading: true, error: undefined })
    send({ type: 'navigate', url })
  }

  const returnToAuthorization = () => {
    if (navigationBlocked || closingRequested.current) return
    addressEdited.current = false
    addressFocused.current = false
    setNavigation({ ...navigation, loading: true, error: undefined })
    send({ type: 'return_to_authorization' })
  }

  const startAndFinish = async () => {
    if (finishing.current || !finishRef.current.saved) return
    finishing.current = true
    const epoch = lifecycle.current.epoch
    const isCurrent = () =>
      lifecycle.current.epoch === epoch &&
      lifecycle.current.vmId === vmId &&
      !closingRequested.current
    setError('')
    updateFinish({ ...finishRef.current, error: '' })
    try {
      await finishCodexBrowserLogin(vmId, {
        retry: finishRef.current.retry,
        isCurrent,
        onProgress: (phase) => {
          if (isCurrent()) updateFinish({ ...finishRef.current, phase })
        },
      })
      if (isCurrent())
        updateFinish({ ...finishRef.current, phase: 'ready', error: '' })
    } catch (reason) {
      if (isCurrent())
        updateFinish({
          ...finishRef.current,
          phase: 'failed',
          retry:
            reason instanceof CodexBrowserFinishError ? reason.retry : 'verify',
          error: (reason as Error).message,
        })
    } finally {
      if (isCurrent()) finishing.current = false
    }
  }

  const dismiss = async (complete = false) => {
    if (closeRequests.current.has(vmId)) return
    if (
      complete &&
      (finishRef.current.phase !== 'ready' || finishReported.current)
    )
      return
    if (complete) completeOnClose.current = true
    const epoch = lifecycle.current.epoch
    const isCurrent = () =>
      lifecycle.current.vmId === vmId && lifecycle.current.epoch === epoch
    closingRequested.current = true
    finishing.current = false
    setClosing(true)
    setError('')
    setStatus('closing')
    setMessage('正在关闭浏览器并清理临时文件…')
    setConnected(false)
    setFrame(null)
    stopTransport.current?.()
    try {
      const result = await closeBrowser(
        closeRequests.current,
        vmId,
        base,
        opening.current?.vmId === vmId ? opening.current.promise : undefined
      )
      if (!isCurrent()) return
      if (result.warning) toast.warning(result.warning)
      released.current = { vmId, epoch }
      opened.current = ''
      opening.current = null
      if (completeOnClose.current && !finishReported.current) {
        finishReported.current = true
        callbacks.current.onComplete?.(finishRef.current.result)
      }
      lifecycle.current = { vmId: '', epoch: epoch + 1 }
      callbacks.current.onOpenChange(false)
    } catch (reason) {
      if (!isCurrent()) return
      setStatus('close_failed')
      setMessage('浏览器清理未完成，请重试关闭。')
      setError((reason as Error).message)
    } finally {
      if (isCurrent()) setClosing(false)
    }
  }

  const completeOauth = () => void dismiss(true)

  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen) void dismiss()
    else callbacks.current.onOpenChange(true)
  }

  const retryPlatformSetup = async () => {
    if (retrying.current || closingRequested.current) return
    retrying.current = true
    const epoch = lifecycle.current.epoch
    setSwitching(true)
    setError('')
    setStatus('opening')
    setMessage('正在重新启动 API 配置…')
    const request = {
      vmId,
      promise: api(`${base}/open`, {
        method: 'POST',
        body: JSON.stringify({ purpose: 'platform' }),
      }),
    }
    opening.current = request
    try {
      await request.promise
    } catch (reason) {
      if (opening.current === request) opening.current = null
      if (lifecycle.current.epoch !== epoch) return
      setStatus('error')
      setMessage('API 配置未能启动，可在当前窗口重试。')
      setError((reason as Error).message)
    } finally {
      if (lifecycle.current.epoch === epoch) {
        retrying.current = false
        setSwitching(false)
      }
    }
  }

  const releasePointer = (
    event: PointerEvent<HTMLImageElement>,
    cancelled = false
  ) => {
    const pressed = pressedPointer.current
    if (!pressed || pressed.id !== event.pointerId || !frame) return
    event.preventDefault()
    const point = cancelled
      ? pressed.point
      : browserInputPoint(
          event.clientX,
          event.clientY,
          event.currentTarget.getBoundingClientRect(),
          frame
        )
    pressedPointer.current = null
    send({ type: 'mouse_up', button: pressed.button, ...point })
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        showCloseButton={false}
        className='flex max-h-[94vh] flex-col gap-3 p-4 sm:max-w-6xl'
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          if (!event.isComposing) void dismiss()
        }}
        onPointerDownOutside={(event) => {
          event.preventDefault()
          void dismiss()
        }}
      >
        <Button
          variant='ghost'
          size='icon'
          className='absolute end-3 top-3 size-7 text-muted-foreground'
          aria-label='关闭浏览器窗口'
          disabled={closing}
          onClick={() => void dismiss()}
        >
          <X className='size-4' aria-hidden />
        </Button>
        <DialogHeader className='pe-6'>
          <DialogTitle className='flex items-center gap-2 text-base'>
            <ExternalLink className='size-4' aria-hidden />
            {currentPurpose === 'oauth'
              ? 'OpenAI 浏览器登录'
              : '连接 OpenAI Platform'}
          </DialogTitle>
          <DialogDescription>
            {email || '首次登录'} · 槽位固定指纹 · 使用当前绑定代理
          </DialogDescription>
        </DialogHeader>
        <p className='m-0 text-xs text-muted-foreground' role='status'>
          {!inputBlocked &&
          purpose === 'oauth' &&
          finish.saved &&
          currentPurpose === 'oauth'
            ? oauthMessage
            : message}
        </p>
        {purpose === 'oauth' && finish.warning ? (
          <p className='m-0 text-xs text-muted-foreground'>{finish.warning}</p>
        ) : null}
        {warning ? (
          <p className='m-0 text-xs text-muted-foreground'>{warning}</p>
        ) : null}
        {finish.error || error ? (
          <p role='alert' className='m-0 text-sm text-destructive'>
            {finish.error || error}
          </p>
        ) : null}
        {error &&
        [
          'browser_not_installed',
          'browser_key_missing',
          'key_missing',
        ].includes(errorCode) ? (
          <a
            href='#/settings/openai'
            className='text-sm text-primary underline underline-offset-4'
            onClick={() => void dismiss()}
          >
            前往账号浏览器设置，填写 key 并安装内核
          </a>
        ) : null}
        <div className='space-y-1.5'>
          <div className='flex flex-wrap items-center gap-2'>
            <Input
              aria-label='浏览器地址'
              aria-invalid={!!navigation.error}
              title={navigation.url}
              value={address}
              autoComplete='off'
              spellCheck={false}
              placeholder='https://…'
              disabled={!!navigationBlocked}
              className='min-w-0 flex-[1_1_12rem]'
              onChange={(event) => {
                addressEdited.current = true
                setAddress(event.target.value)
              }}
              onFocus={() => {
                addressFocused.current = true
              }}
              onBlur={() => {
                addressFocused.current = false
                if (!addressEdited.current) setAddress(navigation.url)
              }}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key !== 'Enter') return
                event.preventDefault()
                if (event.nativeEvent.isComposing || event.keyCode === 229)
                  return
                navigate()
              }}
            />
            <Button
              type='button'
              size='sm'
              variant='outline'
              aria-label='前往网页'
              disabled={!!navigationBlocked || !address.trim()}
              loading={navigation.loading}
              onClick={navigate}
            >
              前往
            </Button>
            {navigation.canReturnToAuthorization ? (
              <Button
                type='button'
                size='sm'
                variant='outline'
                aria-label='返回当前授权页'
                disabled={!!navigationBlocked}
                onClick={returnToAuthorization}
              >
                返回当前授权页
              </Button>
            ) : null}
          </div>
          {navigation.error ? (
            <p role='alert' className='m-0 text-xs text-destructive'>
              {navigation.error}
            </p>
          ) : null}
        </div>
        <div
          ref={viewport}
          role='application'
          aria-label='账号浏览器，点击网页后可输入文字、粘贴、使用 Tab 和方向键'
          aria-disabled={inputBlocked}
          tabIndex={0}
          className='relative min-h-48 min-w-0 flex-1 overflow-auto rounded-md border bg-muted/30 outline-none focus-within:ring-2 focus-within:ring-ring focus-visible:ring-2 focus-visible:ring-ring'
          onFocus={(event) => {
            if (event.target === event.currentTarget)
              keyboard.current?.focus({ preventScroll: true })
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              void dismiss()
              return
            }
            if (closingRequested.current) return
            if (
              (event.ctrlKey || event.metaKey) &&
              event.key.toLowerCase() === 'v'
            )
              return
            event.preventDefault()
            event.stopPropagation()
            const modifiers = [
              event.ctrlKey && 'Control',
              event.metaKey && 'Meta',
              event.altKey && 'Alt',
              event.shiftKey && event.key.length !== 1 && 'Shift',
            ].filter(Boolean)
            if (
              event.key.length === 1 &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey
            ) {
              send({ type: 'text', text: event.key })
            } else if (
              !['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)
            ) {
              send({
                type: 'key',
                key: [
                  ...modifiers,
                  event.key === ' ' ? 'Space' : event.key,
                ].join('+'),
              })
            }
          }}
          onCompositionEnd={(event) => {
            send({ type: 'text', text: event.data })
            if (keyboard.current) keyboard.current.value = ''
          }}
          onPaste={(event) => {
            event.preventDefault()
            send({
              type: 'text',
              text: event.clipboardData.getData('text/plain'),
            })
          }}
        >
          <textarea
            ref={keyboard}
            aria-label='远程浏览器输入'
            autoComplete='off'
            spellCheck={false}
            className='absolute start-0 top-0 h-px w-px resize-none overflow-hidden opacity-0'
            onInput={(event) => {
              if (!(event.nativeEvent as InputEvent).isComposing)
                event.currentTarget.value = ''
            }}
          />
          {frame ? (
            <img
              src={frame.url}
              alt='OpenAI 官方登录与账号网页'
              draggable={false}
              className={
                originalSize
                  ? 'block h-auto max-w-none touch-none select-none'
                  : 'mx-auto block h-auto max-w-full touch-none select-none'
              }
              style={originalSize ? { width: frame.width } : undefined}
              onPointerDown={(event) => {
                const button = (['left', 'middle', 'right'] as const)[
                  event.button
                ]
                if (!button || pressedPointer.current) return
                event.preventDefault()
                const point = browserInputPoint(
                  event.clientX,
                  event.clientY,
                  event.currentTarget.getBoundingClientRect(),
                  frame
                )
                pressedPointer.current = {
                  id: event.pointerId,
                  button,
                  point,
                }
                event.currentTarget.setPointerCapture(event.pointerId)
                keyboard.current?.focus({ preventScroll: true })
                send({
                  type: 'mouse_down',
                  button,
                  ...point,
                })
              }}
              onPointerUp={(event) => releasePointer(event)}
              onPointerCancel={(event) => releasePointer(event, true)}
              onLostPointerCapture={(event) => releasePointer(event, true)}
              onContextMenu={(event) => event.preventDefault()}
              onPointerMove={(event) => {
                const pressed = pressedPointer.current
                if (pressed && pressed.id !== event.pointerId) return
                const point = browserInputPoint(
                  event.clientX,
                  event.clientY,
                  event.currentTarget.getBoundingClientRect(),
                  frame
                )
                if (pressed) pressed.point = point
                if (Date.now() - lastMoveAt.current < 40) return
                lastMoveAt.current = Date.now()
                send({
                  type: 'move',
                  ...point,
                })
              }}
            />
          ) : (
            <p className='p-6 text-sm text-muted-foreground'>
              {inputBlocked ? '画面与输入已停止。' : '正在加载官方网页…'}
            </p>
          )}
        </div>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size='sm'
              aria-label='重新连接'
              disabled={connected || inputBlocked}
              onClick={() => {
                setAttempt((value) => value + 1)
              }}
            >
              <RefreshCw className='size-3.5' aria-hidden />
              重新连接
            </Button>
            {frame ? (
              <>
                <Button
                  variant='outline'
                  size='sm'
                  aria-pressed={quality === 'native'}
                  onClick={() => {
                    const mode = quality === 'smooth' ? 'native' : 'smooth'
                    qualityRef.current = mode
                    setQuality(mode)
                    send({ type: 'quality', mode })
                  }}
                >
                  {quality === 'smooth'
                    ? '流畅画面 · 切原图'
                    : '原图画面 · 切流畅'}
                </Button>
                <Button
                  variant='outline'
                  size='sm'
                  aria-pressed={originalSize}
                  onClick={() => setOriginalSize((value) => !value)}
                >
                  {originalSize ? '适应窗口' : '放大网页'}
                </Button>
              </>
            ) : null}
          </div>
          <div className='flex flex-wrap items-center gap-2'>
            {currentPurpose === 'oauth' ? (
              purpose === 'oauth' && finish.phase === 'ready' ? (
                <Button
                  size='sm'
                  variant='outline'
                  disabled={!connected || switching || inputBlocked}
                  loading={switching}
                  onClick={async () => {
                    const epoch = lifecycle.current.epoch
                    setSwitching(true)
                    setError('')
                    try {
                      await api(`${base}/open`, {
                        method: 'POST',
                        body: JSON.stringify({ purpose: 'platform' }),
                      })
                      if (lifecycle.current.epoch !== epoch) return
                      purposeRef.current = 'platform'
                      setCurrentPurpose('platform')
                      setStatus('opening')
                      setMessage('正在打开 OpenAI Platform…')
                    } catch (reason) {
                      if (lifecycle.current.epoch === epoch)
                        setError((reason as Error).message)
                    } finally {
                      if (lifecycle.current.epoch === epoch) setSwitching(false)
                    }
                  }}
                >
                  继续进入 Platform
                </Button>
              ) : !finish.saved ? (
                <p className='m-0 text-xs text-muted-foreground'>
                  授权成功后自动保存凭据，再开机完成配置
                </p>
              ) : null
            ) : (
              <Button
                size='sm'
                aria-label={platformActionLabel}
                disabled={
                  !connected ||
                  platformBusy ||
                  status === 'api_ready' ||
                  inputBlocked
                }
                loading={platformBusy}
                onClick={() => {
                  if (status === 'error') void retryPlatformSetup()
                  else send({ type: 'continue' })
                }}
              >
                {platformActionLabel}
              </Button>
            )}
            {purpose === 'oauth' && finish.saved ? (
              finish.phase === 'ready' ? (
                <Button
                  size='sm'
                  aria-label='完成'
                  disabled={inputBlocked}
                  onClick={completeOauth}
                >
                  完成
                </Button>
              ) : (
                <Button
                  size='sm'
                  aria-label={finishActionLabel}
                  disabled={finishBusy || inputBlocked}
                  loading={finishBusy}
                  onClick={() => void startAndFinish()}
                >
                  {finishActionLabel}
                </Button>
              )
            ) : null}
            <Button
              size='sm'
              variant={closeFailed ? 'default' : 'outline'}
              aria-label={
                closing ? '正在关闭…' : closeFailed ? '重试关闭' : '关闭浏览器'
              }
              disabled={closing}
              loading={closing}
              onClick={() => void dismiss()}
            >
              {closing ? '正在关闭…' : closeFailed ? '重试关闭' : '关闭浏览器'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
