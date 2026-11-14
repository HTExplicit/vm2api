import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import type { VmProxySnap } from '../../web/src/types/panel-vm'
import { Toaster } from '../../web/src/components/ui/sonner'
import { Button } from '../../web/src/components/ui/button'
import { ProxyImportPanel } from '../../web/src/features/proxies/proxy-import-panel'
import { ProxyEditDialog } from '../../web/src/features/proxies/proxy-edit-dialog'
import { WrapSamplePage } from '../../web/src/features/wrap'
import '../../web/src/styles/index.css'

const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
  },
})
const proxy: VmProxySnap = {
  id: 'offline-proxy',
  host: 'proxy.example.test',
  port: 8080,
  label: '离线测试代理',
  scheme: 'socks5',
  has_auth: true,
  bound_vm_ids: [],
}

function ProxyFixture() {
  const [editing, setEditing] = useState(false)
  return (
    <main className="mx-auto max-w-xl space-y-6 p-6">
      <h1 className="text-xl">Offline proxy protocol controls</h1>
      <ProxyImportPanel hasLocal />
      <Button onClick={() => setEditing(true)}>编辑测试代理</Button>
      <ProxyEditDialog proxy={editing ? proxy : null} onOpenChange={setEditing} />
    </main>
  )
}

const route = createRootRoute({ component: WrapSamplePage })
const router = createRouter({
  routeTree: route,
  history: createMemoryHistory({ initialEntries: ['/'] }),
})

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    {new URL(location.href).searchParams.get('view') === 'kvm' ? <RouterProvider router={router} /> : <ProxyFixture />}
    <Toaster />
  </QueryClientProvider>,
)
