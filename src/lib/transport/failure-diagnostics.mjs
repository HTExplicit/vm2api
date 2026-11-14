/** Per-hop observations. They identify where an error was seen, not who caused it. */
export function createFailureDiagnostics(kernelRequestId) {
  let phase = 'connect'
  let lastEventType = null
  let lastEventAt = null
  let usageState = 'missing'
  return {
    connected() {
      phase = 'headers'
    },
    headers() {
      phase = 'first_event'
    },
    observe(event, at = Date.now()) {
      lastEventType = event.type || null
      lastEventAt = at
      phase = 'stream'
      const usage = event.usage || event.message?.usage || event.response?.usage
      if (usage) usageState = 'partial'
      const terminal =
        ['response.completed', 'response.done', 'response.failed', 'response.incomplete', 'message_stop'].includes(
          event.type,
        ) ||
        (event.type === 'message_delta' && event.delta?.stop_reason)
      if (terminal) {
        phase = 'finalize'
        if (usage) usageState = 'final'
      }
    },
    snapshot(committed) {
      return {
        kernelRequestId,
        phase,
        lastEventType,
        lastEventAgoMs: lastEventAt == null ? null : Math.max(0, Date.now() - lastEventAt),
        responseCommitted: committed,
        usageState,
      }
    },
  }
}

export function parseFailureDiagnostics(value) {
  return value == null ? null : JSON.parse(value)
}
