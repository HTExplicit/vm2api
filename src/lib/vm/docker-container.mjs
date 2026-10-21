/** Shared helpers for docker slot containers on the control plane / node host. */

export function isMissingContainerMessage(message) {
  return /no such container/i.test(String(message || ''))
}

export function telemetryContainerSkip(container, detail) {
  return {
    ok: true,
    skipped: true,
    action: 'skipped',
    reason: 'container_unavailable',
    container: String(container || ''),
    ...(detail ? { detail: String(detail).slice(0, 300) } : {}),
  }
}

export function logTelemetryContainerSkip(scope, vmId, container, detail) {
  const suffix = detail ? `: ${detail}` : ''
  console.warn(`[${scope}] Go slot service refresh skipped ${vmId}: no container ${container} on this host${suffix}`)
}
