import * as THREE from 'three'
import type { ModuleContext } from '@/core/types'
import { solidCad } from '@/core/occt'
import { Highlights, pickAt, rowMajor, type Pick } from '@/core/picking'
import { selection } from '@/core/selection'
import { showCmdBar } from '@/core/cmdbar'
import { el, fmt } from '@/core/toolpanel'
import { bodyName, checkBox, geometryOf, MODE_COLOUR, previewMaterial, strSeg } from './common'

/**
 * Add / Cut / Intersect bodies. The first body picked is the target (it keeps
 * its name and place in the tree); the rest are tools. Bodies already
 * selected are used straight away. The exact result previews as soon as both
 * are picked; the tick applies it as one undo step. Tool bodies are used up
 * unless Keep tools is on.
 */

export type BoolOp = 'fuse' | 'cut' | 'common'
const LABEL: Record<BoolOp, string> = { fuse: 'Add', cut: 'Cut', common: 'Intersect' }

let active: BooleanTool | null = null

export function openBoolean(ctx: ModuleContext, op: BoolOp): void {
  active?.close()
  const pre: THREE.Mesh[] = []
  for (const p of selection.items) {
    const m = p.object as THREE.Mesh
    if (m.isMesh && m.geometry?.userData.brep && !pre.includes(m)) pre.push(m)
  }
  active = new BooleanTool(ctx, op, pre)
}

const bodyPick = (m: THREE.Mesh): Pick => ({ kind: 'body', object: m, index: -1, point: new THREE.Vector3() })

class BooleanTool {
  private target: THREE.Mesh | null
  private tools: THREE.Mesh[]
  private keep = false
  private hl: Highlights
  private prompt = el('div', 'vp-prompt above-strip')
  private strip = el('div', 'vp-strip part-strip')
  private targetText = el('span', 'vs-label part-target')
  private toolsText = el('span', 'vs-label')
  private seg!: { el: HTMLElement; set(v: BoolOp): void }
  private preview: THREE.Mesh | null = null
  private result: THREE.BufferGeometry | null = null
  private runId = 0
  private busy = false
  private note = ''
  private off: (() => void)[] = []

  constructor(
    private ctx: ModuleContext,
    private op: BoolOp,
    pre: THREE.Mesh[]
  ) {
    const vp = ctx.viewport
    this.target = pre[0] ?? null
    this.tools = pre.slice(1)
    this.hl = new Highlights(vp)
    this.off.push(() => this.hl.dispose())
    vp.host.append(this.prompt, this.strip)
    vp.blockPick = () => true
    const bar = showCmdBar(vp.host, { ok: () => void this.ok(), cancel: () => this.close(), back: () => this.back() })
    this.off.push(() => bar.dispose())
    this.build()
    const canvas = vp.renderer.domElement
    let down: { x: number; y: number } | null = null
    const onDown = (e: PointerEvent): void => void (down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null)
    const onUp = (e: PointerEvent): void => {
      if (e.button !== 0 || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
      down = null
      const p = pickAt(vp, e, { body: true, face: true })
      const m = p?.object as THREE.Mesh | undefined
      if (!m?.isMesh) return
      if (!m.geometry.userData.brep) return this.say('That body is a mesh only (no CAD faces).')
      this.toggle(m)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') this.close()
      else if (e.key === 'Enter') void this.ok()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey, true)
    this.off.push(() => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey, true)
    })
    this.changed()
  }

  private build(): void {
    const s = this.strip
    s.addEventListener('pointerdown', (e) => e.stopPropagation())
    s.append(el('b', 'vs-title', 'Combine'))
    const g = el('div', 'vs-group')
    this.seg = strSeg<BoolOp>(
      [
        ['fuse', 'Add', 'Join the tools onto the target'],
        ['cut', 'Cut', 'Take the tools away from the target'],
        ['common', 'Intersect', 'Keep only where target and tools overlap']
      ],
      this.op,
      (v) => {
        this.op = v
        this.changed()
      }
    )
    g.append(this.seg.el)
    const t = el('div', 'vs-group')
    t.append(el('span', 'vs-label', 'Target'), this.targetText)
    const tl = el('div', 'vs-group')
    tl.append(el('span', 'vs-label', 'Tools'), this.toolsText)
    const keep = checkBox('Keep tools', 'Leave the tool bodies in place after the boolean', this.keep, (v) => (this.keep = v))
    tl.append(keep.label)
    s.append(g, el('span', 'vs-sep'), t, tl)
  }

  private say(note?: string): void {
    const main = el('span')
    const what = !this.target ? 'click the target body (the one that is kept)' : !this.tools.length ? `click the bodies to ${this.op === 'fuse' ? 'add' : this.op === 'cut' ? 'cut away' : 'intersect with'}` : 'click bodies to add / remove tools'
    main.append(el('b', '', LABEL[this.op]), document.createTextNode(`: ${what}`))
    this.prompt.replaceChildren(main)
    const n = note ?? this.note
    if (n) this.prompt.append(el('span', 'vp-prompt-note', n))
    this.prompt.append(el('span', 'vp-prompt-esc', 'Enter / tick to apply, Esc to cancel'))
    // Sit just above the strip, however many rows it takes.
    requestAnimationFrame(() => (this.prompt.style.bottom = `${this.strip.offsetHeight + 64}px`))
  }

  private toggle(m: THREE.Mesh): void {
    if (!this.target) this.target = m
    else if (m === this.target) {
      // Clicking the target again with no tools lets it go.
      if (this.tools.length) return this.say('That is the target. Click other bodies for tools, or Back to pick another target.')
      this.target = null
    } else if (this.tools.includes(m)) this.tools = this.tools.filter((x) => x !== m)
    else this.tools.push(m)
    this.changed()
  }

  private back(): void {
    if (this.tools.length) this.tools.pop()
    else this.target = null
    this.changed()
  }

  private changed(): void {
    this.seg.set(this.op)
    this.targetText.textContent = this.target ? bodyName(this.ctx, this.target) : 'none'
    this.toolsText.textContent = this.tools.length ? (this.tools.length === 1 ? bodyName(this.ctx, this.tools[0]) : `${this.tools.length} bodies`) : 'none'
    const list = this.target ? [{ pick: bodyPick(this.target), color: 0xff9f1c }] : []
    for (const t of this.tools) list.push({ pick: bodyPick(t), color: MODE_COLOUR[this.op] })
    this.hl.set(list)
    this.result = null
    this.note = ''
    this.setPreview(null)
    this.say()
    void this.compute()
  }

  private setPreview(geo: THREE.BufferGeometry | null, keep = false): void {
    if (this.preview) {
      this.ctx.viewport.scene.remove(this.preview)
      if (!this.preview.userData.keep) this.preview.geometry.dispose()
      ;(this.preview.material as THREE.Material).dispose()
      this.preview = null
    }
    const hide = [this.target, ...this.tools].filter((m): m is THREE.Mesh => !!m)
    for (const m of hide) m.visible = !geo
    if (geo) {
      this.preview = new THREE.Mesh(geo, previewMaterial(0xff9f1c, 0.8))
      this.preview.userData.keep = keep
      this.preview.raycast = () => {}
      this.ctx.viewport.scene.add(this.preview)
      this.hl.set([])
    }
    this.ctx.viewport.requestRender()
  }

  private async compute(): Promise<THREE.BufferGeometry | null> {
    const id = ++this.runId
    if (!this.target || !this.tools.length) return null
    this.busy = true
    this.say('Working…')
    try {
      const t = this.target
      t.updateMatrixWorld()
      const inv = t.matrixWorld.clone().invert()
      const bodies = [t, ...this.tools].map((m, i) => {
        m.updateMatrixWorld()
        const rel = inv.clone().multiply(m.matrixWorld)
        return { brep: m.geometry.userData.brep as Uint8Array, ...(i ? { matrix: rowMajor(rel) } : {}) }
      })
      const res = await solidCad(bodies, { op: this.op, target: 0, tools: this.tools.map((_, i) => i + 1) })
      const geo = await geometryOf(res.brep)
      if (id !== this.runId) return null
      geo.applyMatrix4(t.matrixWorld)
      this.result = geo
      this.busy = false
      this.note = `${res.solids > 1 ? `${res.solids} solids, ` : ''}volume ${fmt(res.volume, 1)} mm³`
      this.setPreview(geo)
      this.say()
      return geo
    } catch (e) {
      if (id === this.runId) {
        this.busy = false
        this.note = (e as Error).message
        this.say()
      }
      return null
    }
  }

  private async ok(): Promise<void> {
    if (!this.target || !this.tools.length) return this.say('Pick a target and at least one tool.')
    let geo = this.result
    if (!geo) {
      const id = this.runId
      while (this.busy && id === this.runId) await new Promise((r) => setTimeout(r, 50))
      geo = this.result ?? (await this.compute())
    }
    if (!geo) return
    const doc = this.ctx.doc
    const target = this.target
    const tools = [...this.tools]
    const op = this.op
    const keep = this.keep
    if (this.preview) this.preview.userData.keep = true
    this.close()
    selection.clear()
    geo.applyMatrix4(target.matrixWorld.clone().invert())
    geo.computeBoundingBox()
    delete geo.userData.prim
    doc.history.batch(`${LABEL[op]} bodies`, () => {
      doc.replaceGeometry(target.userData.docId as string, geo!, LABEL[op] === 'Add' ? 'Add onto' : LABEL[op] === 'Cut' ? 'Cut from' : 'Intersect')
      if (!keep) doc.removeMany(tools.map((m) => m.userData.docId as string))
    })
    this.ctx.status(`${LABEL[op]}: done`, 'success')
  }

  close(): void {
    if (active !== this) return
    active = null
    this.runId++
    this.setPreview(null)
    this.off.forEach((f) => f())
    this.prompt.remove()
    this.strip.remove()
    this.ctx.viewport.blockPick = null
    this.ctx.refreshRibbon()
  }
}
