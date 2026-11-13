import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Monitor, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ACCOUNT_BROWSER_PATH as PATH,
  accountBrowserQueryOptions,
  type AccountBrowserStatus,
} from './account-browser-queries'
import { PaneSection } from './scheduler-controls'

const PHASE_LABELS: Record<string, string> = {
  checking: '正在检查版本',
  downloading: '正在下载组件',
  installing: '正在安装组件',
  verifying: '正在核对文件与版本',
  ready: '安装完成',
  failed: '安装未完成',
}

const UPDATE_ACTIONS: Record<
  AccountBrowserStatus['update_status'],
  { label: string; available: boolean }
> = {
  not_installed: { label: '安装浏览器', available: true },
  unchecked: { label: '请先检查更新', available: false },
  current: { label: '已是最新', available: false },
  update_available: { label: '更新浏览器', available: true },
  components_available: { label: '更新组件', available: true },
  newer_installed: { label: '无需更新', available: false },
  application_update_required: { label: '请先升级应用', available: false },
  check_failed: { label: '请重新检查', available: false },
  retry_required: { label: '重试安装', available: true },
}

function versionLabel(version: string | null, build: string | null) {
  return version && build ? `${version} · 构建 ${build}` : version
}

export function AccountBrowserSection() {
  const client = useQueryClient()
  const status = useQuery(accountBrowserQueryOptions())
  const data = status.data
  const updateStatus = (next: AccountBrowserStatus) => {
    client.setQueryData(accountBrowserQueryOptions().queryKey, next)
  }
  const check = useMutation({
    mutationFn: () =>
      api<AccountBrowserStatus>(`${PATH}/check`, { method: 'POST' }),
    onSuccess: (next) => {
      updateStatus(next)
      install.reset()
    },
  })
  const install = useMutation({
    mutationFn: () =>
      api<AccountBrowserStatus>(`${PATH}/install`, { method: 'POST' }),
    onSuccess: (next) => {
      updateStatus(next)
      check.reset()
    },
  })
  const installing = Boolean(data?.installing || install.isPending)
  const checkFailed =
    check.isError || status.isError || data?.update_status === 'check_failed'
  const updateStatusName = checkFailed
    ? 'check_failed'
    : data?.update_status || 'unchecked'
  const action = UPDATE_ACTIONS[updateStatusName]
  const error =
    install.error?.message ||
    check.error?.message ||
    status.error?.message ||
    data?.last_error?.message
  const stateLabel = installing
    ? '安装中'
    : !data
      ? status.isError
        ? '读取失败'
        : '读取中'
      : data.update_status === 'retry_required'
        ? '安装未完成'
        : !data.installed_version
          ? '待安装'
          : data.browser_busy
            ? '使用中'
            : '已安装'
  const phaseLabel = PHASE_LABELS[data?.phase || ''] || '正在安装'

  return (
    <PaneSection
      icon={Monitor}
      title='账号浏览器'
      desc='ShardBrowser 用于 GPT 登录与 Platform 操作，同一时间打开一个窗口。'
      aside={<Badge variant='secondary'>{stateLabel}</Badge>}
    >
      {status.isPending ? (
        <div className='grid grid-cols-2 gap-4' aria-hidden='true'>
          <Skeleton className='h-10' />
          <Skeleton className='h-10' />
        </div>
      ) : data ? (
        <dl className='grid grid-cols-2 gap-x-6 gap-y-3 text-sm'>
          {[
            ['启动组件版本', data.launcher_version],
            [
              '已安装内核',
              versionLabel(data.installed_version, data.installed_build) ||
                '尚未安装',
            ],
            ['运行中版本', data.running_version || '未运行'],
            [
              '官方最新版本',
              checkFailed
                ? '检查失败'
                : versionLabel(data.latest_version, data.latest_build) ||
                  '尚未检查',
            ],
          ].map(([label, value]) => (
            <div key={label} className='min-w-0 space-y-1'>
              <dt className='text-xs text-muted-foreground'>{label}</dt>
              <dd className='break-words tabular-nums'>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className='space-y-2'>
        <div className='flex flex-wrap gap-2'>
          <Button
            type='button'
            variant='outline'
            disabled={installing}
            loading={check.isPending}
            onClick={() => check.mutate()}
          >
            <RefreshCw aria-hidden />
            检查更新
          </Button>
          <Button
            type='button'
            disabled={
              !data ||
              !action.available ||
              data.browser_busy ||
              installing ||
              check.isPending
            }
            loading={installing}
            onClick={() => install.mutate()}
          >
            <Download aria-hidden />
            {action.label}
          </Button>
        </div>
        <p className='text-xs leading-5 text-muted-foreground'>
          内核仅在此处手动更新，应用升级保留已安装版本与网页登录数据。
        </p>
        {data?.browser_busy ? (
          <p className='text-xs leading-5 text-muted-foreground'>
            请先关闭正在使用的账号浏览器，再安装或更新。
          </p>
        ) : updateStatusName === 'application_update_required' ? (
          <p className='text-xs leading-5 text-muted-foreground'>
            官方新版需要更新的启动组件，请先升级应用。
          </p>
        ) : updateStatusName === 'components_available' ? (
          <p className='text-xs leading-5 text-muted-foreground'>
            内核版本未变，官方浏览器组件有更新。
          </p>
        ) : null}
        {data?.checked_at ? (
          <p className='text-xs text-muted-foreground'>
            最近检查：{new Date(data.checked_at).toLocaleString()}
          </p>
        ) : null}
      </div>

      {installing ? (
        <div className='space-y-2 text-sm'>
          <p>
            {phaseLabel}
            {data?.progress != null ? ` · ${data.progress}%` : ''}
          </p>
          <progress
            className='h-2 w-full accent-primary'
            aria-label={phaseLabel}
            value={data?.progress ?? undefined}
            max={100}
          />
          <p className='text-xs text-muted-foreground'>
            安装期间暂不打开新窗口。关闭此页面不会取消安装。
          </p>
        </div>
      ) : data?.phase === 'ready' && data.installed_version && !error ? (
        <p className='text-sm' role='status'>
          安装完成。
        </p>
      ) : null}
      {error ? (
        <Alert variant='destructive'>
          <AlertTitle>浏览器操作未完成</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </PaneSection>
  )
}
