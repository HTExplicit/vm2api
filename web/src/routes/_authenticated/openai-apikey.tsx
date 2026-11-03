import { createFileRoute } from '@tanstack/react-router'
import { OpenaiApiKeyPage } from '@/features/openai-apikey'

export const Route = createFileRoute('/_authenticated/openai-apikey')({
  validateSearch: (search: Record<string, unknown>): { vm_id?: string } => ({
    vm_id: typeof search.vm_id === 'string' ? search.vm_id : undefined,
  }),
  component: OpenaiApiKeyRoute,
})

function OpenaiApiKeyRoute() {
  const { vm_id } = Route.useSearch()
  return <OpenaiApiKeyPage initialVmId={vm_id} />
}
