// Скриншоты «до/после» для PR с правками интерфейса: Playwright (playwright-core + браузеры из кеша Playwright).
// «До» — основной сайт, «после» — превью PR. Защита Vercel — заголовок обхода, вход — cookie из настроек репозитория.
import fs from 'node:fs'
import path from 'node:path'

export const VIEWPORTS = [
  {
    id: 'phone',
    title: 'телефон',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
  {
    id: 'desktop',
    title: 'десктоп',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  },
]

// «a=b; c=d» → куки для хоста адреса
function cookiesFor(str, url) {
  if (!str)
    return []
  const host = new URL(url).hostname
  return String(str).split(/;\s*/).map(p => p.trim()).filter(p => p.includes('=')).map((p) => {
    const i = p.indexOf('=')
    return {
      name: p.slice(0, i).trim(),
      value: p.slice(i + 1).trim(),
      domain: host,
      path: '/',
      secure: url.startsWith('https'),
      sameSite: 'Lax',
    }
  })
}

// Почему страница не та: защита Vercel или вход в приложение
export function blockedReason(finalUrl, html) {
  if (/vercel\.com\/(sso|login)|_vercel_sso|vercel-authentication/i.test(finalUrl) || /Vercel Authentication|Log in to Vercel/i.test(html))
    return 'vercel'
  if (/\/(login|signin|sign-in|auth)(\b|\/|\?|$)/i.test(new URL(finalUrl).pathname))
    return 'login'
  return ''
}

// shots: [{ key, url }] → { files: [{ key, vp, file, blocked }] }
export async function shoot(shots, { cookie, bypass, outDir }) {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch()
  const files = []
  try {
    for (const vp of VIEWPORTS) {
      const headers = bypass
        ? { 'x-vercel-protection-bypass': bypass, 'x-vercel-set-bypass-cookie': 'samesitenone' }
        : {}
      const ctx = await browser.newContext({
        ...vp,
        extraHTTPHeaders: headers,
        locale: 'ru-RU',
        colorScheme: 'light',
      })
      for (const s of shots) {
        const page = await ctx.newPage()
        try {
          await ctx.addCookies(cookiesFor(cookie, s.url))
          await page.goto(s.url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => page.waitForLoadState('load').catch(() => {}))
          await page.waitForTimeout(1500)
          const blocked = blockedReason(page.url(), await page.content().catch(() => ''))
          const file = path.join(outDir, `${s.key}-${vp.id}.png`)
          fs.mkdirSync(outDir, { recursive: true })
          await page.screenshot({ path: file })
          files.push({ key: s.key, vp: vp.id, file, blocked })
        }
        catch (e) {
          files.push({
            key: s.key,
            vp: vp.id,
            file: '',
            blocked: '',
            error: e.message.split('\n')[0],
          })
        }
        finally { await page.close().catch(() => {}) }
      }
      await ctx.close()
    }
  }
  finally { await browser.close() }
  return { files }
}

// какие страницы снимать: из графа — страницы (слой pages), которые используют изменённые слайсы; маршрут — по имени слайса
export function pickRoutes(g, changed, sliceOf, manual) {
  if (manual?.trim())
    return manual.split(/[,\s]+/).filter(p => p.startsWith('/')).slice(0, 4)
  const fsd = g?.fsd
  if (!fsd)
    return ['/']
  const pagesLayer = fsd.layers.find(l => l.replace(/^\d+[.\-_]/, '') === 'pages')
  if (!pagesLayer)
    return ['/']
  // кто использует изменённое (вверх по импортам, до 3 шагов) → среди них страницы
  const users = new Map()
  for (const e of g.edges) {
    const a = sliceOf(e.from, fsd); const b = sliceOf(e.to, fsd)
    if (a !== b) {
      users.set(b, [
        ...(users.get(b) || []),
        a,
      ])
    }
  }
  let front = new Set(changed.map(f => sliceOf(f, fsd)))
  const seen = new Set(front)
  for (let i = 0; i < 3; i++) {
    const next = new Set()
    for (const s of front) {
      for (const u of users.get(s) || []) {
        if (!seen.has(u)) { seen.add(u); next.add(u) }
      }
    }
    front = next
  }
  const prefix = `${fsd.root}${pagesLayer}/`
  const pages = [...seen].filter(s => s.startsWith(prefix)).map(s => s.slice(prefix.length)).filter(Boolean)
  const routes = pages.map(p => (/^(home|main|index)$/.test(p)
    ? '/'
    : `/${p}`))
  const uniq = [
    ...new Set(routes),
  ]
  return (uniq.length
    ? uniq
    : ['/']).slice(0, 3)
}
