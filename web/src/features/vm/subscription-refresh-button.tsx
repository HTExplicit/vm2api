import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { OpenaiSubscription, Vm } from '@/types/panel-vm'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

export function SubscriptionRefreshButton({ vm }: { vm: Vm }) {
  const qc = useQueryClient()
  const canRefresh = useVmPerms().credential
  const refresh = useMutation({
    mutationFn: () =>
      api<{ vm_id: string; subscription: OpenaiSubscription }>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/openai-subscription/refresh`,
        { method: 'POST', body: '{}' }
      ),
    onSuccess: () => toast.success('已刷新订阅信息'),
    onError: (error: Error) => toast.error(error.message),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
        qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ]),
  })

  if (!canRefresh) return null

  return (
    <Button
      size='sm'
      variant='ghost'
      className='h-6 gap-1 px-1.5 text-xs text-muted-foreground'
      disabled={refresh.isPending}
      onClick={() => refresh.mutate()}
    >
      <RefreshCw
        aria-hidden
        className={cn('size-3', refresh.isPending && 'animate-spin')}
      />
      {refresh.isPending ? '刷新中…' : '刷新订阅'}
    </Button>
  )
}
