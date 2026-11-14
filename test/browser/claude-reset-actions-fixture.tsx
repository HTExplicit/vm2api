import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { Vm } from '../../web/src/types/panel-vm'
import { Toaster } from '../../web/src/components/ui/sonner'
import { ClaudeResetActions } from '../../web/src/features/vm/claude-reset-actions'
import { vmQueryOptions } from '../../web/src/features/vm/queries'
import '../../web/src/styles/index.css'

declare global {
  interface Window {
    resetFixtureVm: Vm
  }
}

const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
  },
})
client.setQueryData(['panel', 'me'], { role: 'admin' })

function Fixture() {
  const { data } = useQuery({
    ...vmQueryOptions(window.resetFixtureVm.id),
    initialData: { vm: window.resetFixtureVm },
  })
  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-xl">Offline Claude reset cards</h1>
      <ClaudeResetActions
        vm={data.vm}
        now={Date.parse('2026-11-14T00:00:00Z')}
        usage={{ fiveHour: 75, sevenDay: 99, fable: 30, sevenDayGate: 95 }}
      />
      <Toaster />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <Fixture />
  </QueryClientProvider>,
)
