import { Cookie, CookieJar, cookieCompare } from 'tough-cookie'

const PLATFORM_SITE = 'https://openai.com'
const sameSiteNames = { strict: 'Strict', lax: 'Lax', none: 'None' }

function partitionOf(cookie) {
  const key = cookie.partitionKey
  if (!key && !cookie.partitionKeyOpaque) return ''
  const origin = typeof key === 'string' ? key : key?.sourceOrigin
  return JSON.stringify([origin, Boolean(key?.hasCrossSiteAncestor), Boolean(cookie.partitionKeyOpaque)])
}

const platformPartition = partitionOf({ partitionKey: { sourceOrigin: PLATFORM_SITE, hasCrossSiteAncestor: false } })
const identity = (cookie) =>
  JSON.stringify([cookie.name, cookie.domain.replace(/^\./, '').toLowerCase(), cookie.path, partitionOf(cookie)])
const active = (cookie) => cookie.expires == null || cookie.expires < 0 || cookie.expires > Date.now() / 1000

/** Billing has one known top-level site. Keep other browser partitions intact,
 * but never flatten them into this HTTP request's cookie namespace. */
export async function createBillingCookieJar(cookies = []) {
  const original = new Map(cookies.filter(active).map((cookie) => [identity(cookie), { ...cookie }]))
  const ordinary = new CookieJar()
  const partitioned = new CookieJar()
  for (const cookie of original.values()) {
    const partition = partitionOf(cookie)
    if (partition && partition !== platformPartition) continue
    const jar = partition ? partitioned : ordinary
    const domain = cookie.domain.replace(/^\./, '')
    await jar.setCookie(
      new Cookie({
        key: cookie.name,
        value: cookie.value,
        domain,
        hostOnly: !cookie.domain.startsWith('.'),
        path: cookie.path,
        expires: cookie.expires > 0 ? new Date(cookie.expires * 1000) : 'Infinity',
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite?.toLowerCase(),
      }),
      `https://${domain}${cookie.path}`,
    )
  }
  return {
    async header(url) {
      const opts = { sameSiteContext: 'strict' }
      const values = [...(await ordinary.getCookies(url, opts)), ...(await partitioned.getCookies(url, opts))]
      return values
        .sort(cookieCompare)
        .map((cookie) => cookie.cookieString())
        .join('; ')
    },
    async update(headers, url) {
      for (const header of headers) {
        const parsed = Cookie.parse(header)
        if (!parsed) continue
        const hasPartition = parsed.extensions?.some((value) => /^partitioned$/i.test(value)) === true
        if ((hasPartition || parsed.sameSite === 'none') && !parsed.secure) continue
        const cookie = await (hasPartition ? partitioned : ordinary).setCookie(parsed, url, { ignoreError: true })
        if (!cookie) continue
        const expires = cookie.expiryTime()
        const partitionKey = hasPartition ? { sourceOrigin: PLATFORM_SITE, hasCrossSiteAncestor: false } : undefined
        const browserCookie = {
          name: cookie.key,
          value: cookie.value,
          domain: `${cookie.hostOnly ? '' : '.'}${cookie.domain}`,
          path: cookie.path,
          ...(partitionKey ? { partitionKey } : {}),
        }
        const key = identity(browserCookie)
        if (expires <= Date.now()) {
          original.delete(key)
          continue
        }
        const previous = original.get(key)
        const priority = cookie.extensions
          ?.find((value) => /^priority=/i.test(value))
          ?.split('=')[1]
          ?.toLowerCase()
        original.set(key, {
          ...previous,
          ...browserCookie,
          expires: Number.isFinite(expires) ? expires / 1000 : -1,
          session: !Number.isFinite(expires),
          size: Buffer.byteLength(cookie.key + cookie.value),
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite: sameSiteNames[cookie.sameSite],
          priority: priority === 'high' ? 'High' : priority === 'low' ? 'Low' : 'Medium',
          sameParty: false,
          sourceScheme: new URL(url).protocol === 'https:' ? 'Secure' : 'NonSecure',
        })
      }
    },
    cookies() {
      return [...original.values()].filter(active)
    },
  }
}
