/** Exercise a real document lifecycle without external pages or account data. */
export async function verifyLocalBrowserPage(page) {
  const html =
    '<!doctype html><meta charset="utf-8"><label>Name <input id="name"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Check</button><output></output>'
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, { waitUntil: 'load' })
  await page.locator('#name').fill('vm2api fixture')
  await page.locator('aria/Check[role="button"]').click()
  if ((await page.$eval('output', (node) => node.textContent)) !== 'vm2api fixture')
    throw new Error('浏览器本地输入验证失败')
  const screenshot = await page.screenshot({ type: 'png' })
  if (!screenshot.length) throw new Error('浏览器本地截图验证失败')
  return { screenshotBytes: screenshot.length }
}
