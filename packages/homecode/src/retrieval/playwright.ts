import { Effect } from "effect"

export interface RenderResult {
  readonly html: string
  readonly rendered: boolean
}

const SPA_INDICATORS = [
  /<noscript>[^<]*JavaScript[^<]*<\/noscript>/i,
  /you need to enable javascript to run this app/i,
  /please enable javascript/i,
  /enable javascript and refresh/i,
  /<div id="root"><\/div>/i,
  /<div id="__next"><\/div>/i,
  /<div id="app"><\/div>/i,
]

export function isDynamicSPA(html: string): boolean {
  if (!html || html.length < 50) return false

  // If the document is very short (< 1500 chars) and contains common SPA root tags
  const isShort = html.length < 2500
  for (const indicator of SPA_INDICATORS) {
    if (indicator.test(html)) {
      if (isShort || indicator.toString().includes("javascript")) {
        return true
      }
    }
  }

  return false
}

export function renderWithHeadlessBrowser(url: string, timeoutMs = 8000): Effect.Effect<RenderResult> {
  return Effect.promise(async () => {
    let playwrightMod: any = null
    try {
      const moduleName = "@playwright/test"
      playwrightMod = await import(moduleName).catch(() => null)
    } catch {
      return { html: "", rendered: false }
    }

    const chromium = playwrightMod?.chromium
    if (!chromium) {
      return { html: "", rendered: false }
    }

    try {
      const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      })
      try {
        const context = await browser.newContext({
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        })
        const page = await context.newPage()
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs })
        await page.waitForTimeout(1000)
        const html = await page.content()
        await context.close()
        return { html, rendered: true }
      } finally {
        await browser.close()
      }
    } catch {
      return { html: "", rendered: false }
    }
  })
}

export * as PlaywrightFallback from "./playwright"
