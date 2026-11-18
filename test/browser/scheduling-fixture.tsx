import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { Toaster } from '../../web/src/components/ui/sonner'
import { VmActionsContext } from '../../web/src/features/vm/vm-actions-context'
import { VmTable } from '../../web/src/features/vm/vm-list-table'
import { vmsListQueryOptions } from '../../web/src/features/vm/queries'
import '../../web/src/styles/index.css'

const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
})

function Fixture() {
  const rows = useQuery(vmsListQueryOptions())
  const [details, setDetails] = useState(0)
  const nothing = () => {}
  return (
    <main className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">列表调度控制</h1>
        <button onClick={() => rows.refetch()}>刷新离线数据</button>
      </div>
      <VmActionsContext.Provider
        value={{
          openDetail: () => setDetails((count) => count + 1),
          openTest: nothing,
          openStats: nothing,
          openReauth: nothing,
          openRecovery: nothing,
          refreshToken: nothing,
          recover: nothing,
          refreshingId: null,
          recoveringId: null,
        }}
      >
        <VmTable vms={rows.data?.items || []} />
      </VmActionsContext.Provider>
      <output aria-label="详情打开次数">{details}</output>
      <Toaster />
    </main>
  )
}

const route = createRootRoute({ component: Fixture })
const router = createRouter({
  routeTree: route,
  history: createMemoryHistory({ initialEntries: ['/'] }),
})

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
)
