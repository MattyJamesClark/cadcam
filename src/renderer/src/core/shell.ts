import { startContextMenu } from './contextmenu'
import { selection } from './selection'
import { startBottomBar } from './bottombar'
import { startPlanes } from './planes'
import { startGridControl } from './gridsnap'
import { setTreeRefresher, treeSections } from './treeext'
import * as THREE from 'three'
import { CadDocument, type DocNode, type Measure } from './document'
import { icons } from './icons'
import type { CadModule, Command, ModuleContext, StatusKind } from './types'
import { Viewport } from './viewport'
import { openSettings } from './settingsDialog'
import type { UpdateStatus } from '../../../shared/ipc'

const TAB_KEY = 'cadcam.activeTab'
const VIEW_KEY = 'cadcam.treeView'
/** Menu items that open a dialog get an ellipsis, as in Windows menus. */
const DIALOG_IDS = new Set(['file.open', 'file.merge', 'file.save-as'])
const PROPS_KEY = 'cadcam.propsOpen'

const store = {
  get: (k: string): string | null => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k: string, v: string): void => {
    try {
      localStorage.setItem(k, v)
    } catch {
      /* ignore */
    }
  }
}

const num = (v: number, digits = 3): string =>
  Math.abs(v) >= 1e12 ? v.toExponential(3) : v.toLocaleString(undefined, { maximumFractionDigits: digits })
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  html?: string
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (html !== undefined) el.innerHTML = html
  return el
}

/**
 * Application frame: title bar, module tabs, ribbon, model tree, viewport and
 * status bar. Modules supply commands; the shell lays them out and routes
 * shortcuts. The shell itself knows nothing about any specific module.
 */
export class Shell {
  readonly doc = new CadDocument()
  readonly viewport: Viewport
  readonly ctx: ModuleContext
  private modules: CadModule[]
  private active: CadModule | null = null
  private commands = new Map<string, Command>()
  private els: Record<
    'tabs' | 'ribbon' | 'tree' | 'props' | 'propsBody' | 'status' | 'cursor' | 'version' | 'update' | 'docName' | 'menubar',
    HTMLElement
  >
  private buttons = new Map<string, HTMLButtonElement>()
  private treeView: 'tree' | 'layers' = store.get(VIEW_KEY) === 'layers' ? 'layers' : 'tree'
  private openLayers = new Set<string>()
  private measureCache = { key: '', value: null as Measure | null }
  /** Tree rows from the last render, so selection changes only restyle rows. */
  private rowsById = new Map<string, HTMLElement[]>()
  private statusTimer = 0

  constructor(root: HTMLElement, modules: CadModule[]) {
    this.modules = [...modules].sort((a, b) => a.order - b.order)

    root.innerHTML = ''
    const title = h('header', 'titlebar')
    title.innerHTML = `<div class="brand"><span class="brand-mark"></span>CADCAM Studio</div>`
    const docName = h('div', 'doc-name')
    const update = h('button', 'update-pill')
    update.hidden = true
    const gear = h('button', 'icon-btn', icons.gear)
    gear.title = 'Settings (Ctrl+,)'
    gear.addEventListener('click', () => openSettings())
    const menubar = h('nav', 'menubar')
    const qat = h('div', 'qat')
    title.append(menubar, qat, docName, update, gear)

    const tabs = h('nav', 'tabs')
    tabs.setAttribute('role', 'tablist')
    const ribbon = h('section', 'ribbon')

    const work = h('main', 'workspace')
    const side = h('aside', 'sidebar')
    const head = h('div', 'panel-title side-head')
    head.append(h('span', '', 'Model'))
    const seg = h('div', 'seg')
    for (const [v, label, tip] of [
      ['tree', 'Tree', 'Files, assemblies, parts and bodies'],
      ['layers', 'Layers', 'Bodies grouped by the layers in the source file']
    ] as const) {
      const b = h('button', 'seg-btn', label)
      b.title = tip
      b.dataset.view = v
      b.addEventListener('click', () => {
        this.treeView = v
        store.set(VIEW_KEY, v)
        this.doc.emit('changed', undefined)
      })
      seg.append(b)
    }
    head.append(seg)
    const tree = h('ul', 'tree')
    const props = h('section', 'props')
    const propsHead = h('button', 'panel-title props-head', `${icons.chevron}<span>Properties</span>`)
    const propsBody = h('div', 'props-body')
    props.classList.toggle('open', store.get(PROPS_KEY) !== '0')
    propsHead.addEventListener('click', () => {
      const open = !props.classList.contains('open')
      props.classList.toggle('open', open)
      store.set(PROPS_KEY, open ? '1' : '0')
      this.renderProps()
    })
    props.append(propsHead, propsBody)
    side.append(head, tree, props)
    const vpHost = h('div', 'viewport')
    work.append(side, vpHost)

    const status = h('footer', 'statusbar')
    const msg = h('span', 'status-msg', 'Ready')
    const cursor = h('span', 'status-cursor')
    const units = h('span', 'status-units', 'mm')
    const version = h('span', 'status-version')
    status.append(msg, cursor, units, version)

    root.append(title, tabs, ribbon, work, status)

    this.els = { tabs, ribbon, tree, props, propsBody, status: msg, cursor, version, update, docName, menubar }

    this.viewport = new Viewport(vpHost, this.doc)
    this.ctx = {
      doc: this.doc,
      viewport: this.viewport,
      status: (m, k) => this.setStatus(m, k),
      refreshRibbon: () => this.refreshRibbon(),
      runCommand: (id) => {
        const c = this.commands.get(id)
        if (c && (c.isEnabled?.(this.ctx) ?? true)) void c.run(this.ctx)
        this.refreshRibbon()
      },
      command: (id) => this.commands.get(id)
    }

    for (const m of this.modules)
      for (const g of m.groups) for (const c of g.commands) this.commands.set(c.id, c)

    this.addAppCommands()
    this.buildMenus(menubar)
    this.buildQuickBar(qat)
    this.buildTabs()
    this.bindShortcuts()
    this.bindDocument()
    this.bindUpdates()
    selection.start(this.ctx)
    startBottomBar(this.ctx)
    startPlanes(this.ctx)
    startGridControl(this.viewport)
    startContextMenu(this.ctx)
    for (const m of this.modules) m.init?.(this.ctx)
    let fitQueued = false
    new ResizeObserver(() => {
      if (fitQueued) return
      fitQueued = true
      requestAnimationFrame(() => {
        fitQueued = false
        this.fitRibbon()
      })
    }).observe(this.els.ribbon)

    const saved = safeGet(TAB_KEY)
    this.activate(this.modules.find((m) => m.id === saved) ?? this.modules[0])
  }

  // ---- menu bar & quick toolbar -----------------------------------------

  /** Commands that belong to the app rather than a module. */
  private addAppCommands(): void {
    const app: Command[] = [
      { id: 'app.settings', label: 'Settings…', icon: icons.gear, shortcut: 'Ctrl+,', menuOnly: true, run: () => openSettings() },
      { id: 'app.exit', label: 'Exit', icon: icons.close, menuOnly: true, run: () => window.close() },
      {
        id: 'edit.history',
        label: 'Undo history…',
        icon: icons.history,
        menuOnly: true,
        isEnabled: () => this.doc.history.canUndo || this.doc.history.canRedo,
        run: () => this.openHistory(this.els.menubar)
      },
      {
        id: 'edit.select-all',
        label: 'Select all',
        icon: icons.box,
        shortcut: 'Ctrl+A',
        menuOnly: true,
        isEnabled: () => !this.doc.isEmpty(),
        run: () => this.doc.select(this.doc.roots.map((n) => n.id))
      },
      {
        id: 'edit.rename',
        label: 'Rename',
        icon: icons.part,
        shortcut: 'F2',
        menuOnly: true,
        isEnabled: () => this.doc.selection().length === 1,
        run: () => {
          const id = this.doc.selection()[0]
          const label = this.rowsById.get(id)?.[0]?.querySelector('.tree-label') as HTMLElement | null
          if (label) this.renameInline(label, id)
        }
      },
      {
        id: 'help.controls',
        label: 'Mouse and keyboard controls',
        icon: icons.menu,
        menuOnly: true,
        run: () => this.showControls()
      },
      {
        id: 'help.updates',
        label: 'Check for updates',
        icon: icons.update,
        menuOnly: true,
        run: () => (this.els.version as HTMLElement).click()
      },
      {
        id: 'help.about',
        label: 'About CADCAM Studio',
        icon: icons.file,
        menuOnly: true,
        run: async () => {
          const v = window.host ? (await window.host.appInfo()).version : 'browser preview'
          this.setStatus(`CADCAM Studio v${v}. CAD kernel: OpenCascade 7.9 (LGPL). Viewer: three.js.`, 'info')
        }
      }
    ]
    for (const c of app) this.commands.set(c.id, c)
  }

  private menuSpec(): { title: string; items: (string | '-' | { sub: string; items: string[] })[] }[] {
    const ids = [...this.commands.keys()]
    const exports = ids.filter((i) => i.startsWith('file.export.'))
    const view = this.modules.find((m) => m.id === 'view')
    return [
      {
        title: 'File',
        items: ['file.new', 'file.open', 'file.merge', '-', 'file.save', 'file.save-as', '-', { sub: 'Export', items: exports }, '-', 'app.settings', '-', 'app.exit']
      },
      {
        title: 'Edit',
        items: ['edit.undo', 'edit.redo', 'edit.history', '-', 'edit.select-all', 'edit.rename', 'edit.translate', '-', 'edit.hide', 'edit.show-all', 'edit.delete']
      },
      {
        title: 'View',
        items: (view?.groups ?? []).flatMap((g, i) => [...(i ? ['-'] : []), ...g.commands.map((c) => c.id)])
      },
      {
        title: 'Query',
        items: (this.modules.find((m) => m.id === 'query')?.groups ?? []).flatMap((g, i) => [...(i ? ['-'] : []), ...g.commands.map((c) => c.id)])
      },
      { title: 'Help', items: ['help.controls', 'help.updates', '-', 'help.about'] }
    ]
  }

  private buildMenus(bar: HTMLElement): void {
    let openMenu: HTMLElement | null = null
    const close = (): void => {
      openMenu?.remove()
      openMenu = null
      bar.querySelectorAll('.menu-title.open').forEach((b) => b.classList.remove('open'))
    }
    const item = (id: string): HTMLElement | null => {
      const c = this.commands.get(id)
      if (!c) return null
      const b = h('button', 'menu-item')
      b.innerHTML = `<span class="mi-icon">${c.icon}</span><span class="mi-label">${c.label}${DIALOG_IDS.has(id) ? '…' : ''}</span><span class="mi-key">${c.shortcut ?? ''}</span>`
      b.disabled = c.isEnabled ? !c.isEnabled(this.ctx) : false
      if (c.isActive?.(this.ctx)) b.classList.add('on')
      b.addEventListener('click', () => {
        close()
        void this.run(c)
      })
      return b
    }
    const build = (items: (string | '-' | { sub: string; items: string[] })[]): HTMLElement => {
      const m = h('div', 'menu')
      for (const it of items) {
        if (it === '-') m.append(h('div', 'menu-sep'))
        else if (typeof it === 'string') {
          const el = item(it)
          if (el) m.append(el)
        } else {
          const b = h('div', 'menu-item has-sub', `<span class="mi-icon">${icons.export}</span><span class="mi-label">${it.sub}</span><span class="mi-key">${icons.chevron}</span>`)
          const sub = build(it.items)
          sub.classList.add('submenu')
          b.append(sub)
          m.append(b)
        }
      }
      return m
    }
    for (const spec of this.menuSpec()) {
      const t = h('button', 'menu-title', spec.title)
      const open = (): void => {
        close()
        // Rebuild each time so enabled states and labels are current.
        const items = this.menuSpec().find((s) => s.title === spec.title)!.items
        openMenu = build(items)
        const r = t.getBoundingClientRect()
        openMenu.style.left = `${r.left}px`
        openMenu.style.top = `${r.bottom + 2}px`
        document.body.append(openMenu)
        t.classList.add('open')
      }
      t.addEventListener('click', (e) => {
        e.stopPropagation()
        if (t.classList.contains('open')) close()
        else open()
      })
      // Like a native menu bar: once one is open, hovering another opens it.
      t.addEventListener('mouseenter', () => {
        if (openMenu && !t.classList.contains('open')) open()
      })
      bar.append(t)
    }
    document.addEventListener('pointerdown', (e) => {
      if (openMenu && !openMenu.contains(e.target as Node) && !bar.contains(e.target as Node)) close()
    })
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close()
    })
    window.addEventListener('blur', close)
  }

  /** Small always-visible toolbar in the title bar, like the SolidWorks quick access bar. */
  private buildQuickBar(bar: HTMLElement): void {
    const btn = (id: string): HTMLButtonElement => {
      const c = this.commands.get(id)!
      const b = h('button', 'icon-btn qat-btn', c.icon)
      b.title = `${c.label}${c.shortcut ? ` (${c.shortcut})` : ''}`
      b.addEventListener('click', () => void this.run(c))
      this.qatButtons.set(id, b)
      return b
    }
    const histBtn = h('button', 'icon-btn qat-btn qat-drop', icons.chevron)
    histBtn.title = 'Undo history'
    histBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.openHistory(histBtn)
    })
    this.qatButtons.set('edit.history', histBtn)
    bar.append(btn('file.new'), btn('file.open'), btn('file.save'), h('span', 'qat-sep'), btn('edit.undo'), histBtn, btn('edit.redo'))
    const refresh = (): void => {
      for (const [id, b] of this.qatButtons) {
        const c = this.commands.get(id)
        b.disabled = c?.isEnabled ? !c.isEnabled(this.ctx) : false
      }
      const h0 = this.doc.history
      this.qatButtons.get('edit.undo')!.title = h0.canUndo ? `Undo ${h0.undoLabels.at(-1)} (Ctrl+Z)` : 'Nothing to undo'
      this.qatButtons.get('edit.redo')!.title = h0.canRedo ? `Redo ${h0.redoLabels[0]} (Ctrl+Y)` : 'Nothing to redo'
    }
    this.doc.history.on('changed', refresh)
    this.doc.on('changed', refresh)
    this.doc.on('selection', refresh)
    refresh()
  }
  private qatButtons = new Map<string, HTMLButtonElement>()

  /** Undo history: every change, newest first. Click one to go back to just after it. */
  private openHistory(anchor: HTMLElement): void {
    document.querySelector('.history-pop')?.remove()
    const hist = this.doc.history
    const pop = h('div', 'menu history-pop')
    const head = h('div', 'history-head', 'Undo history')
    pop.append(head)
    const redo = hist.redoLabels // next to redo first
    const undo = hist.undoLabels
    // Redo-able steps (greyed, above the current point), newest last.
    ;[...redo].reverse().forEach((label, i) => {
      const steps = redo.length - i
      const b = h('button', 'menu-item history-item undone', `<span class="mi-label">${esc(label)}</span>`)
      b.title = `Redo ${steps} step${steps > 1 ? 's' : ''}`
      b.addEventListener('click', () => {
        pop.remove()
        this.doc.redo(steps)
        this.setStatus(`Redid ${steps} step${steps > 1 ? 's' : ''}`)
      })
      pop.append(b)
    })
    const now = h('div', 'history-now', hist.canUndo || hist.canRedo ? 'Current state' : 'No changes yet')
    pop.append(now)
    ;[...undo].reverse().forEach((label, i) => {
      const steps = i + 1
      const b = h('button', 'menu-item history-item', `<span class="mi-label">${esc(label)}</span>`)
      b.title = `Undo ${steps} step${steps > 1 ? 's' : ''}`
      b.addEventListener('click', () => {
        pop.remove()
        this.doc.undo(steps)
        this.setStatus(`Undid ${steps} step${steps > 1 ? 's' : ''}`)
      })
      pop.append(b)
    })
    const r = anchor.getBoundingClientRect()
    pop.style.left = `${r.left}px`
    pop.style.top = `${r.bottom + 2}px`
    document.body.append(pop)
    now.scrollIntoView({ block: 'center' })
    const off = (e: PointerEvent): void => {
      if (pop.contains(e.target as Node)) return
      pop.remove()
      document.removeEventListener('pointerdown', off, true)
    }
    setTimeout(() => document.addEventListener('pointerdown', off, true))
  }

  private showControls(): void {
    const rows = [
      ['Rotate', 'Middle-drag (about the point under the cursor)'],
      ['Pan', 'Ctrl + middle-drag'],
      ['Zoom', 'Wheel, or Shift + middle-drag'],
      ['Roll', 'Alt + middle-drag'],
      ['Zoom to fit', 'Double-click middle, or F'],
      ['Standard views', 'Ctrl+1 … Ctrl+7'],
      ['Select / add to selection', 'Click / Ctrl+click'],
      ['Hide / show, show all', 'H / Shift+H'],
      ['Undo / redo', 'Ctrl+Z / Ctrl+Y'],
      ['Save / Save As', 'Ctrl+S / Ctrl+Shift+S'],
      ['Rename', 'F2 or double-click in the tree']
    ]
    const back = h('div', 'modal-backdrop')
    const box = h('div', 'modal')
    box.innerHTML = `<div class="modal-head"><span>Mouse and keyboard</span></div><dl class="props-list">${rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')}</dl>`
    back.append(box)
    back.addEventListener('click', (e) => {
      if (e.target === back) back.remove()
    })
    window.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') {
        back.remove()
        window.removeEventListener('keydown', esc)
      }
    })
    document.body.append(back)
  }

  // ---- tabs & ribbon -----------------------------------------------------

  private buildTabs(): void {
    for (const m of this.modules) {
      const tab = h('button', 'tab', m.title)
      tab.setAttribute('role', 'tab')
      tab.dataset.id = m.id
      if (m.planned) tab.classList.add('planned')
      tab.addEventListener('click', () => this.activate(m))
      this.els.tabs.append(tab)
    }
  }

  activate(m: CadModule): void {
    if (this.active === m) return
    this.active?.deactivate?.(this.ctx)
    this.active = m
    safeSet(TAB_KEY, m.id)
    for (const t of this.els.tabs.querySelectorAll<HTMLElement>('.tab')) {
      const on = t.dataset.id === m.id
      t.classList.toggle('active', on)
      t.setAttribute('aria-selected', String(on))
    }
    this.buildRibbon(m)
    m.activate?.(this.ctx)
  }

  private buildRibbon(m: CadModule): void {
    const r = this.els.ribbon
    r.innerHTML = ''
    this.buttons.clear()
    if (m.planned) {
      r.append(h('div', 'ribbon-planned', `<strong>${m.title}</strong> is coming in a later update. ${m.planned}`))
      return
    }
    for (const g of m.groups.filter((x) => x.ribbon !== false)) {
      const group = h('div', 'ribbon-group')
      const row = h('div', 'ribbon-row')
      for (const c of g.commands) {
        const b = h('button', 'cmd')
        b.innerHTML = `${c.icon}<span>${c.label}</span>`
        b.dataset.cmd = c.id
        b.title = [c.tooltip ?? c.label, c.shortcut ? `(${c.shortcut})` : ''].join(' ').trim()
        b.addEventListener('click', () => this.run(c))
        this.buttons.set(c.id, b)
        row.append(b)
      }
      // Shown instead of the row when the window is too narrow for the group.
      const drop = h('button', 'cmd group-drop')
      drop.innerHTML = `${g.commands[0]?.icon ?? ''}<span>${g.label.replace(/\s*\(.*\)/, '')} ▾</span>`
      drop.title = g.commands.map((c) => c.label).join(', ')
      drop.addEventListener('click', (e) => {
        e.stopPropagation()
        this.openGroupMenu(drop, g.commands)
      })
      group.append(row, drop, h('div', 'ribbon-label', g.label))
      r.append(group)
    }
    this.refreshRibbon()
    this.fitRibbon()
  }

  /**
   * Make the ribbon fit the window instead of scrolling: first tighter
   * buttons, then long groups fold into drop-down buttons, then icons only,
   * then the other groups fold too (rightmost first).
   */
  private fitRibbon(): void {
    const r = this.els.ribbon
    const groups = [...r.querySelectorAll<HTMLElement>('.ribbon-group')]
    r.classList.remove('compact', 'icons')
    groups.forEach((g) => g.classList.remove('collapsed'))
    const fits = (): boolean => r.scrollWidth <= r.clientWidth + 1
    if (fits()) return
    r.classList.add('compact')
    if (fits()) return
    // Long groups (e.g. the export formats) fold first, biggest first.
    const size = (g: HTMLElement): number => g.querySelectorAll('.ribbon-row .cmd').length
    for (const g of [...groups].filter((g) => size(g) >= 4).sort((a, b) => size(b) - size(a))) {
      g.classList.add('collapsed')
      if (fits()) return
    }
    r.classList.add('icons')
    if (fits()) return
    for (const g of [...groups].reverse()) {
      if (g.querySelectorAll('.ribbon-row .cmd').length < 2) continue
      g.classList.add('collapsed')
      if (fits()) return
    }
  }

  private openGroupMenu(anchor: HTMLElement, commands: Command[]): void {
    document.querySelector('.menu.group-menu')?.remove()
    const m = h('div', 'menu group-menu')
    for (const c of commands) {
      const b = h('button', 'menu-item')
      b.innerHTML = `<span class="mi-icon">${c.icon}</span><span class="mi-label">${c.label}</span><span class="mi-key">${c.shortcut ?? ''}</span>`
      b.disabled = c.isEnabled ? !c.isEnabled(this.ctx) : false
      if (c.isActive?.(this.ctx)) b.classList.add('on')
      b.addEventListener('click', () => {
        close()
        void this.run(c)
      })
      m.append(b)
    }
    const rect = anchor.getBoundingClientRect()
    m.style.left = `${Math.min(rect.left, window.innerWidth - 240)}px`
    m.style.top = `${rect.bottom + 2}px`
    document.body.append(m)
    const close = (): void => {
      m.remove()
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('keydown', esc, true)
    }
    const outside = (e: Event): void => {
      if (!m.contains(e.target as Node)) close()
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', esc, true)
  }

  refreshRibbon(): void {
    for (const [id, b] of this.buttons) {
      const c = this.commands.get(id)!
      b.disabled = c.isEnabled ? !c.isEnabled(this.ctx) : false
      b.classList.toggle('on', c.isActive?.(this.ctx) ?? false)
    }
  }

  async run(c: Command): Promise<void> {
    if (c.isEnabled && !c.isEnabled(this.ctx)) return
    try {
      await c.run(this.ctx)
    } catch (e) {
      console.error(e)
      this.setStatus(`${c.label} failed: ${(e as Error).message ?? e}`, 'error')
    }
    this.refreshRibbon()
  }

  private bindShortcuts(): void {
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement
      if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return
      if (document.querySelector('.modal-backdrop')) return
      if (e.ctrlKey && e.key === ',') {
        e.preventDefault()
        openSettings()
        return
      }
      const combo = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', normKey(e.key)]
        .filter(Boolean)
        .join('+')
      for (const c of this.commands.values()) {
        const keys = [c.shortcut, c.altShortcut].filter(Boolean).map((k) => k!.toLowerCase())
        if (keys.includes(combo.toLowerCase())) {
          e.preventDefault()
          this.run(c)
          return
        }
      }
    })
  }

  // ---- model tree & status ----------------------------------------------

  private bindDocument(): void {
    const render = (): void => {
      const tree = this.els.tree
      tree.innerHTML = ''
      this.rowsById.clear()
      this.els.docName.textContent = this.doc.name + (this.doc.history.dirty && (!this.doc.isEmpty() || this.doc.sketches.length > 0) ? ' •' : '')
      this.els.docName.title = this.doc.filePath ?? this.doc.name
      if (this.doc.isEmpty()) {
        let extra = 0
        for (const sec of treeSections()) extra += sec.render(tree)
        if (!extra) tree.append(h('li', 'tree-empty', 'Nothing here yet. Import a file or add a shape from the Home tab.'))
        return
      }
      const sel = new Set(this.doc.selection())
      this.els.tree.parentElement!.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((b) =>
        b.classList.toggle('on', b.dataset.view === this.treeView)
      )
      if (this.treeView === 'layers') {
        this.renderLayers(sel)
        tree.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
        return
      }
      const row = (n: DocNode, depth: number): void => {
        const li = h('li', `tree-item kind-${n.kind}`)
        li.style.setProperty('--depth', String(depth))
        li.classList.toggle('selected', sel.has(n.id))
        li.classList.toggle('hidden-item', !this.doc.isShown(n))
        const twisty = h('button', 'tree-twisty', n.children.length ? icons.chevron : '')
        if (n.children.length) {
          twisty.classList.toggle('open', n.expanded)
          twisty.title = n.expanded ? 'Collapse' : 'Expand'
          twisty.addEventListener('click', (e) => {
            e.stopPropagation()
            this.doc.setExpanded(n.id, !n.expanded)
          })
        } else twisty.disabled = true
        const kindIcon = h(
          'span',
          'tree-icon',
          n.kind === 'file' ? icons.file : n.kind === 'assembly' ? icons.assembly : n.kind === 'part' ? icons.part : n.object.userData.wireBody ? icons.curve : icons.box
        )
        const label = h('span', 'tree-label')
        label.textContent = n.name
        label.title = [n.source ?? n.name, n.layers?.length ? `Layer: ${n.layers.join(', ')}` : ''].filter(Boolean).join('\n')
        const kind = h('span', 'tree-kind')
        const bodies = n.kind === 'body' ? 0 : this.doc.bodies(n).length
        const layer = n.layers?.length ? `L: ${n.layers[0]}${n.layers.length > 1 ? '…' : ''}` : ''
        kind.textContent =
          n.kind === 'body'
            ? (n.detail ?? layer)
            : [n.detail, layer, `${bodies} ${bodies === 1 ? 'body' : 'bodies'}`].filter(Boolean).join(' · ')
        const visible = n.object.visible
        const eye = h('button', 'tree-eye', visible ? icons.eye : icons.eyeOff)
        eye.title = visible ? 'Hide' : 'Show'
        eye.addEventListener('click', (e) => {
          e.stopPropagation()
          this.doc.setVisible(n.id, !visible)
        })
        li.append(twisty, kindIcon, label, kind, eye)
        li.addEventListener('click', (e) => this.doc.select([n.id], e.ctrlKey || e.shiftKey))
        li.addEventListener('dblclick', (e) => {
          if ((e.target as HTMLElement).closest('button')) return
          this.renameInline(label, n.id)
        })
        tree.append(li)
        this.rowsById.set(n.id, [li])
        if (n.expanded) n.children.forEach((c) => row(c, depth + 1))
      }
      this.doc.roots.forEach((r) => row(r, 0))
      for (const sec of treeSections()) sec.render(tree)
      tree.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
    }
    setTreeRefresher(render)
    this.doc.on('changed', () => {
      render()
      this.renderProps()
      this.refreshRibbon()
    })
    this.doc.on('selection', (ids) => {
      // Fast path: every selected row is already on screen, so just restyle.
      if (this.treeView === 'tree' && ids.every((id) => this.rowsById.has(id))) {
        const sel = new Set(ids)
        for (const [id, rows] of this.rowsById) for (const r of rows) r.classList.toggle('selected', sel.has(id))
        this.els.tree.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
      } else render()
      this.renderProps()
      this.refreshRibbon()
    })
    this.viewport.on('settings', () => this.refreshRibbon())
    this.viewport.on('cursor', (p) => {
      this.els.cursor.textContent = p ? `X ${fmt(p.x)}   Y ${fmt(p.y)}   Z 0.000` : ''
    })
    render()
    this.renderProps()
  }

  /** The model grouped by layer, like the Layers tree in VISI / layer managers in other CAD. */
  private renderLayers(sel: Set<string>): void {
    const tree = this.els.tree
    const map = this.doc.layerMap()
    const names = [...map.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, undefined, { numeric: true })))
    if (names.length === 1 && names[0] === '') {
      tree.append(h('li', 'tree-empty', 'No layers in this model. Files from VISI, Cimatron, NX, IGES and many STEP exporters keep their layers; they appear here.'))
    }
    for (const name of names) {
      const bodies = map.get(name)!
      const key = name || '\u0000none'
      const open = this.openLayers.has(key)
      const shown = bodies.filter((b) => this.doc.isShown(b)).length
      const li = h('li', 'tree-item kind-layer')
      li.style.setProperty('--depth', '0')
      li.classList.toggle('hidden-item', shown === 0)
      li.classList.toggle('selected', bodies.every((b) => sel.has(b.id)))
      const twisty = h('button', 'tree-twisty', icons.chevron)
      twisty.classList.toggle('open', open)
      twisty.addEventListener('click', (e) => {
        e.stopPropagation()
        if (open) this.openLayers.delete(key)
        else this.openLayers.add(key)
        this.doc.emit('changed', undefined)
      })
      const label = h('span', 'tree-label')
      label.textContent = name || 'No layer'
      const kind = h('span', 'tree-kind', `${bodies.length} ${bodies.length === 1 ? 'body' : 'bodies'}`)
      const eye = h('button', 'tree-eye', shown ? icons.eye : icons.eyeOff)
      eye.title = shown ? 'Hide layer' : 'Show layer'
      eye.addEventListener('click', (e) => {
        e.stopPropagation()
        if (shown) this.doc.setVisible(bodies.map((b) => b.id), false)
        else {
          // Showing a layer also reveals hidden parents of its bodies.
          const ids = new Set<string>()
          for (const b of bodies) for (let p: DocNode | null = b; p; p = p.parent) ids.add(p.id)
          this.doc.setVisible([...ids], true)
        }
      })
      li.append(twisty, h('span', 'tree-icon', icons.layers), label, kind, eye)
      li.addEventListener('click', (e) => this.doc.select(bodies.map((b) => b.id), e.ctrlKey || e.shiftKey))
      tree.append(li)
      if (!open) continue
      for (const b of bodies) {
        const row = h('li', 'tree-item kind-body')
        row.style.setProperty('--depth', '1')
        row.classList.toggle('selected', sel.has(b.id))
        row.classList.toggle('hidden-item', !this.doc.isShown(b))
        const lab = h('span', 'tree-label')
        lab.textContent = b.name
        const owner = b.parent && b.parent.kind !== 'file' ? b.parent.name : ''
        lab.title = [b.name, owner && `In ${owner}`].filter(Boolean).join('\n')
        const vis = b.object.visible
        const e2 = h('button', 'tree-eye', vis ? icons.eye : icons.eyeOff)
        e2.title = vis ? 'Hide' : 'Show'
        e2.addEventListener('click', (e) => {
          e.stopPropagation()
          this.doc.setVisible(b.id, !vis)
        })
        const sw = h('span', 'swatch')
        const c = colourOf(b.object)
        if (c) sw.style.background = c
        row.append(h('span', 'tree-twisty'), sw, lab, h('span', 'tree-kind', owner), e2)
        row.addEventListener('click', (e) => this.doc.select([b.id], e.ctrlKey || e.shiftKey))
        tree.append(row)
      }
    }
  }

  /** Properties of the current selection: names, product data, layers, colour and geometry. */
  private renderProps(): void {
    const body = this.els.propsBody
    if (!this.els.props.classList.contains('open')) return
    const sel = this.doc.selectedTopNodes()
    const rows: [string, string][] = []
    const section = (title: string): void => {
      rows.push(['§', title])
    }
    const add = (k: string, v: string | undefined | null): void => {
      if (v) rows.push([k, esc(v)])
    }
    if (!sel.length) {
      if (this.doc.isEmpty()) {
        body.innerHTML = `<p class="props-empty">Select something in the tree or the viewport to see its properties.</p>`
        return
      }
      const layers = [...this.doc.layerMap().keys()].filter(Boolean)
      section('Document')
      add('Files', String(this.doc.roots.filter((r) => r.kind === 'file').length))
      add('Bodies', String(this.doc.bodies().length))
      if (layers.length) add('Layers', layers.join(', '))
      rows.push(['', '<span class="props-hint">Select an item to see its properties.</span>'])
    } else if (sel.length === 1) {
      const n = sel[0]
      const wire = !!n.object.userData.wireBody
      section('General')
      add('Name', n.name)
      add('Type', n.kind === 'body' ? (wire ? 'Wireframe' : n.object.userData.solid === false ? 'Surface body' : 'Solid body') : n.kind[0].toUpperCase() + n.kind.slice(1))
      if (n.kind === 'file') {
        add('Format', n.detail)
        add('File', n.source)
      } else if (n.detail) add('Shape', n.detail)
      let file: DocNode = n
      while (file.parent) file = file.parent
      if (file !== n && file.kind === 'file') add('From file', file.source ?? file.name)
      const layers = this.doc.layersOf(n)
      add(layers.length > 1 ? 'Layers' : 'Layer', layers.join(', '))
      if (n.kind === 'body') {
        const c = colourOf(n.object)
        if (c) rows.push(['Colour', `<span class="swatch" style="background:${c}"></span> ${c.toUpperCase()}${faceColours(n.object) > 1 ? ` <span class="props-hint">+ ${faceColours(n.object) - 1} face colour${faceColours(n.object) > 2 ? 's' : ''}</span>` : ''}`])
      }
      if (n.props && n.kind !== 'file') {
        section('Product')
        for (const [k, v] of Object.entries(n.props)) add(k, v)
      }
      if (n.kind === 'file' && n.props) {
        section('File header')
        for (const [k, v] of Object.entries(n.props)) add(k, v)
      }
    } else {
      section('Selection')
      add('Items', String(sel.length))
    }
    if (sel.length) {
      const key = sel.map((n) => n.id).join(',')
      if (this.measureCache.key !== key) this.measureCache = { key, value: this.doc.measure(sel) }
      const m = this.measureCache.value!
      section('Geometry')
      if (sel.length > 1 || sel[0].kind !== 'body') add('Bodies', String(m.bodies))
      if (m.size) add('Size X × Y × Z', `${num(m.size.x)} × ${num(m.size.y)} × ${num(m.size.z)} mm`)
      if (m.area) add('Surface area', `${num(m.area, 2)} mm²`)
      if (m.volume) add('Volume', `${num(m.volume, 2)} mm³`)
      if (m.triangles) add('Triangles', num(m.triangles, 0))
    }
    body.innerHTML =
      '<dl class="props-list">' +
      rows
        .map(([k, v]) => (k === '§' ? `<dt class="props-section">${esc(v)}</dt>` : `<dt>${esc(k)}</dt><dd>${v}</dd>`))
        .join('') +
      '</dl>'
  }

  private renameInline(label: HTMLElement, id: string): void {
    const input = h('input', 'tree-rename')
    input.value = label.textContent ?? ''
    label.replaceWith(input)
    input.focus()
    input.select()
    const done = (commit: boolean): void => {
      if (commit && input.value.trim()) this.doc.rename(id, input.value.trim())
      else this.doc.emit('changed', undefined)
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true)
      if (e.key === 'Escape') done(false)
    })
    input.addEventListener('blur', () => done(true))
  }

  setStatus(message: string, kind: StatusKind = 'info'): void {
    const el = this.els.status
    el.textContent = message
    el.dataset.kind = kind
    clearTimeout(this.statusTimer)
    if (kind !== 'error')
      this.statusTimer = window.setTimeout(() => {
        el.textContent = 'Ready'
        el.dataset.kind = 'info'
      }, 6000)
  }

  // ---- updates -----------------------------------------------------------

  private async bindUpdates(): Promise<void> {
    const host = window.host
    if (!host) {
      this.els.version.textContent = 'browser preview'
      return
    }
    const info = await host.appInfo()
    this.els.version.textContent = `v${info.version}`
    const pill = this.els.update
    let manual = false
    const show = (s: UpdateStatus): void => {
      pill.hidden = true
      pill.className = 'update-pill'
      pill.onclick = null
      switch (s.state) {
        case 'downloading':
          pill.hidden = false
          pill.innerHTML = `${icons.update}<span>Downloading update ${s.percent}%</span>`
          break
        case 'ready':
          pill.hidden = false
          pill.classList.add('ready')
          pill.innerHTML = `${icons.update}<span>Update v${s.version} ready. Restart to apply</span>`
          pill.onclick = () => {
            if (this.doc.history.dirty && !this.doc.isEmpty() && !confirm(`Restart to update? Unsaved changes to ${this.doc.name} will be lost.`)) return
            // Say what's happening: the window closes, the update installs quietly, the app reopens.
            const cover = h('div', 'update-cover', `Installing v${s.version}… CADCAM Studio will reopen by itself in a few seconds.`)
            document.body.append(cover)
            requestAnimationFrame(() => setTimeout(() => void host.updates.install(), 50))
          }
          this.setStatus(`Version ${s.version} downloaded. Restart when convenient; it also installs when you close the app.`, 'success')
          break
        case 'not-available':
          if (manual) this.setStatus(`You're on the latest version (v${info.version}).`, 'success')
          manual = false
          break
        case 'error':
          console.warn('Update error:', s.message)
          pill.hidden = false
          pill.innerHTML = `${icons.update}<span>Update failed. Click to retry</span>`
          pill.title = s.message
          pill.onclick = () => host.updates.check()
          break
      }
    }
    // Clicking the version number checks for updates now.
    this.els.version.style.cursor = 'pointer'
    this.els.version.title = 'Click to check for updates'
    this.els.version.onclick = () => {
      manual = true
      this.setStatus('Checking for updates…')
      void host.updates.check()
    }
    host.updates.onStatus(show)
    show(await host.updates.status())
  }
}

function normKey(k: string): string {
  if (k === ' ') return 'Space'
  if (k.length === 1) return k.toUpperCase()
  return k
}

function fmt(n: number): string {
  return n.toFixed(3)
}

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
function safeSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* ignore */
  }
}

/** sRGB hex of a body's main colour (first material). */
function colourOf(o: THREE.Object3D): string | null {
  let found: string | null = null
  o.traverse((c) => {
    if (found || c.name === '__edges') return
    const m = (c as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
    const first = (Array.isArray(m) ? m[0] : m) as THREE.MeshStandardMaterial | undefined
    if (first?.color) found = '#' + first.color.getHexString()
  })
  return found
}

/** Number of distinct colours on a body's faces. */
function faceColours(o: THREE.Object3D): number {
  const m = (o as THREE.Mesh).material
  return Array.isArray(m) ? m.length : 1
}
