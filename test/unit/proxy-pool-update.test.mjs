import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'

function makePool() {
  const pool = new ProxyPool({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kin-px-upd-')) })
  pool.stopScheduler()
  return pool
}
function seed(pool, line = 'socks5://alice:s3cret@1.2.3.4:1080') {
  pool.importLines(line)
  return pool.state.proxies[0]
}

test('update: 只改 port，账密保留；raw 明文密码被清除', () => {
  const pool = makePool()
  const p = seed(pool)
  assert.match(p.raw, /s3cret/, '前提：导入后 raw 含明文密码')
  const r = pool.update(p.id, { port: 1081 })
  assert.equal(r.ok, true)
  assert.equal(p.port, 1081)
  assert.equal(p.username, 'alice')
  assert.equal(p.password, 's3cret')
  assert.equal(p.raw, '1.2.3.4:1081')
  assert.doesNotMatch(p.raw, /s3cret/, 'raw 不应再含明文密码')
})

test('update: username 传空串清除账密（password 一并清）', () => {
  const pool = makePool()
  const p = seed(pool)
  assert.equal(pool.update(p.id, { username: '' }).ok, true)
  assert.equal(p.username, null)
  assert.equal(p.password, null)
})

test('update: 不传的字段保持不动', () => {
  const pool = makePool()
  const p = seed(pool)
  pool.update(p.id, { password: 'newpw' })
  assert.equal(p.host, '1.2.3.4')
  assert.equal(p.port, 1080)
  assert.equal(p.username, 'alice')
  assert.equal(p.password, 'newpw')
})

test('update: 只给密码不给用户名被拒，不静默存成「仍无账密」', () => {
  const pool = makePool()
  pool.importLines('9.9.9.9:1080')
  const p = pool.state.proxies[0]
  assert.equal(p.username, null, '前提：这条本来没有账密')
  assert.equal(pool.update(p.id, { password: 'onlypw' }).error, 'password_without_username')
  assert.equal(p.password, null, '被拒后不留半套账密')
  // 清了账密还想在同一次请求里设密码，同样是无效组合
  assert.equal(pool.update(p.id, { username: '', password: 'x' }).error, 'password_without_username')
})

test('update: 只换用户名时沿用原密码（不传的键就是不动）', () => {
  const pool = makePool()
  const p = seed(pool)
  assert.equal(pool.update(p.id, { username: 'bob' }).ok, true)
  assert.equal(p.username, 'bob')
  assert.equal(p.password, 's3cret', 'password 没传，按语义保持原值')
})

test('update: 非法值与空 patch 被拒，且不改动原记录', () => {
  const pool = makePool()
  const p = seed(pool)
  assert.equal(pool.update(p.id, { port: 99999 }).error, 'invalid_proxy')
  assert.equal(pool.update(p.id, { host: '' }).error, 'invalid_proxy')
  assert.equal(pool.update(p.id, {}).error, 'no_editable_fields')
  assert.equal(pool.update('nope', { port: 1080 }).error, 'proxy_not_found')
  assert.equal(p.port, 1080, '被拒后原值不变')
})

test('update: 响应里的 publicProxy 不含账密', () => {
  const pool = makePool()
  const p = seed(pool)
  const r = pool.update(p.id, { port: 1081 })
  const s = JSON.stringify(r.proxy)
  assert.doesNotMatch(s, /alice|s3cret|password|username/, 'update 响应不得泄漏账密')
  assert.equal(r.proxy.has_auth, true, '但要能看出有账密')
})

test('getProxyByIdWithAuth: 拼出完整 URI，特殊字符转义', () => {
  const pool = makePool()
  const p = seed(pool)
  assert.equal(pool.getProxyByIdWithAuth(p.id).url, 'socks5://alice:s3cret@1.2.3.4:1080')
  pool.update(p.id, { username: 'u@x', password: 'p:w/d' })
  assert.equal(pool.getProxyByIdWithAuth(p.id).url, 'socks5://u%40x:p%3Aw%2Fd@1.2.3.4:1080')
  pool.update(p.id, { username: '' })
  assert.equal(pool.getProxyByIdWithAuth(p.id).url, 'socks5://1.2.3.4:1080', '无账密时不带 @')
})

test('getProxyByIdWithAuth: 禁用/失效的代理仍可读回（getProxyForVm 做不到）', () => {
  const pool = makePool()
  const p = seed(pool)
  pool.bind(p.id, 'vm-01')
  assert.ok(pool.getProxyForVm('vm-01'), '前提：启用时 getProxyForVm 能取到')
  pool.setEnabled(p.id, false)
  assert.equal(pool.getProxyForVm('vm-01'), null, 'getProxyForVm 对禁用代理返回 null')
  assert.equal(pool.getProxyByIdWithAuth(p.id).url, 'socks5://alice:s3cret@1.2.3.4:1080', '新方法不受影响')
})

test('domain_forward: 开关要带到 kin-egress 用的代理对象上（两条取法都要）', () => {
  const pool = makePool()
  const p = seed(pool)
  pool.bind(p.id, 'vm-01')
  assert.equal(pool.getProxyByIdWithAuth(p.id).domain_forward, false, '默认关闭')
  assert.equal(pool.getProxyForVm('vm-01').domain_forward, false)

  const r = pool.update(p.id, { domain_forward: true })
  assert.equal(r.ok, true)
  assert.equal(r.domain_forward_changed, true)
  assert.equal(pool.getProxyByIdWithAuth(p.id).domain_forward, true, '面板改开关后重启出口用的就是它')
  assert.equal(pool.getProxyForVm('vm-01').domain_forward, true, '槽位启动/修复出口用的是它')

  pool.update(p.id, { domain_forward: false })
  assert.equal(pool.getProxyByIdWithAuth(p.id).domain_forward, false)
})

test('snapshot 回归：列表接口永不返回账密', () => {
  const pool = makePool()
  seed(pool)
  const s = JSON.stringify(pool.snapshot())
  assert.doesNotMatch(s, /alice|s3cret|socks5:\/\//, 'GET /proxies 的载荷不得含账密')
})

test('update: 只改代理名称不动连接字段，也不要求重载槽位；重开后名称仍在', () => {
  const pool = makePool()
  const p = seed(pool)
  const r = pool.update(p.id, { label: '  东京-2 号机  ' })
  assert.equal(r.ok, true)
  assert.equal(r.connection_changed, false)
  assert.equal(r.proxy.label, '东京-2 号机')
  assert.equal(p.raw, 'socks5://alice:s3cret@1.2.3.4:1080', '只改名称不应改写 raw')
  pool.load()
  assert.equal(pool.state.proxies[0].label, '东京-2 号机')
  assert.equal(pool.snapshot().proxies[0].label, '东京-2 号机')
})

test('update: 代理名称传空串清除；超长或非字符串被拒', () => {
  const pool = makePool()
  const p = seed(pool)
  pool.update(p.id, { label: 'a' })
  assert.equal(pool.update(p.id, { label: '' }).proxy.label, null)
  assert.equal(pool.update(p.id, { label: 'x'.repeat(65) }).error, 'label_too_long')
  assert.equal(pool.update(p.id, { label: 123 }).error, 'invalid_label')
})

test('update: 连接字段与名称同改时报告 connection_changed', () => {
  const pool = makePool()
  const p = seed(pool)
  const r = pool.update(p.id, { port: 1082, label: 'box' })
  assert.equal(r.connection_changed, true)
  assert.equal(p.port, 1082)
  assert.equal(p.label, 'box')
})

test('labelOf 只给名称，不带账密；未知代理返回 null', () => {
  const pool = makePool()
  const p = seed(pool)
  assert.equal(pool.labelOf(p.id), null)
  pool.update(p.id, { label: 'tw-box' })
  assert.equal(pool.labelOf(p.id), 'tw-box')
  assert.equal(pool.labelOf('px-missing'), null)
})

test('connection changes invalidate both geo caches; labels and identical endpoints preserve them', () => {
  const pool = makePool()
  const p = seed(pool)
  Object.assign(p, {
    geo_timezone: 'Asia/Tokyo',
    geo_ip: '203.0.113.1',
    geo_checked_at: '2026-01-01',
    geo_v6_timezone: 'Asia/Tokyo',
    geo_v6_ip: '2001:db8::1',
  })
  assert.equal(pool.update(p.id, { label: 'Tokyo' }).connection_changed, false)
  assert.equal(
    pool.update(p.id, { host: p.host, port: String(p.port), username: p.username, password: p.password })
      .connection_changed,
    false,
  )
  assert.equal(p.geo_timezone, 'Asia/Tokyo')
  assert.equal(p.geo_v6_ip, '2001:db8::1')
  const preview = pool.update(p.id, { password: 'next-password' }, { dryRun: true })
  assert.equal(preview.connection_changed, true)
  assert.equal(p.password, 's3cret')
  assert.equal(p.geo_timezone, 'Asia/Tokyo')
  pool.update(p.id, { password: 'next-password' })
  assert.equal(p.geo_timezone ?? null, null)
  assert.equal(p.geo_ip, null)
  assert.equal(p.geo_v6_ip, null)
})

test('bind validation and dry runs leave the old binding intact', () => {
  const pool = makePool()
  pool.importLines('10.0.0.1:1080\n10.0.0.2:1080')
  pool.updateConfig({ bind_limit: 1 })
  const [a, b] = pool.state.proxies
  pool.bind(a.id, 'vm-a')
  pool.bind(b.id, 'vm-b')
  assert.equal(pool.bind(b.id, 'vm-a', { dryRun: true }).error, 'proxy_bind_limit')
  assert.equal(pool.bind(b.id, 'vm-a').error, 'proxy_bind_limit')
  assert.equal(pool.getProxyForVm('vm-a').id, a.id)
  pool.unbind(b.id)
  assert.equal(pool.bind(b.id, 'vm-a', { dryRun: true }).connection_changed, true)
  assert.equal(pool.getProxyForVm('vm-a').id, a.id)
  assert.equal(pool.bind(a.id, 'vm-a', { dryRun: true }).connection_changed, false)
})

test('browser timezone uses saved data and only queries the actual proxy when missing', async () => {
  const pool = makePool()
  const p = seed(pool)
  p.geo_timezone = 'Asia/Tokyo'
  const seen = []
  pool.geoLookup = async (url, options) => {
    seen.push({ url, options })
    return { ok: true, geo: { timezone: 'Europe/London', ip: '203.0.113.2' } }
  }
  const relay = 'socks5h://127.0.0.1:19000'
  assert.equal(await pool.browserTimezone(p.id, relay), 'Asia/Tokyo')
  assert.equal(seen.length, 0)
  pool.update(p.id, { port: 1090 })
  assert.equal(await pool.browserTimezone(p.id, relay), 'Europe/London')
  assert.equal(seen[0].url, relay)
  assert.equal(seen[0].options.ipv6Mode, 'proxy')
  assert.equal(p.geo_timezone, 'Europe/London')
  await assert.rejects(pool.browserTimezone(p.id, ''), { code: 'proxy_required' })
})

test('browser timezone rejects missing location and does not save an old connection lookup', async () => {
  const pool = makePool()
  const p = seed(pool)
  pool.geoLookup = async () => ({ ok: false, error: 'offline' })
  await assert.rejects(pool.browserTimezone(p.id, 'socks5h://127.0.0.1:19000'), {
    code: 'browser_timezone_unavailable',
  })
  let finish
  pool.geoLookup = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const pending = pool.browserTimezone(p.id, 'socks5h://127.0.0.1:19000')
  pool.update(p.id, { host: 'new.proxy.test' })
  finish({ ok: true, geo: { timezone: 'Asia/Tokyo' } })
  await assert.rejects(pending, { code: 'browser_proxy_changed' })
  assert.equal(p.geo_timezone ?? null, null)
})
