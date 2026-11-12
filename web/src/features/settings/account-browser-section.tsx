import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Monitor, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ACCOUNT_BROWSER_PATH as PATH,
  accountBrowserQueryOptions,
  type AccountBrowserStatus,
} from './account-browser-queries'
import { PaneSection } from './scheduler-controls'

const PHASE_LABELS: Record<string, string> = {
  checking: '正在检查版本',
  downloading: '正在下载内核',
  verifying: '正在校验文件',
  extracting: '正在安装内核',
  testing: '正在验证浏览器',
  ready: '安装与验证完成',
  failed: '安装未完成',
}

export function AccountBrowserSection() {
  const client = useQueryClient()
  const status = useQuery(accountBrowserQueryOptions())
  const [key, setKey] = useState('')
  const [actionError, setActionError] = useState('')
  const data = status.data
  const updateStatus = (next: AccountBrowserStatus) => {
    client.setQueryData(accountBrowserQueryOptions().queryKey, next)
  }
  const onError = (error: Error) => setActionError(error.message)
  const onMutate = () => setActionError('')
  const save = useMutation({
    // Read the key from component state, never retain it in mutation variables.
    mutationFn: () =>
      api<AccountBrowserStatus>(`${PATH}/key`, {
        method: 'PUT',
        body: JSON.stringify({ key: key.trim() }),
      }),
    onMutate,
    onError,
    onSuccess: (next) => {
      setKey('')
      updateStatus(next)
    },
  })
  const clear = useMutation({
    mutationFn: () =>
      api<AccountBrowserStatus>(`${PATH}/key`, {
        method: 'PUT',
        body: JSON.stringify({ key: null }),
      }),
    onMutate,
    onError,
    onSuccess: (next) => {
      setKey('')
      updateStatus(next)
    },
  })
  const check = useMutation({
    mutationFn: () =>
      api<AccountBrowserStatus>(`${PATH}/check`, { method: 'POST' }),
    onMutate,
    onError,
    onSuccess: updateStatus,
  })
  const install = useMutation({
    mutationFn: () =>
      api<AccountBrowserStatus>(`${PATH}/install`, { method: 'POST' }),
    onMutate,
    onError,
    onSuccess: updateStatus,
  })
  const changingKey = save.isPending || clear.isPending
  const installing = data?.installing || install.isPending
  const error =
    actionError || status.error?.message || data?.last_error?.message
  const stateLabel = installing
    ? '安装中'
    : !data
      ? status.isError
        ? '读取失败'
        : '读取中'
      : !data.key_set
        ? '待配置'
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
      desc='CloakBrowser 用于 GPT 登录与 Platform 操作，同一时间打开一个窗口。'
      aside={<Badge variant='secondary'>{stateLabel}</Badge>}
    >
      {status.isPending ? (
        <div className='grid grid-cols-2 gap-4' aria-label='正在读取浏览器状态'>
          <Skeleton className='h-10' />
          <Skeleton className='h-10' />
        </div>
      ) : data ? (
        <dl className='grid grid-cols-2 gap-x-6 gap-y-3 text-sm'>
          {[
            ['启动器版本', data.launcher_version],
            ['已安装内核', data.installed_version || '尚未安装'],
            ['运行中版本', data.running_version || '未运行'],
            ['最新稳定版', data.latest_version || '尚未检查'],
          ].map(([label, value]) => (
            <div key={label} className='min-w-0 space-y-1'>
              <dt className='text-xs text-muted-foreground'>{label}</dt>
              <dd className='break-words tabular-nums'>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className='space-y-2'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <Label htmlFor='account-browser-key'>CloakBrowser 授权 key</Label>
          <span className='text-xs text-muted-foreground' role='status'>
            {data ? (data.key_set ? '已配置，保存后不回显' : '尚未配置') : ''}
          </span>
        </div>
        <div className='flex flex-wrap gap-2'>
          <Input
            id='account-browser-key'
            type='password'
            autoComplete='new-password'
            spellCheck={false}
            className='min-w-0 basis-full sm:flex-1 sm:basis-48'
            value={key}
            disabled={!data || changingKey || installing || data.browser_busy}
            placeholder={data?.key_set ? '输入新 key 以替换' : '输入免费 key'}
            onChange={(event) => {
              setKey(event.target.value)
              setActionError('')
            }}
          />
          <Button
            type='button'
            variant='outline'
            disabled={
              !data ||
              !key.trim() ||
              changingKey ||
              installing ||
              data.browser_busy
            }
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            保存 key
          </Button>
          {data?.key_set ? (
            <Button
              type='button'
              variant='ghost'
              disabled={changingKey || installing || data.browser_busy}
              loading={clear.isPending}
              onClick={() => clear.mutate()}
            >
              清除 key
            </Button>
          ) : null}
        </div>
        <p className='text-xs leading-5 text-muted-foreground'>
          保存 key
          后，点击安装浏览器。内核仅在此处手动更新，应用升级保留已安装版本与网页登录数据。
        </p>
      </div>

      <div className='space-y-2'>
        <div className='flex flex-wrap gap-2'>
          <Button
            type='button'
            variant='outline'
            disabled={installing || changingKey}
            loading={check.isPending}
            onClick={() => check.mutate()}
          >
            <RefreshCw aria-hidden />
            检查更新
          </Button>
          <Button
            type='button'
            disabled={
              !data?.key_set ||
              data.browser_busy ||
              installing ||
              changingKey ||
              check.isPending
            }
            loading={installing}
            aria-label={data?.installed_version ? '更新浏览器' : '安装浏览器'}
            onClick={() => install.mutate()}
          >
            <Download aria-hidden />
            {data?.installed_version ? '更新浏览器' : '安装浏览器'}
          </Button>
        </div>
        {data?.browser_busy ? (
          <p className='text-xs leading-5 text-muted-foreground'>
            请先关闭正在使用的账号浏览器，再更新内核或修改 key。
          </p>
        ) : !data?.key_set && data ? (
          <p className='text-xs leading-5 text-muted-foreground'>
            填写并保存 key 后才能安装浏览器。
          </p>
        ) : null}
        {data?.checked_at ? (
          <p className='text-xs text-muted-foreground'>
            最近检查：{new Date(data.checked_at).toLocaleString()}
          </p>
        ) : null}
      </div>

      {installing ? (
        <div className='space-y-2 text-sm' role='status' aria-live='polite'>
          <p>
            {phaseLabel}
            {data?.progress != null ? ` · ${data.progress}%` : ''}
          </p>
          {data?.progress != null ? (
            <Progress
              aria-label={phaseLabel}
              aria-valuenow={data.progress}
              value={data.progress}
              max={100}
            />
          ) : null}
          <p className='text-xs text-muted-foreground'>
            安装期间暂不打开新窗口。关闭此页面不会取消安装。
          </p>
        </div>
      ) : data?.phase === 'ready' &&
        data.key_set &&
        data.installed_version &&
        !error ? (
        <p className='text-sm' role='status'>
          浏览器已就绪。
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
