#!/usr/bin/env node
/**
 * `pnpm screenshots`: the README's screenshots, from the demo data, into docs/images/ as WebP.
 *
 * It loads the demo into a temporary data folder, starts the built app on it (run `pnpm build`
 * first), and takes each screen in your installed Chrome, in light and in dark. Nothing of yours is
 * read: the demo is the only data the app has while it runs. `pnpm screenshots overview` takes only
 * the shots whose names start with "overview".
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(root, 'docs/images')
const only = process.argv[2]
const PORT = 8796
const BASE = `http://127.0.0.1:${PORT}/l/personal`

if (!existsSync(path.join(root, 'apps/server/dist/index.mjs')) || !existsSync(path.join(root, 'apps/web/dist/index.html'))) {
  console.error('Build the app first: pnpm build')
  process.exit(1)
}

const data = mkdtempSync(path.join(tmpdir(), 'st-screenshots-'))
const env = { ...process.env, DATA_DIR: data, API_PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'production' }
const seeded = spawnSync('pnpm', ['--silent', 'seed:demo'], { cwd: root, env, stdio: 'inherit' })
if (seeded.status !== 0) process.exit(seeded.status ?? 1)

const server = spawn(process.execPath, ['apps/server/dist/index.mjs'], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] })
let browser
try {
  for (let i = 0; ; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.ok, () => false)) break
    if (i > 100) throw new Error('The app didn’t start')
    await new Promise((r) => setTimeout(r, 100))
  }
  browser = await chromium.launch({ channel: 'chrome' })
  mkdirSync(out, { recursive: true })
  await takeAll(browser)
} finally {
  await browser?.close()
  server.kill()
  rmSync(data, { recursive: true, force: true })
}

async function takeAll(browser) {
  const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }
  // The gallery's: a smaller window, without the sidebar, so the page reads at half the README's width.
  const GALLERY = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 }
  const TALL = { ...GALLERY, viewport: { width: 1280, height: 1010 } }
  const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }

  /** Opens a page in a fresh window with the given device and theme, for `act` to use. */
  async function open(device, scheme, route, act) {
    const ctx = await browser.newContext({ ...device, colorScheme: scheme })
    const page = await ctx.newPage()
    await page.goto(BASE + route, { waitUntil: 'networkidle' })
    await page.waitForTimeout(600)
    try {
      return await act(page)
    } finally {
      await ctx.close()
    }
  }

  /**
   * The window (or `clip` of it) as WebP, from Chrome itself, at `scale` image pixels per CSS pixel
   * (Chrome's capture leaves out the device's scale unless it's given).
   */
  async function webp(page, file, scale, clip) {
    const cdp = await page.context().newCDPSession(page)
    const area = clip ?? (await page.evaluate(() => ({ x: 0, y: 0, width: document.documentElement.clientWidth, height: window.innerHeight })))
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'webp', quality: 82, clip: { ...area, scale } })
    writeFileSync(path.join(out, file), Buffer.from(data, 'base64'))
    console.log(`docs/images/${file}`)
  }

  /** Everything right of the sidebar. */
  const content = (page) =>
    page.evaluate(() => {
      const main = document.querySelector('main')
      const left = Math.round(main.parentElement.getBoundingClientRect().left)
      return { x: left, y: 0, width: document.documentElement.clientWidth - left, height: window.innerHeight }
    })

  const shots = [
    { name: 'transactions-desktop', device: GALLERY, route: '/transactions', clip: true },
    { name: 'reports-desktop', device: GALLERY, route: '/reports', clip: true },
    { name: 'accounts-desktop', device: GALLERY, route: '/accounts', clip: true },
    {
      name: 'recurring-desktop',
      device: TALL,
      route: '/recurring',
      clip: true,
    },
    { name: 'overview-phone', device: PHONE, route: '' },
    {
      name: 'quick-add-phone',
      device: PHONE,
      route: '',
      act: async (page) => {
        await page.getByRole('button', { name: /Add transaction|Add/ }).last().click()
        await page.waitForTimeout(500)
        await page.getByLabel('Amount', { exact: true }).fill('6.75')
        await page.locator('#tx-payee').fill('Corner Bakery')
        await page.locator('#tx-payee').blur()
        await page.waitForFunction(() => !document.body.innerText.includes('Finding a category'), null, { timeout: 5000 }).catch(() => {})
      },
    },
  ]

  for (const scheme of ['light', 'dark']) {
    for (const s of shots) {
      if (only && !s.name.startsWith(only)) continue
      await open(s.device, scheme, s.route, async (page) => {
        if (s.act) await s.act(page)
        // No hover highlight where the pointer stopped.
        if (!s.device.isMobile) await page.mouse.move(0, 0)
        await page.waitForTimeout(500)
        await webp(page, `${s.name}-${scheme}.webp`, s.device.deviceScaleFactor, s.clip ? await content(page) : undefined)
      })
    }
    if (!only || 'hero'.startsWith(only)) await hero(scheme)
  }

  /** The desktop Overview with the phone's overlapping its corner, on a transparent background. */
  async function hero(scheme) {
    const png = (device) =>
      open(device, scheme, '', async (page) => `data:image/png;base64,${(await page.screenshot()).toString('base64')}`)
    const [desktop, phone] = [await png(DESKTOP), await png(PHONE)]
    const border = scheme === 'dark' ? '#3f3f46' : '#d4d4d8'
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
    const page = await ctx.newPage()
    await page.setContent(`<body style="margin:0;background:transparent">
      <img src="${desktop}" style="position:absolute;left:0;top:0;width:1360px;border-radius:14px;border:1px solid ${border};box-shadow:0 20px 50px rgba(0,0,0,.25)">
      <img src="${phone}" style="position:absolute;right:20px;bottom:20px;width:330px;border-radius:38px;border:8px solid ${scheme === 'dark' ? '#27272a' : '#18181b'};box-shadow:0 24px 60px rgba(0,0,0,.35)">
    </body>`)
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
    await page.waitForTimeout(200)
    await webp(page, `hero-${scheme}.webp`, 1.125)
    await ctx.close()
  }
}
