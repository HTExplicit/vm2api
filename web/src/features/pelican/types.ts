export const PELICAN_PROMPT =
  '创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画，你不需要任何测试'

export type PelicanAccount = {
  vmId: string
  vmName: string
  email?: string
}

export type PelicanResult = {
  ok: boolean
  vm_id: string
  model: string
  reasoning_effort: string
  text: string | null
  duration_ms: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    [key: string]: unknown
  } | null
  stop_reason?: string | null
  error?: { code?: string; message?: string } | null
}

export type PelicanItem = PelicanAccount & {
  id: string
  status:
    'queued' | 'running' | 'success' | 'error' | 'cancelled' | 'interrupted'
  result?: PelicanResult
}

export type PelicanBatch = {
  id: string
  createdAt: number
  model: string
  reasoningEffort: string
  results: PelicanItem[]
}
