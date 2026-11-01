import { request } from 'playwright-core'
import { createBoundProxyRelay } from './platform-browser.mjs'
import { BILLING_CREDIT_GRANTS_URL, parsePlatformCreditSummary } from './platform-adapter.mjs'

const BILLING_ERROR = Symbol('billingError')

function problem(code, message, status) {
  return Object.assign(new Error(message), { code, ...(status ? { status } : {}), [BILLING_ERROR]: true })
}

/** A disposable HTTP session shares the slot's cookies without launching a browser. */
export async function fetchBillingBalance({
  session,
  storageState,
  proxyUrl,
  organizationId,
  signal,
  requestImpl = request,
  createRelay = createBoundProxyRelay,
} = {}) {
  if (!session?.headers?.authorization || !session.headers['user-agent'])
    throw problem('platform_login_required', '尚未保存 Billing 会话，请恢复账号登录')
  if (session.organization_id !== organizationId)
    throw problem('platform_organization_unavailable', 'Billing 会话与当前绑定组织不一致')
  if (!proxyUrl) throw problem('proxy_required', '账号未绑定可用代理')

  let relay
  let context
  let response
  const aborted = () => void context?.dispose().catch(() => {})
  const checkCancelled = () => {
    if (signal?.aborted) throw problem('api_task_cancelled', '余额刷新已取消')
  }
  try {
    checkCancelled()
    relay = await createRelay(proxyUrl)
    checkCancelled()
    context = await requestImpl.newContext({
      proxy: { server: relay.url },
      storageState: { cookies: storageState?.cookies || [], origins: [] },
      extraHTTPHeaders: { ...session.headers, 'openai-organization': organizationId },
      userAgent: session.headers['user-agent'],
      timeout: 30_000,
    })
    signal?.addEventListener('abort', aborted, { once: true })
    checkCancelled()
    response = await context.get(BILLING_CREDIT_GRANTS_URL, {
      timeout: 30_000,
      maxRedirects: 0,
      maxRetries: 0,
    })
    checkCancelled()
    const status = response.status()
    if (status === 401) throw problem('platform_login_required', 'Billing 会话已失效，请恢复账号登录', status)
    if (status !== 200) {
      const payload = await response.json().catch(() => null)
      if (['session_expired', 'invalid_session', 'token_expired'].includes(payload?.error?.code))
        throw problem('platform_login_required', 'Billing 会话已失效，请恢复账号登录', status)
      throw problem('billing_http_error', `官方 Billing 请求失败（HTTP ${status}）`, status)
    }
    let summary
    try {
      summary = parsePlatformCreditSummary(await response.text())
    } catch {
      throw problem('platform_balance_missing', '官方 Billing 返回了无效余额数据')
    }
    if (summary.balance == null) throw problem('platform_balance_missing', '官方 Billing 尚未返回可用余额')
    const state = await context.storageState()
    checkCancelled()
    return { summary, cookies: state.cookies }
  } catch (error) {
    checkCancelled()
    if (error[BILLING_ERROR]) throw error
    // Playwright network call logs can contain Authorization. Never retain them.
    if (error.name === 'TimeoutError') throw problem('billing_timeout', '官方 Billing 请求超时')
    throw problem('billing_network_error', '无法通过账号绑定代理连接官方 Billing')
  } finally {
    signal?.removeEventListener('abort', aborted)
    await response?.dispose().catch(() => {})
    await context?.dispose().catch(() => {})
    await relay?.close().catch(() => {})
  }
}
