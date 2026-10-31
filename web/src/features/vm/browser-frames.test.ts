import { describe, expect, it } from 'vitest'
import {
  browserNeedsOpening,
  browserSocketUrl,
  browserStatusMessage,
  LatestBrowserFrames,
  type BrowserFrameMetadata,
} from './browser-frames'
import { browserInputPoint } from './browser-input'

function metadata(seq: number): BrowserFrameMetadata {
  return {
    type: 'frame',
    seq,
    mime: 'image/jpeg',
    width: 1920,
    height: 1080,
    imageWidth: 1280,
    imageHeight: 720,
    quality: 'smooth',
  }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('latest browser frame transport', () => {
  it('discards a superseded decode and never decodes queued stale frames', async () => {
    const decoded: string[] = []
    const shown: number[] = []
    const released: string[] = []
    const resolve = new Map<string, (url: string) => void>()
    const frames = new LatestBrowserFrames(
      (image) => {
        const name = String(image.size)
        decoded.push(name)
        return new Promise((done) => resolve.set(name, done))
      },
      (frame) => shown.push(frame.seq),
      (url) => released.push(url)
    )
    for (const seq of [1, 2, 3]) {
      frames.describe(metadata(seq))
      frames.receive(new Blob(['x'.repeat(seq)]))
    }
    expect(decoded).toEqual(['1'])
    resolve.get('1')?.('frame-1')
    await flush()
    expect(decoded).toEqual(['1', '3'])
    expect(released).toEqual(['frame-1'])
    expect(shown).toEqual([])
    resolve.get('3')?.('frame-3')
    await flush()
    expect(shown).toEqual([3])
    frames.close()
    expect(released).toEqual(['frame-1', 'frame-3'])
  })

  it('releases decoded images after closing and stops pending work', async () => {
    let finish: ((url: string) => void) | undefined
    const shown: number[] = []
    const released: string[] = []
    const frames = new LatestBrowserFrames(
      () =>
        new Promise((done) => {
          finish = done
        }),
      (frame) => shown.push(frame.seq),
      (url) => released.push(url)
    )
    frames.describe(metadata(1))
    frames.receive(new Blob(['one']))
    frames.close()
    finish?.('closed-image')
    await flush()
    expect(shown).toEqual([])
    expect(released).toEqual(['closed-image'])
  })

  it('keeps the last good image when a newer decode fails', async () => {
    const shown: number[] = []
    let failures = 0
    const frames = new LatestBrowserFrames(
      async (image) => {
        if (image.size === 2) throw Error('bad image')
        return 'valid-image'
      },
      (frame) => shown.push(frame.seq),
      () => {},
      () => {
        failures++
      }
    )
    frames.describe(metadata(1))
    frames.receive(new Blob(['1']))
    await flush()
    frames.describe(metadata(2))
    frames.receive(new Blob(['22']))
    await flush()
    expect(shown).toEqual([1])
    expect(failures).toBe(1)
    frames.close()
  })

  it('uses logical viewport coordinates when the transfer image is reduced', () => {
    expect(
      browserInputPoint(
        350,
        200,
        { left: 30, top: 20, width: 640, height: 360 },
        metadata(1)
      )
    ).toEqual({ x: 960, y: 540 })
  })

  it('builds same-origin and explicit-base ticket WebSocket URLs', () => {
    const sameOrigin = browserSocketUrl(
      '/api/panel/vms/a/browser',
      'one-time',
      'https://panel.example/cc'
    )
    expect(sameOrigin.protocol).toBe('wss:')
    expect(sameOrigin.pathname).toBe('/api/panel/vms/a/browser')
    expect(sameOrigin.searchParams.get('ticket')).toBe('one-time')
    const supplied = browserSocketUrl(
      '/api/panel/vms/a/browser?ticket=issued',
      'unused',
      'http://127.0.0.1:8787'
    )
    expect(supplied.protocol).toBe('ws:')
    expect(supplied.searchParams.get('ticket')).toBe('issued')
  })

  it('reconnects live browsers without restarting and reopens terminated sessions', async () => {
    let queries = 0
    const live = async () => {
      queries++
      return { active: true }
    }
    expect(await browserNeedsOpening('slot-a', '', live)).toBe(true)
    expect(queries).toBe(0)
    expect(await browserNeedsOpening('slot-a', 'slot-a', live)).toBe(false)
    expect(queries).toBe(1)
    expect(
      await browserNeedsOpening('slot-a', 'slot-a', async () => ({
        active: false,
      }))
    ).toBe(true)
    expect(await browserNeedsOpening('slot-b', 'slot-a', live)).toBe(true)
    expect(queries).toBe(1)
  })

  it('distinguishes ready browser status from completed OAuth and API setup', () => {
    expect(browserStatusMessage('queued', 'oauth')).toContain('排队')
    expect(browserStatusMessage('ready', 'oauth')).toContain('自动保存')
    expect(browserStatusMessage('oauth_complete', 'oauth')).toContain(
      '继续进入 Platform'
    )
    expect(browserStatusMessage('api_ready', 'platform')).toContain(
      'API 配置完成'
    )
  })
})
