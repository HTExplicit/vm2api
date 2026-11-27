import { Badge } from '@/components/ui/badge'

const labels = {
  'codex-kernel': 'Codex',
  'codex-siwc': 'SIWC',
  'siwc-prewarm': 'SIWC 预热',
}

export function GptRouteBadge({
  via,
  reauth = false,
}: {
  via: keyof typeof labels
  reauth?: boolean
}) {
  return (
    <Badge
      variant={via === 'codex-kernel' ? 'outline' : 'secondary'}
      className='rounded px-1 py-0 text-[10px] leading-tight'
    >
      {labels[via]}
      {reauth ? <span className='text-destructive'>需重新绑定</span> : null}
    </Badge>
  )
}
