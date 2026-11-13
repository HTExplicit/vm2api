import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'

export type AccountBrowserStatus = {
  launcher_version: string
  installed_version: string | null
  installed_build: string | null
  running_version: string | null
  latest_version: string | null
  latest_build: string | null
  checked_at: string | null
  update_status:
    | 'not_installed'
    | 'unchecked'
    | 'current'
    | 'update_available'
    | 'components_available'
    | 'newer_installed'
    | 'application_update_required'
    | 'check_failed'
    | 'retry_required'
  installing: boolean
  phase: string
  progress: number | null
  last_error: { code: string; message: string } | null
  browser_busy: boolean
}

export const ACCOUNT_BROWSER_PATH = '/api/panel/account-browser'

export function accountBrowserQueryOptions() {
  return queryOptions({
    queryKey: ['account-browser'],
    queryFn: () => api<AccountBrowserStatus>(ACCOUNT_BROWSER_PATH),
    refetchInterval: (query) => (query.state.data?.installing ? 2000 : false),
  })
}
