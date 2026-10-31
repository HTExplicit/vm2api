import { useEffect, useRef, useState } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
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
import type { CommitResult } from '@/features/vm/credential-panel'

type BrowserPurpose = 'oauth' | 'platform'

type BrowserStatus = {
  type: 'status'
  status: string
  message?: string
  purpose?: BrowserPurpose
  result?: CommitResult
}

type SlotBrowserDialogProps = {
  vmId: string
  email?: string | null
  purpose: BrowserPurpose
  open: boolean
  onOpenChange: (open: boolean) => void
  onComplete?: (result?: CommitResult) => void
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
  onComplete,
}: SlotBrowserDialogProps) {
  const socket = useRef<WebSocket | null>(null)
  const keyboard = useRef<HTMLTextAreaElement | null>(null)
  const viewport = useRef<HTMLDivElement | null>(null)
  const lastMoveAt = useRef(0)
  const inputSeq = useRef(0)
  const callbacks = useRef({ onOpenChange, onComplete })
  callbacks.current = { onOpenChange, onComplete }
  const lifecycle = useRef({ vmId: '', epoch: 0 })
  const opened = useRef('')
  const opening = useRef<{ vmId: string; promise: Promise<unknown> } | null>(
    null
  )
  const completed = useRef(new Set<string>())
  const resultReported = useRef(false)
  const qualityRef = useRef<BrowserQuality>('smooth')
  const purposeRef = useRef(purpose)
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
  const base = `/api/panel/vms/${encodeURIComponent(vmId)}/browser`

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
      if (socket.current?.readyState === WebSocket.OPEN)
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
    const epoch = lifecycle.current.epoch + 1
    lifecycle.current = { vmId: open ? vmId : '', epoch }
    if (!open) {
      opened.current = ''
      opening.current = null
      return
    }
    return () => {
      // Reconnecting the transport keeps the browser alive. Closing the dialog
      // or leaving this slot releases it, including during an in-flight start.
      const starting =
        opening.current?.vmId === vmId ? opening.current.promise : undefined
      void Promise.resolve(starting)
        .catch(() => {})
        .then(() => {
          if (
            lifecycle.current.vmId !== vmId ||
            lifecycle.current.epoch === epoch
          )
            void api(`${base}/close`, { method: 'POST' }).catch(() => {})
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
    setFrame(null)
    setError('')
    setMessage('正在连接槽位浏览器…')
    async function connect() {
      const reopen = await browserNeedsOpening(vmId, opened.current, () =>
        api<{ active: boolean }>(base)
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
        if (cancelled || !ws) return
        setConnected(true)
        setError('')
        ws.send(JSON.stringify({ type: 'quality', mode: qualityRef.current }))
      }
      ws.onmessage = (event: MessageEvent<string | Blob>) => {
        if (cancelled) return
        if (typeof event.data !== 'string') {
          frames.receive(event.data)
          return
        }
        const payload = JSON.parse(event.data) as
          BrowserFrameMetadata | BrowserStatus | { type: 'input_ack' }
        if (payload.type === 'frame') {
          frames.describe(payload)
        } else if (payload.type === 'status') {
          const nextPurpose = payload.purpose || purposeRef.current
          purposeRef.current = nextPurpose
          setCurrentPurpose(nextPurpose)
          setStatus(payload.status)
          setMessage(
            payload.message || browserStatusMessage(payload.status, nextPurpose)
          )
          if (payload.status === 'closed') {
            opened.current = ''
            opening.current = null
          }
          if (payload.status === 'error')
            setError(payload.message || '浏览器任务失败，请重新连接。')
          if (
            payload.status === 'oauth_complete' ||
            payload.status === 'api_ready'
          ) {
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
        if (!cancelled) setError('槽位浏览器连接失败，请重新连接。')
      }
      ws.onclose = () => {
        if (!cancelled) setConnected(false)
      }
    }
    void connect().catch((reason: Error) => {
      if (!cancelled) setError(reason.message)
    })
    return () => {
      cancelled = true
      frames.close()
      ws?.close()
      if (socket.current === ws) socket.current = null
    }
  }, [open, vmId, purpose, attempt, base])

  const send = (payload: object) => {
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(
        JSON.stringify({ ...payload, seq: ++inputSeq.current })
      )
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[94vh] flex-col gap-3 p-4 sm:max-w-6xl'>
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
          {message}
        </p>
        {error ? (
          <p role='alert' className='m-0 text-sm text-destructive'>
            {error}
          </p>
        ) : null}
        <div
          ref={viewport}
          role='application'
          aria-label='账号浏览器，点击网页后可输入文字、粘贴、使用 Tab 和方向键'
          tabIndex={0}
          className='relative min-h-48 min-w-0 flex-1 overflow-auto rounded-md border bg-muted/30 outline-none focus-within:ring-2 focus-within:ring-ring focus-visible:ring-2 focus-visible:ring-ring'
          onFocus={(event) => {
            if (event.target === event.currentTarget) keyboard.current?.focus()
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
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
                  ? 'block h-auto max-w-none select-none'
                  : 'mx-auto block h-auto max-w-full select-none'
              }
              style={originalSize ? { width: frame.width } : undefined}
              onClick={(event) => {
                keyboard.current?.focus()
                send({
                  type: 'click',
                  ...browserInputPoint(
                    event.clientX,
                    event.clientY,
                    event.currentTarget.getBoundingClientRect(),
                    frame
                  ),
                })
              }}
              onMouseMove={(event) => {
                if (Date.now() - lastMoveAt.current < 40) return
                lastMoveAt.current = Date.now()
                send({
                  type: 'move',
                  ...browserInputPoint(
                    event.clientX,
                    event.clientY,
                    event.currentTarget.getBoundingClientRect(),
                    frame
                  ),
                })
              }}
            />
          ) : (
            <p className='p-6 text-sm text-muted-foreground'>
              正在加载官方网页…
            </p>
          )}
        </div>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size='sm'
              disabled={connected}
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
          {currentPurpose === 'oauth' ? (
            status === 'oauth_complete' ? (
              <Button
                size='sm'
                disabled={!connected || switching}
                loading={switching}
                onClick={async () => {
                  setSwitching(true)
                  setError('')
                  try {
                    await api(`${base}/open`, {
                      method: 'POST',
                      body: JSON.stringify({ purpose: 'platform' }),
                    })
                    purposeRef.current = 'platform'
                    setCurrentPurpose('platform')
                    setStatus('opening')
                    setMessage('正在打开 OpenAI Platform…')
                  } catch (reason) {
                    setError((reason as Error).message)
                  } finally {
                    setSwitching(false)
                  }
                }}
              >
                继续进入 Platform
              </Button>
            ) : (
              <p className='m-0 text-xs text-muted-foreground'>
                授权成功后自动保存凭据
              </p>
            )
          ) : (
            <Button
              size='sm'
              disabled={!connected || status === 'api_ready'}
              onClick={() => send({ type: 'continue' })}
            >
              {status === 'api_ready' ? 'API 配置已完成' : '登录完成，继续配置'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
