import * as THREE from 'three'
import type { ModuleContext } from '@/core/types'
import { modifyCad, type ModifyResult, type ModifySpec, type Vec3 } from '@/core/occt'
import { Highlights, isSheet, pickAt, pickKey, type Pick } from '@/core/picking'
import { selection } from '@/core/selection'
import { showCmdBar } from '@/core/cmdbar'
import { el, fmt } from '@/core/toolpanel'
import { Handles, type ArrowSpec, type RingSpec } from '@/core/handles'
import { partMaterial } from '@/core/io'
import { checkBox, geometryOf, numberBox, previewMaterial, strSeg } from './common'

/**
 * Modify commands on one body: Fillet and Chamfer (edges), Shell, Draft and
 * Thicken (faces), Offset (the whole body). Pick edges / faces (those already
 * selected are used straight away), type the value or drag the handle; the
 * exact result previews live from the kernel while you drag. When the kernel
 * can't do it, the prompt says why in plain words, the edges / faces at fault
 * turn red, and if there is a value that would work it is offered.
 */

export type ModifyKind = 'fillet' | 'chamfer' | 'shell' | 'offset' | 'thicken' | 'draft'

const TITLE: Record<ModifyKind, string> = { fillet: 'Fillet', chamfer: 'Chamfer', shell: 'Shell', offset: 'Offset', thicken: 'Thicken', draft: 'Draft' }
const PICKS: Record<ModifyKind, 'edge' | 'face'> = { fillet: 'edge', chamfer: 'edge', shell: 'face', offset: 'face', thicken: 'face', draft: 'face' }
const DEFAULT: Record<ModifyKind, number> = { fillet: 2, chamfer: 1, shell: 2, offset: 1, thicken: 2, draft: 3 }
const UNIT: Record<ModifyKind, string> = { fillet: 'mm', chamfer: 'mm', shell: 'mm', offset: 'mm', thicken: 'mm', draft: '°' }
const LABEL: Record<ModifyKind, string> = { fillet: 'Radius', chamfer: 'Distance', shell: 'Wall', offset: 'Distance', thicken: 'Thickness', draft: 'Angle' }
const ASK: Record<ModifyKind, string> = {
  fillet: 'click the edges to round',
  chamfer: 'click the edges to chamfer',
  shell: 'click the faces to leave open',
  offset: 'click a face of the body to grow or shrink',
  thicken: 'click the faces to thicken',
  draft: 'click the walls to draft'
}
/** Last values used, so the next run starts where you left off. */
const last: Partial<Record<ModifyKind, number>> = {}

const BAD = 0xff3b30
const PICKED = 0xff9f1c
const HOVER = 0xfff1a8

let active: ModifyTool | null = null
export const isModifying = (): boolean => active !== null

export function openModify(ctx: ModuleContext, kind: ModifyKind, start: Pick[] = []): void {
  active?.close()
  const want = PICKS[kind]
  const picks = (start.length ? start : selection.items).filter((p) => p.kind === want && (p.object as THREE.Mesh).geometry?.userData.brep)
  active = new ModifyTool(ctx, kind, picks)
}

class ModifyTool {
  private picks: Pick[] = []
  private value: number
  private value2: number | null = null
  private chamferMode: 'equal' | 'two' | 'angle' = 'equal'
  private outward = false
  private neutral: 'bottom' | 'top' | 'plane' = 'bottom'
  private flipPull = false
  private hl: Highlights
  private hover: Pick | null = null
  private prompt = el('div', 'vp-prompt above-strip')
  private strip = el('div', 'vp-strip part-strip')
  private box!: HTMLInputElement
  private box2: HTMLInputElement | null = null
  private box2Group: HTMLElement | null = null
  private preview: THREE.Mesh | null = null
  private result: { geo: THREE.BufferGeometry; res: ModifyResult } | null = null
  private failure: Extract<ModifyResult, { error: string }> | null = null
  /** Latest-wins kernel calls: one in flight at a time, the newest values next. */
  private inFlight = false
  private dirty = false
  private gen = 0
  private timer = 0
  private handles: Handles
  private arrow: ArrowSpec | null = null
  private ring: RingSpec | null = null
  private off: (() => void)[] = []

  constructor(
    private ctx: ModuleContext,
    private kind: ModifyKind,
    start: Pick[]
  ) {
    const vp = ctx.viewport
    this.value = last[kind] ?? DEFAULT[kind]
    this.hl = new Highlights(vp)
    const body = start[0]?.object
    this.picks = start.filter((p) => p.object === body)
    if (kind === 'offset') this.picks = this.picks.slice(0, 1)
    vp.host.append(this.prompt, this.strip)
    vp.blockPick = () => true
    this.buildStrip()
    this.handles = new Handles(vp)
    this.off.push(() => this.handles.dispose(), () => this.hl.dispose())
    const bar = showCmdBar(vp.host, { ok: () => void this.ok(), cancel: () => this.close(), back: () => this.back() })
    this.off.push(() => bar.dispose())

    const canvas = vp.renderer.domElement
    let down: { x: number; y: number } | null = null
    let queued: PointerEvent | null = null
    const filter = PICKS[kind] === 'edge' ? { edge: true } : { face: true }
    const onDown = (e: PointerEvent): void => void (down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null)
    const onUp = (e: PointerEvent): void => {
      if (e.button !== 0 || !down || this.handles.dragging || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
      down = null
      const p = pickAt(vp, e, filter)
      if (p && p.kind === PICKS[kind]) this.toggle(p)
    }
    const onMove = (e: PointerEvent): void => {
      const first = !queued
      queued = e
      if (!first) return
      requestAnimationFrame(() => {
        const ev = queued!
        queued = null
        const h = ev.buttons ? null : pickAt(vp, ev, filter)
        if ((h && pickKey(h)) !== (this.hover && pickKey(this.hover))) {
          this.hover = h && h.kind === PICKS[kind] ? h : null
          this.draw()
        }
      })
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
    canvas.addEventListener('pointermove', onMove)
    window.addEventListener('keydown', onKey, true)
    this.off.push(() => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointermove', onMove)
      window.removeEventListener('keydown', onKey, true)
    })
    this.placeHandle()
    this.changed()
    this.box.focus()
    this.box.select()
  }

  // ---- strip -----------------------------------------------------------------

  private buildStrip(): void {
    const s = this.strip
    const k = this.kind
    s.addEventListener('pointerdown', (e) => e.stopPropagation())
    s.append(el('b', 'vs-title', TITLE[k]))
    const main = numberBox(LABEL[k], UNIT[k], this.value, this.tip(), (v) => {
      this.value = v
      this.placeHandle()
      this.changed()
    })
    this.box = main.box
    s.append(main.group)
    if (k === 'fillet') {
      const g = el('div', 'vs-group')
      const vary = checkBox('Variable', 'Radius changes along each edge, from the first value at its start to the second at its end', false, (on) => {
        this.value2 = on ? this.value * 2 : null
        this.box2Group!.style.display = on ? '' : 'none'
        if (this.box2) this.box2.value = String(this.value2 ?? '')
        this.changed()
      })
      g.append(vary.label)
      const end = numberBox('to', 'mm', this.value * 2, 'Radius at the end of each edge', (v) => {
        this.value2 = v
        this.changed()
      })
      this.box2 = end.box
      this.box2Group = end.group
      end.group.style.display = 'none'
      s.append(el('span', 'vs-sep'), g, end.group)
    }
    if (k === 'chamfer') {
      const seg = strSeg<'equal' | 'two' | 'angle'>(
        [
          ['equal', 'Equal', 'Same distance back along both faces'],
          ['two', 'Two distances', 'A different distance on each face'],
          ['angle', 'Distance + angle', 'A distance and an angle from the first face']
        ],
        this.chamferMode,
        (v) => {
          this.chamferMode = v
          this.value2 = v === 'equal' ? null : v === 'two' ? this.value * 2 : 45
          this.box2Group!.style.display = v === 'equal' ? 'none' : ''
          this.box2Group!.querySelector('.vs-label')!.textContent = v === 'angle' ? 'Angle' : 'Second'
          this.box2Group!.querySelectorAll('.vs-label')[1]!.textContent = v === 'angle' ? '°' : 'mm'
          this.box2!.value = String(this.value2 ?? '')
          this.changed()
        }
      )
      const second = numberBox('Second', 'mm', this.value * 2, 'The other distance, or the angle', (v) => {
        this.value2 = v
        this.changed()
      })
      this.box2 = second.box
      this.box2Group = second.group
      second.group.style.display = 'none'
      s.append(el('span', 'vs-sep'), seg.el, second.group)
    }
    if (k === 'shell') {
      const out = checkBox('Outside', 'Walls grow outside the faces instead of inside', this.outward, (v) => {
        this.outward = v
        this.placeHandle()
        this.changed()
      })
      s.append(el('span', 'vs-sep'), out.label)
    }
    if (k === 'offset' || k === 'thicken') {
      const flip = el('button', 'btn vs-text', 'Flip')
      flip.title = k === 'offset' ? 'Grow / shrink' : 'Thicken the other way'
      flip.addEventListener('click', () => {
        this.value = -this.value
        this.box.value = fmt(this.value)
        this.placeHandle()
        this.changed()
      })
      s.append(flip)
    }
    if (k === 'draft') {
      const seg = strSeg<'bottom' | 'top' | 'plane'>(
        [
          ['bottom', 'Bottom', 'Walls hinge at their lowest edge (along the pull direction)'],
          ['top', 'Top', 'Walls hinge at their highest edge'],
          ['plane', 'Work plane', 'Walls hinge where they cross the active work plane']
        ],
        this.neutral,
        (v) => {
          this.neutral = v
          this.placeHandle()
          this.changed()
        }
      )
      const flip = el('button', 'btn vs-text', 'Flip pull')
      flip.title = 'Pull the other way (the work plane Z is the pull direction)'
      flip.addEventListener('click', () => {
        this.flipPull = !this.flipPull
        this.placeHandle()
        this.changed()
      })
      s.append(el('span', 'vs-sep'), el('span', 'vs-label', 'Hinge'), seg.el, flip)
    }
  }

  private tip(): string {
    switch (this.kind) {
      case 'fillet':
        return 'Fillet radius (mm). Tangent edges are followed automatically.'
      case 'chamfer':
        return 'Chamfer distance back from the edge (mm)'
      case 'shell':
        return 'Wall thickness (mm)'
      case 'offset':
        return 'mm: positive grows the body, negative shrinks it'
      case 'thicken':
        return 'mm along the face normals (negative: the other way)'
      case 'draft':
        return 'Draft angle (degrees): positive narrows the body along the pull direction'
    }
  }

  private say(note?: string, cls = ''): void {
    const main = el('span')
    const n = this.picks.length
    const what = PICKS[this.kind] === 'edge' ? 'edge' : 'face'
    const status = n && this.kind !== 'offset' ? `: ${n} ${what}${n === 1 ? '' : 's'}, click ${what}s to add or remove` : n ? ': drag the arrow or type the distance' : `: ${ASK[this.kind]}`
    main.append(el('b', '', TITLE[this.kind]), document.createTextNode(status))
    this.prompt.replaceChildren(main)
    if (note) this.prompt.append(el('span', `vp-prompt-note ${cls}`, note))
    const f = this.failure
    if (f && f.hint !== undefined && f.hint > 0) {
      const use = el('button', 'btn vs-text', `Use ${fmt(f.hint)}`)
      use.title = 'Set the value that fits'
      use.addEventListener('click', () => {
        this.value = f.hint!
        this.box.value = fmt(this.value)
        this.placeHandle()
        this.changed()
      })
      this.prompt.append(use)
    }
    this.prompt.append(el('span', 'vp-prompt-esc', 'Enter / tick to apply, Esc to cancel'))
    requestAnimationFrame(() => (this.prompt.style.bottom = `${this.strip.offsetHeight + 64}px`))
  }

  // ---- picking ------------------------------------------------------------------

  private toggle(p: Pick): void {
    if (this.picks.length && p.object !== this.picks[0].object) {
      if (this.kind !== 'offset') return this.say(`All the ${PICKS[this.kind]}s must be on the same body.`)
      this.picks = []
    }
    if (!(p.object as THREE.Mesh).geometry.userData.brep) return this.say('That body has no CAD faces (mesh only).')
    const k = pickKey(p)
    const i = this.picks.findIndex((f) => pickKey(f) === k)
    if (this.kind === 'offset') this.picks = [p]
    else this.picks = i >= 0 ? this.picks.filter((_, j) => j !== i) : [...this.picks, p]
    this.placeHandle()
    this.changed()
  }

  private back(): void {
    this.picks.pop()
    this.placeHandle()
    this.changed()
  }

  private draw(): void {
    const bad = new Set<string>()
    const mesh = this.picks[0]?.object
    const list: { pick: Pick; color: number }[] = []
    if (this.failure && mesh) {
      for (const e of this.failure.badEdges) {
        list.push({ pick: { kind: 'edge', object: mesh, index: e, point: new THREE.Vector3() }, color: BAD })
        bad.add(`edge:${e}`)
      }
      for (const f of this.failure.badFaces) {
        list.push({ pick: { kind: 'face', object: mesh, index: f, point: new THREE.Vector3() }, color: BAD })
        bad.add(`face:${f}`)
      }
    }
    for (const p of this.picks) if (!bad.has(`${p.kind}:${p.index}`)) list.push({ pick: p, color: PICKED })
    if (this.hover && !this.picks.some((f) => pickKey(f) === pickKey(this.hover!))) list.push({ pick: this.hover, color: HOVER })
    this.hl.set(list)
  }

  // ---- handles ------------------------------------------------------------------

  /** Where the handle sits and which way it points (world). */
  private handleFrame(): { origin: THREE.Vector3; dir: THREE.Vector3 } | null {
    const p = this.picks[0]
    if (!p) return null
    const mesh = p.object as THREE.Mesh
    if (p.kind === 'edge') return edgeFrame(mesh, p.index)
    if (!p.normal) return null
    return { origin: p.point.clone(), dir: p.normal.clone() }
  }

  private placeHandle(): void {
    const f = this.handleFrame()
    if (!f) {
      if (this.arrow) this.handles.remove(this.arrow)
      if (this.ring) this.handles.remove(this.ring)
      this.arrow = this.ring = null
      return
    }
    if (this.kind === 'draft') {
      const pull = this.pull()
      const axis = pull.clone().cross(f.dir).normalize()
      if (axis.lengthSq() < 1e-9) return
      if (!this.ring)
        this.ring = this.handles.ring({
          centre: f.origin.clone(),
          axis,
          value: this.value,
          tip: 'Drag to set the draft angle (Shift: no snap)',
          onDrag: (v) => {
            this.value = Math.round(v * 10) / 10
            this.box.value = fmt(this.value)
            this.changed()
          },
          onEnd: () => this.changed()
        })
      this.ring.centre.copy(f.origin)
      this.ring.axis.copy(axis)
      this.ring.value = this.value
      this.handles.update()
      return
    }
    // Shells grow into the body (unless outside); fillets / chamfers drag out from the corner.
    const dir = this.kind === 'shell' && !this.outward ? f.dir.clone().negate() : f.dir.clone()
    if (!this.arrow)
      this.arrow = this.handles.arrow({
        origin: f.origin.clone(),
        dir,
        value: this.value,
        tip: `Drag to set the ${LABEL[this.kind].toLowerCase()} (Shift: no snap)`,
        onDrag: (v) => {
          // Sizes can't go negative; offsets / thickness can (the other way).
          this.value = this.kind === 'offset' || this.kind === 'thicken' ? v : Math.max(0.01, v)
          this.box.value = fmt(this.value)
          this.changed()
        },
        onEnd: () => this.changed()
      })
    this.arrow.origin.copy(f.origin)
    this.arrow.dir.copy(dir)
    this.arrow.value = this.value
    this.handles.update()
  }

  /** Pull direction for drafts: the active work plane's Z (world). */
  private pull(): THREE.Vector3 {
    const z = new THREE.Vector3().setFromMatrixColumn(this.ctx.viewport.workplane, 2).normalize()
    return this.flipPull ? z.negate() : z
  }

  // ---- kernel -------------------------------------------------------------------

  private changed(): void {
    last[this.kind] = this.value
    this.result = null
    this.gen++
    this.draw()
    window.clearTimeout(this.timer)
    if (!this.picks.length) {
      this.failure = null
      this.setPreview(null)
      this.say()
      return
    }
    // While dragging, ask the kernel as fast as it answers; otherwise wait for typing to settle.
    if (this.handles.dragging) this.kick()
    else this.timer = window.setTimeout(() => this.kick(), 90)
  }

  private kick(): void {
    if (this.inFlight) {
      this.dirty = true
      return
    }
    void this.compute()
  }

  private spec(mesh: THREE.Mesh): ModifySpec | null {
    const v = this.value
    const idx = [...new Set(this.picks.map((p) => p.index))]
    switch (this.kind) {
      case 'fillet':
        if (!(v > 0)) return null
        return { op: 'fillet', edges: idx.map((edge) => ({ edge, r1: v, ...(this.value2 && this.value2 > 0 ? { r2: this.value2 } : {}) })) }
      case 'chamfer':
        if (!(v > 0)) return null
        return {
          op: 'chamfer',
          edges: idx.map((edge) => ({
            edge,
            r1: v,
            ...(this.chamferMode === 'two' && this.value2 ? { r2: this.value2 } : {}),
            ...(this.chamferMode === 'angle' && this.value2 ? { angle: this.value2 } : {})
          }))
        }
      case 'shell':
        return { op: 'shell', faces: idx, thickness: v, outward: this.outward }
      case 'offset':
        return { op: 'offset', distance: v }
      case 'thicken':
        return { op: 'thicken', faces: idx, distance: v }
      case 'draft': {
        // Into the body's own frame.
        mesh.updateMatrixWorld()
        const inv = mesh.matrixWorld.clone().invert()
        const pullW = this.pull()
        const pull = pullW.clone().transformDirection(inv)
        const origin = this.neutralPoint(mesh, pullW).applyMatrix4(inv)
        return { op: 'draft', faces: idx, angle: v, pull: pull.toArray() as Vec3, origin: origin.toArray() as Vec3 }
      }
    }
  }

  /** A point on the neutral plane (world): the picked faces' lowest / highest point along the pull, or the work plane origin. */
  private neutralPoint(mesh: THREE.Mesh, pull: THREE.Vector3): THREE.Vector3 {
    if (this.neutral === 'plane') return new THREE.Vector3().setFromMatrixPosition(this.ctx.viewport.workplane)
    const geo = mesh.geometry
    const pos = geo.getAttribute('position') as THREE.BufferAttribute
    const triFace = geo.userData.triFace as Int32Array
    const index = geo.index!
    const faces = new Set(this.picks.map((p) => p.index))
    let best: THREE.Vector3 | null = null
    let bestD = 0
    const v = new THREE.Vector3()
    for (let t = 0; t < triFace.length; t++) {
      if (!faces.has(triFace[t])) continue
      for (let j = 0; j < 3; j++) {
        v.fromBufferAttribute(pos, index.getX(t * 3 + j)).applyMatrix4(mesh.matrixWorld)
        const d = v.dot(pull) * (this.neutral === 'bottom' ? 1 : -1)
        if (!best || d < bestD) {
          best = v.clone()
          bestD = d
        }
      }
    }
    return best ?? new THREE.Vector3()
  }

  private async compute(): Promise<void> {
    const mesh = this.picks[0]?.object as THREE.Mesh | undefined
    if (!mesh) return
    const spec = this.spec(mesh)
    if (!spec) {
      this.say('Enter a value.')
      return
    }
    const gen = this.gen
    this.inFlight = true
    this.dirty = false
    this.say('Working…')
    try {
      const res = await modifyCad(mesh.geometry.userData.brep as Uint8Array, spec)
      // Values changed meanwhile: a newer call follows. Mid-drag, still show this one.
      const current = gen === this.gen
      if (res.error !== undefined) {
        if (!current) return
        this.failure = res
        this.result = null
        this.setPreview(null)
        this.draw()
        this.say(res.error, 'bad')
        return
      }
      if (!current && !this.dirty) return
      const geo = await geometryOf(res.brep)
      if (!this.picks.length || this.picks[0].object !== mesh) return geo.dispose()
      this.setPreview(geo, mesh)
      if (gen !== this.gen) return
      this.failure = null
      this.result = { geo, res }
      this.draw()
      const notes = res.notes.length ? ` (${res.notes.join('; ')})` : ''
      this.say(`${this.summary()}${notes}`)
    } catch (e) {
      this.failure = null
      this.setPreview(null)
      this.say((e as Error).message, 'bad')
    } finally {
      this.inFlight = false
      if (this.dirty) this.kick()
    }
  }

  private summary(): string {
    const v = fmt(Math.abs(this.value))
    switch (this.kind) {
      case 'fillet':
        return this.value2 ? `R${fmt(this.value)} to R${fmt(this.value2)}` : `R${v}`
      case 'chamfer':
        return this.chamferMode === 'equal' ? `${v} mm` : this.chamferMode === 'two' ? `${v} x ${fmt(this.value2 ?? 0)} mm` : `${v} mm at ${fmt(this.value2 ?? 0)}°`
      case 'shell':
        return `${v} mm walls${this.outward ? ', outside' : ''}`
      case 'offset':
        return `${this.value >= 0 ? 'Grow' : 'Shrink'} ${v} mm`
      case 'thicken':
        return `${v} mm thick`
      case 'draft':
        return `${fmt(this.value)}° draft`
    }
  }

  private setPreview(geo: THREE.BufferGeometry | null, mesh?: THREE.Mesh): void {
    if (this.preview) {
      this.ctx.viewport.scene.remove(this.preview)
      if (!this.preview.userData.keep) this.preview.geometry.dispose()
      ;(this.preview.material as THREE.Material).dispose()
      this.preview = null
    }
    const body = this.picks[0]?.object as THREE.Mesh | undefined
    // Thicken makes a new body beside the faces: keep the original showing.
    if (body && this.kind !== 'thicken') body.visible = !geo
    if (geo && mesh) {
      mesh.updateMatrixWorld()
      this.preview = new THREE.Mesh(geo, previewMaterial(PICKED, 0.85))
      this.preview.matrixAutoUpdate = false
      this.preview.matrix.copy(mesh.matrixWorld)
      this.preview.raycast = () => {}
      this.ctx.viewport.scene.add(this.preview)
    }
    this.ctx.viewport.requestRender()
  }

  private async ok(): Promise<void> {
    if (!this.picks.length) return this.say(`First ${ASK[this.kind]}.`)
    window.clearTimeout(this.timer)
    if (!this.result) {
      if (!this.inFlight) await this.compute()
      while (this.inFlight || this.dirty) {
        await new Promise((r) => setTimeout(r, 40))
        if (!this.inFlight && this.dirty) this.kick()
      }
    }
    const r = this.result
    if (!r) return
    const mesh = this.picks[0].object as THREE.Mesh
    const id = mesh.userData.docId as string
    const kind = this.kind
    const summary = this.summary()
    if (this.preview) this.preview.userData.keep = true
    const geo = r.geo
    delete geo.userData.prim
    // Thickening a surface body turns it into the solid; faces of a solid give a new body.
    const replace = kind !== 'thicken' || isSheet(mesh)
    this.close()
    selection.clear()
    if (replace) this.ctx.doc.replaceGeometry(id, geo, TITLE[kind])
    else {
      const m = new THREE.Mesh(geo, partMaterial())
      m.matrixAutoUpdate = mesh.matrixAutoUpdate
      mesh.updateMatrixWorld()
      m.applyMatrix4(mesh.matrixWorld)
      this.ctx.doc.addBody(m, `Thicken ${(thickenCount += 1)}`, 'thicken')
    }
    this.ctx.status(`${TITLE[kind]}: ${summary}`, 'success')
  }

  close(): void {
    if (active !== this) return
    active = null
    window.clearTimeout(this.timer)
    this.gen++
    this.setPreview(null)
    const body = this.picks[0]?.object
    if (body) body.visible = true
    this.off.forEach((f) => f())
    this.prompt.remove()
    this.strip.remove()
    this.ctx.viewport.blockPick = null
    this.ctx.refreshRibbon()
  }
}

let thickenCount = 0

/**
 * Handle frame for an edge (world): the middle of the edge, pointing out of
 * the corner along the average of the two faces' normals there.
 */
function edgeFrame(mesh: THREE.Mesh, edge: number): { origin: THREE.Vector3; dir: THREE.Vector3 } | null {
  const geo = mesh.geometry
  const segs = geo.userData.edgePositions as Float32Array | undefined
  const ranges = geo.userData.edgeRanges as Uint32Array | undefined
  if (!segs || !ranges) return null
  const first = ranges[edge * 2]
  const n = ranges[edge * 2 + 1]
  if (!n) return null
  const s = first + Math.floor(n / 2)
  const a = new THREE.Vector3(segs[s * 6], segs[s * 6 + 1], segs[s * 6 + 2])
  const b = new THREE.Vector3(segs[s * 6 + 3], segs[s * 6 + 4], segs[s * 6 + 5])
  const mid = n % 2 ? a.clone().add(b).multiplyScalar(0.5) : a.clone()
  // Faces touching that point: their triangle normals.
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const index = geo.index
  const triFace = geo.userData.triFace as Int32Array | undefined
  const dir = new THREE.Vector3()
  if (index && triFace) {
    geo.computeBoundingBox()
    const tol = Math.max(1e-4, geo.boundingBox!.getSize(new THREE.Vector3()).length() * 1e-4)
    const tri = new THREE.Triangle()
    const close = new THREE.Vector3()
    const seen = new Map<number, THREE.Vector3>()
    for (let t = 0; t < triFace.length; t++) {
      if (seen.has(triFace[t])) continue
      tri.a.fromBufferAttribute(pos, index.getX(t * 3))
      tri.b.fromBufferAttribute(pos, index.getX(t * 3 + 1))
      tri.c.fromBufferAttribute(pos, index.getX(t * 3 + 2))
      tri.closestPointToPoint(mid, close)
      if (close.distanceTo(mid) < tol) seen.set(triFace[t], tri.getNormal(new THREE.Vector3()))
    }
    seen.forEach((v) => dir.add(v))
  }
  if (dir.lengthSq() < 1e-12) dir.set(0, 0, 1)
  mesh.updateMatrixWorld()
  return { origin: mid.applyMatrix4(mesh.matrixWorld), dir: dir.normalize().transformDirection(mesh.matrixWorld) }
}
