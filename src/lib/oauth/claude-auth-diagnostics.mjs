const AUTH_PATHS = new Set(['/api/auth/verify_magic_link', '/api/auth/send_magic_link', '/api/auth/verify_google'])

function endpointOf(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  return url.origin === 'https://claude.ai' && AUTH_PATHS.has(url.pathname) ? url.pathname : null
}

function identifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null
}

/** Passive, per-login diagnostics. Credentials and free-form provider text never leave this listener. */
export function createClaudeAuthDiagnostics({ page, onDiagnostic, now = Date.now }) {
  let active = true
  let last = null
  let sequence = 0
  let latestRequestStart = -Infinity
  const observedResponses = new WeakSet()
  const failedRequests = new WeakSet()

  const publish = (diagnostic) => {
    last = diagnostic
    try {
      onDiagnostic(diagnostic)
    } catch {
      // A closing browser client must not affect the OAuth operation.
    }
  }

  const accept = (request, failed = false) => {
    if (!active || failedRequests.has(request) || (!failed && observedResponses.has(request))) return null
    const endpoint = endpointOf(request.url())
    if (!endpoint) return null
    const requestStart = request.timing?.().startTime ?? 0
    if (requestStart < latestRequestStart) return null
    latestRequestStart = requestStart
    ;(failed ? failedRequests : observedResponses).add(request)
    return { endpoint, sequence: ++sequence, timestamp: new Date(now()).toISOString() }
  }

  const response = async (result) => {
    const event = accept(result.request())
    if (!event) return
    const status = result.status()
    if (status >= 200 && status < 300) {
      publish(null)
      return
    }
    if (status < 400) return
    let body
    try {
      body = await result.json()
    } catch {
      // Error pages and a document closing before body delivery still have an HTTP status.
    }
    let requestId = identifier(body?.request_id)
    if (!requestId) {
      try {
        requestId = identifier(await result.headerValue('request-id'))
        if (!requestId) requestId = identifier(await result.headerValue('x-request-id'))
      } catch {
        // Headers can become unavailable while the browser closes.
      }
    }
    if (!active || event.sequence !== sequence) return
    publish({
      endpoint: event.endpoint,
      status,
      errorType: identifier(body?.error?.type),
      errorCode: identifier(body?.error?.details?.error_code),
      requestId,
      timestamp: event.timestamp,
      transportFailure: false,
    })
  }

  const requestfailed = (request) => {
    const event = accept(request, true)
    if (!event) return
    publish({
      endpoint: event.endpoint,
      status: null,
      errorType: null,
      errorCode: null,
      requestId: null,
      timestamp: event.timestamp,
      transportFailure: true,
    })
  }

  page.on('response', response)
  page.on('requestfailed', requestfailed)
  return {
    current: () => last,
    stop() {
      if (!active) return
      active = false
      sequence++
      page.off('response', response)
      page.off('requestfailed', requestfailed)
      publish(null)
    },
  }
}
