import { describe, expect, it } from 'vitest'
import { pelicanPreviewDocument } from './preview-fit'

describe('pelican preview document', () => {
  it('adds a self-contained fit script only to the preview copy', () => {
    const original =
      '<!doctype html><html><head><title>Pelican</title></head><body><svg viewBox="0 0 1600 900"></svg></body></html>'
    const preview = pelicanPreviewDocument(original)
    expect(preview).toContain('<svg viewBox="0 0 1600 900"></svg>')
    expect(preview).toMatch(
      /<script data-pelican-preview-fit>[\s\S]*<\/script><\/body>/
    )
    expect(original).not.toContain('data-pelican-preview-fit')
    const runtime = preview.match(
      /<script data-pelican-preview-fit>([\s\S]*?)<\/script>/
    )![1]
    expect(() => new Function(runtime)).not.toThrow()
  })
})
