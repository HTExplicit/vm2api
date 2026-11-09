/** Runs inside the opaque sandbox; it never reads or changes the panel. */
function installPreviewFit() {
  const body = document.body
  const originalTransform = body.style.getPropertyValue('transform')
  const originalPriority = body.style.getPropertyPriority('transform')
  const style = document.createElement('style')
  style.textContent =
    'html{overflow:hidden!important;scrollbar-gutter:auto!important}body{overflow:visible!important;transition:none!important}'
  document.head.append(style)

  let frame = 0
  const observed = new Set<Element>()
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure)
  }
  const resize = new ResizeObserver(schedule)

  function measure() {
    frame = 0
    // Measuring the authored layout, not the previous fit, keeps vh/vw stable.
    if (originalTransform)
      body.style.setProperty('transform', originalTransform, originalPriority)
    else body.style.removeProperty('transform')
    const baseTransform = getComputedStyle(body).transform
    const elements = [body, ...body.querySelectorAll('*')].filter(
      (element) =>
        element instanceof HTMLElement ||
        (element instanceof SVGSVGElement && !element.ownerSVGElement)
    )
    const current = new Set(elements)
    for (const element of observed) {
      if (!current.has(element)) {
        resize.unobserve(element)
        observed.delete(element)
      }
    }
    for (const element of elements) {
      if (!observed.has(element)) {
        resize.observe(element)
        observed.add(element)
      }
      if (!(element instanceof HTMLElement) || element === body) continue
      const css = getComputedStyle(element)
      if (
        /(auto|scroll|hidden|clip)/.test(`${css.overflowX} ${css.overflowY}`) &&
        (element.scrollWidth > element.clientWidth + 1 ||
          element.scrollHeight > element.clientHeight + 1)
      )
        element.style.setProperty('overflow', 'visible', 'important')
    }

    let left = 0
    let top = 0
    let right = 960
    let bottom = 600
    const before = body.getBoundingClientRect()
    for (const element of elements) {
      const css = getComputedStyle(element)
      if (css.display === 'none' || css.visibility === 'hidden') continue
      const rect = element.getBoundingClientRect()
      if (!rect.width && !rect.height) continue
      left = Math.min(left, rect.left)
      top = Math.min(top, rect.top)
      right = Math.max(right, rect.right)
      bottom = Math.max(bottom, rect.bottom)
      if (element instanceof HTMLElement) {
        // Include overflowing text as well as descendant element rectangles.
        const sx = element.offsetWidth ? rect.width / element.offsetWidth : 1
        const sy = element.offsetHeight ? rect.height / element.offsetHeight : 1
        right = Math.max(right, rect.left + element.scrollWidth * sx)
        bottom = Math.max(bottom, rect.top + element.scrollHeight * sy)
      }
    }

    const width = right - left
    const height = bottom - top
    const scale = Math.min(1, 960 / width, 600 / height)
    const authored = baseTransform === 'none' ? '' : baseTransform
    body.style.setProperty(
      'transform',
      `scale(${scale}) ${authored}`,
      'important'
    )
    const scaled = body.getBoundingClientRect()
    const x =
      (960 - width * scale) / 2 -
      (left * scale + scaled.left - before.left * scale)
    const y =
      (600 - height * scale) / 2 -
      (top * scale + scaled.top - before.top * scale)
    body.style.setProperty(
      'transform',
      `translate(${x}px,${y}px) scale(${scale}) ${authored}`,
      'important'
    )
    body.dataset.pelicanFit = 'ready'
    body.dataset.pelicanFitScale = String(scale)
    body.dataset.pelicanContentWidth = String(width)
    body.dataset.pelicanContentHeight = String(height)
  }

  // Transform-only animation changes never enqueue another measurement.
  new MutationObserver(schedule).observe(body, {
    subtree: true,
    childList: true,
    characterData: true,
  })
  window.addEventListener('load', schedule, true)
  document.fonts.ready.then(schedule)
  document.fonts.addEventListener('loadingdone', schedule)
  requestAnimationFrame(schedule)
}

/** Only the iframe gets the fit script; source, clipboard and download stay original. */
export function pelicanPreviewDocument(html: string): string {
  const script = `<script data-pelican-preview-fit>(${installPreviewFit.toString()})()</script>`
  const bodyEnd = html.toLowerCase().lastIndexOf('</body')
  return bodyEnd < 0
    ? html + script
    : html.slice(0, bodyEnd) + script + html.slice(bodyEnd)
}
