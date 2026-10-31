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
import { browserInputPoint } from '@/features/vm/browser-input'

type BrowserFrame = {
  type: 'frame'
  image: string
  mime: string
  width: number
  height: number
}

export function OpenaiPlatformBrowserDialog({
  vmId,
  email,
  open,
  onOpenChange,
  onComplete,
}: {
  vmId: string
  email?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onComplete: () => void
}) {
  const socket = useRef<WebSocket | null>(null)
  const keyboard = useRef<HTMLTextAreaElement | null>(null)
  const viewport = useRef<HTMLDivElement | null>(null)
  const lastMoveAt = useRef(0)
  const callbacks = useRef({ onOpenChange, onComplete })
  callbacks.current = { onOpenChange, onComplete }
  const [frame, setFrame] = useState<BrowserFrame | null>(null)
  const [message, setMessage] = useState('正在连接账号浏览器…')
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [originalSize, setOriginalSize] = useState(false)

  useEffect(() => {
    const element = viewport.current
    if (element)
      element.scrollLeft = originalSize
        ? (element.scrollWidth - element.clientWidth) / 2
        : 0
  }, [originalSize])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    let ws: WebSocket | null = null
    api<{ ticket: string; url: string }>(
      `/api/panel/vms/${encodeURIComponent(vmId)}/openai-api/browser-ticket`,
      { method: 'POST' }
    )
      .then((ticket) => {
        if (cancelled) return
        const url = new URL(ticket.url, apiBase() || window.location.href)
        if (!url.searchParams.has('ticket')) {
          url.searchParams.set('ticket', ticket.ticket)
        }
        if (url.protocol === 'https:') url.protocol = 'wss:'
        else if (url.protocol === 'http:') url.protocol = 'ws:'
        ws = new WebSocket(url)
        socket.current = ws
        ws.onopen = () => {
          setConnected(true)
          setError('')
          setMessage(
            '请在此窗口完成官方登录或验证码，再点“登录完成，继续配置”。'
          )
        }
        ws.onmessage = (event) => {
          const payload = JSON.parse(event.data) as
            BrowserFrame | { type: 'status'; status: string; message?: string }
          if (payload.type === 'frame') {
            setFrame(payload)
          } else if (payload.type === 'status') {
            if (payload.message) setMessage(payload.message)
            if (payload.status === 'error') {
              setError(payload.message || '浏览器任务失败，请关闭后继续配置。')
            }
            if (payload.status === 'ready') {
              callbacks.current.onComplete()
              callbacks.current.onOpenChange(false)
            }
          }
        }
        ws.onerror = () => setError('账号浏览器连接失败，请重新连接。')
        ws.onclose = () => setConnected(false)
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message)
      })
    return () => {
      cancelled = true
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'close' }))
      }
      ws?.close()
      socket.current = null
    }
  }, [open, vmId, attempt])

  const send = (payload: object) => {
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify(payload))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[94vh] flex-col gap-3 p-4 sm:max-w-6xl'>
        <DialogHeader className='pe-6'>
          <DialogTitle className='flex items-center gap-2 text-base'>
            <ExternalLink className='size-4' aria-hidden />
            连接 OpenAI Platform
          </DialogTitle>
          <DialogDescription>
            {email || '当前账号'} · 独立固定指纹 · 使用账号绑定代理
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
          onWheel={(event) => {
            event.preventDefault()
            send({ type: 'scroll', deltaX: event.deltaX, deltaY: event.deltaY })
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
              src={`data:${frame.mime};base64,${frame.image}`}
              alt='OpenAI Platform 官方网页'
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
                setFrame(null)
                setAttempt((value) => value + 1)
              }}
            >
              <RefreshCw className='size-3.5' aria-hidden />
              重新连接
            </Button>
            {frame ? (
              <Button
                variant='outline'
                size='sm'
                onClick={() => setOriginalSize((value) => !value)}
              >
                {originalSize ? '适应窗口' : '放大网页'}
              </Button>
            ) : null}
          </div>
          <Button
            size='sm'
            disabled={!connected}
            onClick={() => send({ type: 'continue' })}
          >
            登录完成，继续配置
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
