import { CadDocument, type DocNode } from './document'
import { icons } from './icons'
import type { CadModule, Command, ModuleContext, StatusKind } from './types'
import { Viewport } from './viewport'
import { openSettings } from './settingsDialog'
import type { UpdateStatus } from '../../../shared/ipc'

const TAB_KEY = 'cadcam.activeTab'

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
    'tabs' | 'ribbon' | 'tree' | 'status' | 'cursor' | 'version' | 'update' | 'docName',
    HTMLElement
  >
  private buttons = new Map<string, HTMLButtonElement>()
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
    title.append(docName, update, gear)

    const tabs = h('nav', 'tabs')
    tabs.setAttribute('role', 'tablist')
    const ribbon = h('section', 'ribbon')

    const work = h('main', 'workspace')
    const side = h('aside', 'sidebar')
    side.innerHTML = `<div class="panel-title">Model</div>`
    const tree = h('ul', 'tree')
    side.append(tree)
    const vpHost = h('div', 'viewport')
    work.append(side, vpHost)

    const status = h('footer', 'statusbar')
    const msg = h('span', 'status-msg', 'Ready')
    const cursor = h('span', 'status-cursor')
    const units = h('span', 'status-units', 'mm')
    const version = h('span', 'status-version')
    status.append(msg, cursor, units, version)

    root.append(title, tabs, ribbon, work, status)

    this.els = { tabs, ribbon, tree, status: msg, cursor, version, update, docName }

    this.viewport = new Viewport(vpHost, this.doc)
    this.ctx = {
      doc: this.doc,
      viewport: this.viewport,
      status: (m, k) => this.setStatus(m, k),
      refreshRibbon: () => this.refreshRibbon()
    }

    for (const m of this.modules)
      for (const g of m.groups) for (const c of g.commands) this.commands.set(c.id, c)

    this.buildTabs()
    this.bindShortcuts()
    this.bindDocument()
    this.bindUpdates()

    const saved = safeGet(TAB_KEY)
    this.activate(this.modules.find((m) => m.id === saved) ?? this.modules[0])
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
    for (const g of m.groups) {
      const group = h('div', 'ribbon-group')
      const row = h('div', 'ribbon-row')
      for (const c of g.commands) {
        const b = h('button', 'cmd')
        b.innerHTML = `${c.icon}<span>${c.label}</span>`
        b.title = [c.tooltip ?? c.label, c.shortcut ? `(${c.shortcut})` : ''].join(' ').trim()
        b.addEventListener('click', () => this.run(c))
        this.buttons.set(c.id, b)
        row.append(b)
      }
      group.append(row, h('div', 'ribbon-label', g.label))
      r.append(group)
    }
    this.refreshRibbon()
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
        if (c.shortcut && c.shortcut.toLowerCase() === combo.toLowerCase()) {
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
      this.els.docName.textContent = this.doc.name
      if (this.doc.isEmpty()) {
        tree.append(h('li', 'tree-empty', 'Nothing here yet. Import a file or add a shape from the Home tab.'))
        return
      }
      const sel = new Set(this.doc.selection())
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
        const kindIcon = h('span', 'tree-icon', n.kind === 'file' ? icons.file : n.kind === 'assembly' ? icons.assembly : icons.box)
        const label = h('span', 'tree-label')
        label.textContent = n.name
        label.title = n.source ?? n.name
        const kind = h('span', 'tree-kind')
        const bodies = n.kind === 'body' ? 0 : this.doc.bodies(n).length
        kind.textContent = n.kind === 'body' ? (n.detail ?? '') : [n.detail, `${bodies} ${bodies === 1 ? 'body' : 'bodies'}`].filter(Boolean).join(' · ')
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
        if (n.expanded) n.children.forEach((c) => row(c, depth + 1))
      }
      this.doc.roots.forEach((r) => row(r, 0))
      tree.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
    }
    this.doc.on('changed', () => {
      render()
      this.refreshRibbon()
    })
    this.doc.on('selection', () => {
      render()
      this.refreshRibbon()
    })
    this.viewport.on('pick', ({ id, additive }) => {
      if (id) this.doc.select([id], additive)
      else if (!additive) this.doc.select([])
    })
    this.viewport.on('settings', () => this.refreshRibbon())
    this.viewport.on('cursor', (p) => {
      this.els.cursor.textContent = p ? `X ${fmt(p.x)}   Y ${fmt(p.y)}   Z 0.000` : ''
    })
    render()
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
          pill.onclick = () => host.updates.install()
          this.setStatus(`Version ${s.version} downloaded. Restart when convenient; it also installs when you close the app.`, 'success')
          break
        case 'error':
          console.warn('Update error:', s.message)
          break
      }
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
