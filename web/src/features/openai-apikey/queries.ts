import { queryOptions, type QueryClient } from '@tanstack/react-query'
import type { OpenaiApiKeyPayload } from '@/types/panel-openai-apikey'
import { api } from '@/lib/api'

export function openaiApiKeysQueryOptions(enabled = true) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  return queryOptions({
    queryKey: ['panel', 'openai-apikey', timezone] as const,
    queryFn: () =>
      api<OpenaiApiKeyPayload>(
        `/api/panel/openai-apikey?timezone=${encodeURIComponent(timezone)}`
      ),
    enabled,
    refetchInterval: 15_000,
    retry: false,
  })
}

export async function invalidateOpenaiApiKeys(qc: QueryClient) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['panel', 'openai-apikey'] }),
    qc.invalidateQueries({ queryKey: ['panel', 'vms'] }),
    qc.invalidateQueries({ queryKey: ['panel', 'vm'] }),
    qc.invalidateQueries({ queryKey: ['panel', 'dashboard'] }),
    qc.invalidateQueries({ queryKey: ['panel', 'api-endpoints'] }),
  ])
}
