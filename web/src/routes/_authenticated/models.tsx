import { createFileRoute } from '@tanstack/react-router'
import { ModelsPage } from '@/features/models'

export const Route = createFileRoute('/_authenticated/models')({
  validateSearch: (
    search: Record<string, unknown>
  ): {
    platform?: 'anthropic' | 'openai'
  } => ({
    platform:
      search.platform === 'openai' || search.platform === 'anthropic'
        ? search.platform
        : undefined,
  }),
  component: ModelsRoute,
})

function ModelsRoute() {
  const { platform } = Route.useSearch()
  return <ModelsPage initialPlatform={platform} />
}
