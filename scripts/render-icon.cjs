/**
 * Renders build/icon.svg to build/icon.png (1024×1024) and the Linux icon set build/icons/<n>x<n>.png with
 * Electron's own Chromium, so no extra image tooling is needed. Run via `npm run icons` (which also builds
 * build/icon.icns on macOS).
 *
 * Linux desktops look icons up in the hicolor theme, which has no 1024 size, so the packages ship the usual sizes.
 * Those are rendered from a Linux variant of the SVG: without the macOS grid padding, the drop shadow and the light
 * rim (`#rim`), which read as an outline and a halo at launcher sizes next to other GNOME / KDE icons.
 */
const { app, BrowserWindow } = require('electron')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]

/** The rounded square spans 100..924; keep a small margin around it. */
function linuxVariant(svg) {
  return svg
    .replace('viewBox="0 0 1024 1024"', 'viewBox="70 70 884 884"')
    .replace('filter="url(#shadow)"', '')
    .replace(/<rect id="rim"[^>]*\/>/, '')
}

/** Render an SVG at 1024×1024 in `win` (one window for every render: closing the last one would quit the app). */
async function render(win, svg) {
  // Inline SVG sits on the text baseline, which makes the page taller than 1024 px; on Linux Chromium then paints
  // scrollbars into the capture. A block SVG and hidden overflow keep the edges transparent.
  const style = 'html,body{margin:0;overflow:hidden;background:transparent}svg{display:block}'
  const html = `<!doctype html><html><head><style>${style}</style></head><body>${svg}</body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((resolve) => setTimeout(resolve, 400))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  return image.resize({ width: 1024, height: 1024 })
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const root = join(__dirname, '..')
  const svg = readFileSync(join(root, 'build/icon.svg'), 'utf8')
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true }
  })
  win.webContents.setFrameRate(1)
  writeFileSync(join(root, 'build/icon.png'), (await render(win, svg)).toPNG())
  const linux = await render(win, linuxVariant(svg))
  mkdirSync(join(root, 'build/icons'), { recursive: true })
  for (const size of LINUX_SIZES) {
    writeFileSync(join(root, `build/icons/${size}x${size}.png`), linux.resize({ width: size, height: size, quality: 'best' }).toPNG())
  }
  app.quit()
})
