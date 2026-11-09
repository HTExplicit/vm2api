import { useMemo, useState } from 'react'
import { Code2, Copy, Download, Eye } from 'lucide-react'
import { toast } from 'sonner'
import { copyText } from '@/lib/clipboard'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { extractPelicanHtml } from './output'
import { PelicanPreview } from './preview'
import type { PelicanView } from './result-card'

export function PelicanResultViewer({
  view,
  onClose,
}: {
  view: PelicanView
  onClose: () => void
}) {
  const [tab, setTab] = useState(view.tab)
  const text = view.item.result?.text || ''
  const html = useMemo(() => extractPelicanHtml(text), [text])

  function download() {
    if (!html) return
    const url = URL.createObjectURL(
      new Blob([html], { type: 'text/html;charset=utf-8' })
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `pelican-${view.item.vmId}-${view.batch.id}.html`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className='max-h-[94svh] gap-3 overflow-y-auto p-4 sm:max-w-[min(94vw,1120px)]'>
        <DialogHeader className='pr-8 text-left'>
          <DialogTitle className='truncate text-base'>
            {view.item.email || view.item.vmName}
          </DialogTitle>
          <DialogDescription className='truncate'>
            {view.batch.model} · {view.batch.reasoningEffort} ·{' '}
            {view.item.vmName}
          </DialogDescription>
        </DialogHeader>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <div className='flex gap-1' aria-label='结果视图'>
            <Button
              type='button'
              size='sm'
              variant={tab === 'preview' ? 'secondary' : 'ghost'}
              aria-pressed={tab === 'preview'}
              onClick={() => setTab('preview')}
              disabled={!html}
            >
              <Eye aria-hidden />
              动画
            </Button>
            <Button
              type='button'
              size='sm'
              variant={tab === 'source' ? 'secondary' : 'ghost'}
              aria-pressed={tab === 'source'}
              onClick={() => setTab('source')}
            >
              <Code2 aria-hidden />
              源码
            </Button>
          </div>
          <div className='flex gap-1'>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              onClick={async () => {
                const copied = await copyText(text)
                if (copied) toast.success('源码已复制')
                else toast.error('复制失败，请在源码中手动复制')
              }}
            >
              <Copy aria-hidden />
              复制源码
            </Button>
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={!html}
              onClick={download}
            >
              <Download aria-hidden />
              下载 HTML
            </Button>
          </div>
        </div>
        {tab === 'preview' && html ? (
          <PelicanPreview
            html={html}
            title={`${view.item.email || view.item.vmName} 的放大动画`}
            className='rounded-lg'
          />
        ) : (
          <pre className='max-h-[65svh] min-h-64 overflow-auto rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap'>
            <code>{text}</code>
          </pre>
        )}
      </DialogContent>
    </Dialog>
  )
}
