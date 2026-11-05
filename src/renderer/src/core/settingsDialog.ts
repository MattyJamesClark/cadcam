import { icons } from './icons'
import {
  ACCENTS,
  BACKGROUNDS,
  DEFAULT_SETTINGS,
  effectiveTheme,
  settings,
  type ImportQuality,
  type NavStyle,
  type Settings,
  type ThemeMode
} from './settings'

const NAV_HELP: Record<NavStyle, [string, string][]> = {
  solidworks: [
    ['Rotate', 'Middle drag'],
    ['Pan', 'Ctrl + middle drag'],
    ['Zoom', 'Wheel, or Shift + middle drag'],
    ['Roll', 'Alt + middle drag'],
    ['Zoom to fit', 'Double-click middle, or F'],
    ['Rotate 15° / 90°', 'Arrow keys / Shift + arrows'],
    ['Views', 'Ctrl+1 Front, 2 Back, 3 Left, 4 Right, 5 Top, 6 Bottom, 7 Iso']
  ],
  generic: [
    ['Rotate', 'Right drag'],
    ['Pan', 'Middle drag, or Shift + right drag'],
    ['Zoom', 'Wheel'],
    ['Zoom to fit', 'F'],
    ['Views', 'Ctrl+1 Front, 2 Back, 3 Left, 4 Right, 5 Top, 6 Bottom, 7 Iso']
  ]
}

/** Apply theme-level settings (light/dark, accent) to the whole UI. */
export function applyTheme(s: Settings = settings.get()): void {
  const root = document.documentElement
  root.dataset.theme = effectiveTheme(s)
  root.style.setProperty('--accent', s.accent)
  root.style.setProperty('--accent-soft', hexA(s.accent, 0.16))
  root.style.setProperty('--accent-line', hexA(s.accent, 0.45))
}

export function initTheme(): void {
  applyTheme()
  settings.on('changed', applyTheme)
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme())
}

/** Settings window. Every change applies immediately and is saved on this computer. */
export function openSettings(): void {
  if (document.querySelector('.modal-backdrop')) return
  const back = document.createElement('div')
  back.className = 'modal-backdrop'
  const dlg = document.createElement('div')
  dlg.className = 'modal'
  dlg.setAttribute('role', 'dialog')
  dlg.setAttribute('aria-modal', 'true')
  dlg.setAttribute('aria-label', 'Settings')
  back.append(dlg)
  document.body.append(back)

  const close = (): void => {
    back.remove()
    window.removeEventListener('keydown', onKey, true)
    off()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  }
  window.addEventListener('keydown', onKey, true)
  back.addEventListener('mousedown', (e) => e.target === back && close())

  const render = (): void => {
    const s = settings.get()
    dlg.innerHTML = `
      <header class="modal-head">
        <h2>Settings</h2>
        <button class="icon-btn" data-act="close" title="Close (Esc)">${icons.close}</button>
      </header>
      <div class="modal-body">
        <section>
          <h3>Appearance</h3>
          <div class="field">
            <label>Mode</label>
            <div class="seg" role="radiogroup">
              ${(['light', 'dark', 'system'] as ThemeMode[])
                .map((t) => `<button role="radio" aria-checked="${s.theme === t}" data-theme="${t}">${cap(t)}</button>`)
                .join('')}
            </div>
          </div>
          <div class="field">
            <label>Accent colour</label>
            <div class="swatches">
              ${ACCENTS.map(
                (c) =>
                  `<button class="swatch ${same(c, s.accent) ? 'on' : ''}" data-accent="${c}" style="--c:${c}" title="${c}"></button>`
              ).join('')}
              <input type="color" data-key="accent" value="${s.accent}" title="Custom colour" />
            </div>
          </div>
          <div class="field">
            <label>Viewport background</label>
            <div class="bg-presets">
              ${BACKGROUNDS.map((b, i) => {
                const on = b.top === s.viewportTop && b.bottom === s.viewportBottom
                const style = b.top ? `background:linear-gradient(${b.top},${b.bottom})` : ''
                return `<button class="bg-preset ${on ? 'on' : ''} ${b.top ? '' : 'auto'}" data-bg="${i}" style="${style}"><span>${b.name}</span></button>`
              }).join('')}
            </div>
            <div class="inline">
              <span>Custom: top</span><input type="color" data-key="viewportTop" value="${s.viewportTop ?? '#3b4350'}" />
              <span>bottom</span><input type="color" data-key="viewportBottom" value="${s.viewportBottom ?? '#1c2026'}" />
            </div>
          </div>
          <div class="field">
            <label>Part colour</label>
            <div class="inline">
              <input type="color" data-key="partColor" value="${s.partColor}" />
              <span class="hint">Used for shapes and for imported files that have no colour of their own.</span>
            </div>
          </div>
        </section>

        <section>
          <h3>Mouse &amp; navigation</h3>
          <div class="field">
            <label>Style</label>
            <div class="seg" role="radiogroup">
              <button role="radio" aria-checked="${s.navStyle === 'solidworks'}" data-nav="solidworks">SolidWorks</button>
              <button role="radio" aria-checked="${s.navStyle === 'generic'}" data-nav="generic">Generic (right-drag rotate)</button>
            </div>
          </div>
          <table class="keys">
            ${NAV_HELP[s.navStyle].map(([a, k]) => `<tr><td>${a}</td><td>${k}</td></tr>`).join('')}
          </table>
          <label class="check"><input type="checkbox" data-bool="rotateAboutCursor" ${s.rotateAboutCursor ? 'checked' : ''}/> Rotate about the point under the cursor</label>
          <label class="check"><input type="checkbox" data-bool="reverseWheel" ${s.reverseWheel ? 'checked' : ''}/> Reverse mouse wheel zoom direction</label>
        </section>

        <section>
          <h3>Import</h3>
          <div class="field">
            <label>STEP / IGES quality</label>
            <div class="seg" role="radiogroup">
              ${(['draft', 'normal', 'fine'] as ImportQuality[])
                .map((q) => `<button role="radio" aria-checked="${s.importQuality === q}" data-quality="${q}">${cap(q)}</button>`)
                .join('')}
            </div>
            <span class="hint inline">How finely curved surfaces are turned into triangles. Fine looks smoother but is slower on big assemblies. Applies to the next import.</span>
          </div>
        </section>

        <section>
          <h3>Viewport</h3>
          <label class="check"><input type="checkbox" data-bool="showTriad" ${s.showTriad ? 'checked' : ''}/> Show XYZ triad (bottom left)</label>
          <label class="check"><input type="checkbox" data-bool="showViewCube" ${s.showViewCube ? 'checked' : ''}/> Show view cube (top right)</label>
        </section>
      </div>
      <footer class="modal-foot">
        <button class="btn" data-act="reset">Reset to defaults</button>
        <span class="spacer"></span>
        <button class="btn primary" data-act="close">Done</button>
      </footer>`
  }

  dlg.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button')
    if (!b) return
    const d = b.dataset
    if (d.act === 'close') return close()
    if (d.act === 'reset') return settings.set({ ...DEFAULT_SETTINGS })
    if (d.theme) settings.set({ theme: d.theme as ThemeMode })
    if (d.accent) settings.set({ accent: d.accent })
    if (d.nav) settings.set({ navStyle: d.nav as NavStyle })
    if (d.quality) settings.set({ importQuality: d.quality as ImportQuality })
    if (d.bg) {
      const p = BACKGROUNDS[Number(d.bg)]
      settings.set({ viewportTop: p.top, viewportBottom: p.bottom })
    }
  })
  dlg.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement
    if (el.dataset.key) settings.set({ [el.dataset.key]: el.value } as Partial<Settings>)
  })
  dlg.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement
    if (el.dataset.bool) settings.set({ [el.dataset.bool]: el.checked } as Partial<Settings>)
  })

  // Re-render on change, but not while a colour picker is being dragged (it would lose focus).
  const off = settings.on('changed', () => {
    if ((document.activeElement as HTMLInputElement | null)?.type === 'color') return
    render()
  })
  render()
  ;(dlg.querySelector('[data-act="close"]') as HTMLElement).focus()
}

const cap = (s: string): string => s[0].toUpperCase() + s.slice(1)
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}
