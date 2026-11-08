#!/usr/bin/env node
'use strict'
// Renders the social card SVG that build.py writes (path as the first argument) to docs/social-preview.png (1280x640) with a headless
// Chromium from Playwright. Playwright is not a dependency of this repo: point PLAYWRIGHT at any
// install (for example PLAYWRIGHT=/path/to/node_modules/playwright), or have it resolvable.
const fs = require('fs')
const path = require('path')

const here = __dirname
const src = process.argv[2]
const dst = path.join(here, '..', 'social-preview.png')

let pw
try { pw = require(process.env.PLAYWRIGHT || 'playwright') } catch {
  console.error('Playwright not found. Set PLAYWRIGHT=/path/to/node_modules/playwright and run again.')
  process.exit(1)
}

;(async () => {
  const browser = await pw.chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 })
    await page.setContent(`<html><body style="margin:0">${fs.readFileSync(src, 'utf8')}</body></html>`)
    await page.screenshot({ path: dst, clip: { x: 0, y: 0, width: 1280, height: 640 } })
    console.log('social-preview.png written')
  } finally {
    await browser.close()
  }
})()
