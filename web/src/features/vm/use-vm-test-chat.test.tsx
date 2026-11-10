import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useVmTestChat } from './use-vm-test-chat'

const controls = vi.hoisted(() => ({
  role: 'user',
  api: vi.fn(),
  queries: [] as { queryKey: readonly unknown[]; enabled?: boolean }[],
}))

vi.mock('@/lib/api', () => ({ api: controls.api, isApiError: () => false }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@tanstack/react-query', () => ({
  queryOptions: (options: unknown) => options,
  useQuery: (options: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    controls.queries.push(options)
    const kind = options.queryKey[1]
    return {
      data:
        kind === 'me'
          ? { role: controls.role }
          : kind === 'test-models' && options.enabled
            ? { items: [{ id: 'available-model', name: 'Available' }] }
            : undefined,
      isPending: false,
      isFetching: false,
    }
  },
  useQueryClient: () => ({ setQueryData: vi.fn() }),
  useMutation: (options: { mutationFn: () => unknown }) => ({
    isPending: false,
    mutate: () => options.mutationFn(),
  }),
}))

function render() {
  let result!: ReturnType<typeof useVmTestChat>
  function Probe() {
    result = useVmTestChat({
      id: 'tenant slot',
      family: 'codex',
      platform: 'openai',
    })
    return null
  }
  renderToStaticMarkup(<Probe />)
  return result
}

beforeEach(() => {
  controls.role = 'user'
  controls.queries = []
  controls.api.mockReset()
})

describe('test model read and live refresh permissions', () => {
  it('loads tenant models for the selected slot without allowing live refresh', () => {
    const result = render()
    expect(controls.queries).toContainEqual(
      expect.objectContaining({
        queryKey: ['panel', 'test-models', 'tenant slot'],
        enabled: true,
      })
    )
    expect(result.models).toEqual([
      { id: 'available-model', name: 'Available' },
    ])
    expect(result.canRefreshModels).toBe(false)
    result.onRefreshModels()
    expect(controls.api).not.toHaveBeenCalled()
  })

  it('retains explicit live refresh for admins', () => {
    controls.role = 'admin'
    const result = render()
    expect(result.canRefreshModels).toBe(true)
    result.onRefreshModels()
    expect(controls.api).toHaveBeenCalledWith(
      '/api/panel/test-models?vm_id=tenant%20slot&refresh=1'
    )
  })
})
