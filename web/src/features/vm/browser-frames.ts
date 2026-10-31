export type BrowserQuality = 'smooth' | 'native'

export type BrowserFrameMetadata = {
  type: 'frame'
  seq: number
  mime: 'image/jpeg'
  width: number
  height: number
  imageWidth: number
  imageHeight: number
  quality: BrowserQuality
}

export type DisplayedBrowserFrame = BrowserFrameMetadata & { url: string }

/** Decode one frame at a time and keep only the newest waiting image. */
export class LatestBrowserFrames {
  private metadata: BrowserFrameMetadata | null = null
  private pending: {
    metadata: BrowserFrameMetadata
    image: Blob
    revision: number
  } | null = null
  private revision = 0
  private decoding = false
  private closed = false
  private displayedUrl: string | null = null

  constructor(
    private readonly decode: (image: Blob) => Promise<string>,
    private readonly display: (frame: DisplayedBrowserFrame) => void,
    private readonly release: (url: string) => void,
    private readonly failed: () => void = () => {}
  ) {}

  describe(metadata: BrowserFrameMetadata) {
    this.metadata = metadata
  }

  receive(image: Blob) {
    if (this.closed || !this.metadata) return
    this.pending = { metadata: this.metadata, image, revision: ++this.revision }
    this.metadata = null
    void this.drain()
  }

  close() {
    this.closed = true
    this.pending = null
    this.metadata = null
    this.revision++
    if (this.displayedUrl) this.release(this.displayedUrl)
    this.displayedUrl = null
  }

  private async drain() {
    if (this.decoding) return
    this.decoding = true
    try {
      while (this.pending && !this.closed) {
        const frame = this.pending
        this.pending = null
        let url: string
        try {
          url = await this.decode(frame.image)
        } catch {
          if (!this.closed && frame.revision === this.revision) this.failed()
          continue
        }
        if (this.closed || frame.revision !== this.revision) {
          this.release(url)
          continue
        }
        const previousUrl = this.displayedUrl
        this.displayedUrl = url
        this.display({ ...frame.metadata, url })
        if (previousUrl) this.release(previousUrl)
      }
    } finally {
      this.decoding = false
    }
  }
}

export async function decodeBrowserFrame(image: Blob): Promise<string> {
  const url = URL.createObjectURL(image)
  const picture = new Image()
  picture.src = url
  try {
    await picture.decode()
    return url
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

export function browserSocketUrl(
  path: string,
  ticket: string,
  base: string
): URL {
  const url = new URL(path, base)
  if (!url.searchParams.has('ticket')) url.searchParams.set('ticket', ticket)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  return url
}

/** A dropped WebSocket alone must not restart an authenticated browser. */
export async function browserNeedsOpening(
  vmId: string,
  openedVmId: string,
  readState: () => Promise<{ active: boolean }>
): Promise<boolean> {
  if (vmId !== openedVmId) return true
  return !(await readState()).active
}

export function browserStatusMessage(
  status: string,
  purpose: 'oauth' | 'platform'
): string {
  const labels: Record<string, string> = {
    queued: '正在排队，等待当前浏览器任务结束…',
    starting: '正在启动槽位浏览器…',
    opening: '正在打开官方网页…',
    oauth_complete:
      'OpenAI 授权成功，凭据已保存。可以继续进入 Platform，或关闭窗口。',
    needs_login: '请在此窗口完成官方登录或验证码，再点“登录完成，继续配置”。',
    configuring: '正在配置账号 API，请保留此窗口…',
    api_ready: '账号 API 配置完成，凭据已保存。',
    closed: '浏览器已关闭，可以重新连接。',
  }
  return (
    labels[status] ||
    (purpose === 'oauth'
      ? '请在此窗口完成 OpenAI 登录和授权，完成后会自动保存凭据。'
      : '请在此窗口完成官方登录或验证码，再点“登录完成，继续配置”。')
  )
}
