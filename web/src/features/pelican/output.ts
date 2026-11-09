/** Extract the submitted document without rewriting the model's drawing. */
export function extractPelicanHtml(text: string): string | null {
  const blocks = [...text.matchAll(/```(?:html|svg|xml)?\s*\n([\s\S]*?)```/gi)]
  const candidates = [...blocks.map((block) => block[1].trim()), text.trim()]
  for (const candidate of candidates) {
    const document = candidate.match(
      /(?:<!doctype\s+html[^>]*>\s*)?<html\b[\s\S]*?<\/html\s*>/i
    )
    if (document) return document[0]
    // A fenced HTML fragment is also a valid srcDoc (for example, style + SVG).
    if (candidate !== text.trim() && /<(?:body|style|div)\b/i.test(candidate)) {
      return candidate
    }
    const svg = candidate.match(/<svg\b[\s\S]*?<\/svg\s*>/i)
    if (svg) {
      return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;display:grid;place-items:center;min-height:100vh">${svg[0]}</body></html>`
    }
  }
  return null
}
