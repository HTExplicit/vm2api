import fetch from 'node-fetch'
import { createProxyAgent } from '../vm/proxy-agent.mjs'
import { BILLING_CREDIT_GRANTS_URL, parsePlatformCreditSummary } from './platform-adapter.mjs'
import { createBillingCookieJar } from './billing-cookies.mjs'

const BILLING_ERROR = Symbol('billingError')

function problem(code, message, status) {
  return Object.assign(new Error(message), { code, ...(status ? { status } : {}), [BILLING_ERROR]: true })
}

/** Refresh the browser's Billing session over its bound proxy without opening a browser. */
export async function fetchBillingBalance({
  session,
  storageState,
  proxyUrl,
  organizationId,
  signal,
  fetchImpl = fetch,
  createAgent = createProxyAgent,
  timeoutMs = 30_000,
} = {}) {
  if (!session?.headers?.authorization || !session.headers['user-agent'])
    throw problem('platform_login_required', '尚未保存 Billing 会话，请恢复账号登录')
  if (session.organization_id !== organizationId)
    throw problem('platform_organization_unavailable', 'Billing 会话与当前绑定组织不一致')
  if (!proxyUrl) throw problem('proxy_required', '账号未绑定可用代理')

  const checkCancelled = () => {
    if (signal?.aborted) throw problem('api_task_cancelled', '余额刷新已取消')
  }
  const deadline = AbortSignal.timeout(timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  let agent
  let response
  const abort = () => agent?.destroy()
  try {
    checkCancelled()
    agent = createAgent(String(proxyUrl).replace(/^socks5:/i, 'socks5h:'))
    // Bound SOCKS' internal handshake timer too; HTTP CONNECT accepts cancellation.
    agent.timeout = timeoutMs
    if (agent.connectOpts) agent.connectOpts.signal = requestSignal
    requestSignal.addEventListener('abort', abort, { once: true })
    const jar = await createBillingCookieJar(storageState?.cookies)
    const headers = { ...session.headers, 'openai-organization': organizationId }
    delete headers.cookie
    const cookie = await jar.header(BILLING_CREDIT_GRANTS_URL)
    if (cookie) headers.cookie = cookie
    checkCancelled()
    response = await fetchImpl(BILLING_CREDIT_GRANTS_URL, {
      method: 'GET',
      headers,
      agent,
      signal: requestSignal,
      redirect: 'manual',
    })
    checkCancelled()
    const status = response.status
    if (status === 401) throw problem('platform_login_required', 'Billing 会话已失效，请恢复账号登录', status)
    if (status !== 200) {
      const payload = await response.json().catch(() => null)
      requestSignal.throwIfAborted()
      if (['session_expired', 'invalid_session', 'token_expired'].includes(payload?.error?.code))
        throw problem('platform_login_required', 'Billing 会话已失效，请恢复账号登录', status)
      throw problem('billing_http_error', `官方 Billing 请求失败（HTTP ${status}）`, status)
    }
    const body = await response.text()
    let summary
    try {
      summary = parsePlatformCreditSummary(body)
    } catch {
      throw problem('platform_balance_missing', '官方 Billing 返回了无效余额数据')
    }
    if (summary.balance == null) throw problem('platform_balance_missing', '官方 Billing 尚未返回可用余额')
    await jar.update(response.headers.raw()['set-cookie'] || [], BILLING_CREDIT_GRANTS_URL)
    checkCancelled()
    requestSignal.throwIfAborted()
    return { summary, cookies: jar.cookies() }
  } catch (error) {
    checkCancelled()
    if (deadline.aborted) throw problem('billing_timeout', '官方 Billing 请求超时')
    if (error[BILLING_ERROR]) throw error
    // Proxy and fetch exceptions may contain credentials. Return only a fixed public error.
    throw problem('billing_network_error', '无法通过账号绑定代理连接官方 Billing')
  } finally {
    requestSignal.removeEventListener('abort', abort)
    response?.body?.destroy()
    agent?.destroy()
  }
}
