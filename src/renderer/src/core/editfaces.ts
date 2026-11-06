import * as THREE from 'three'
import type { ModuleContext } from './types'
import { editFacesCad, readCadFile } from './occt'
import { Highlights, pickAt, pickKey, type Pick } from './picking'
import { selection } from './selection'
import { showCmdBar } from './cmdbar'
import { el, fmt } from './toolpanel'

/**
 * Edit faces: push / pull faces of a solid by a typed distance along their
 * normals (positive = out, adds material; negative = in, removes it). Starts
 * with the faces already selected (or the one right-clicked); click faces of
 * the same body to add / remove them. The result previews live; the tick
 * applies it as one undo step.
 */

let active: EditFacesTool | null = null
export const isEditingFaces = (): boolean => active !== null

export function openEditFaces(ctx: ModuleContext, start: Pick[] = []): void {
  if (active) return
  const faces = (start.length ? start : selection.items).filter((p) => p.kind === 'face' && (p.object as THREE.Mesh).geometry?.userData.brep)
  active = new EditFacesTool(ctx, faces)
}

const PREVIEW = new THREE.MeshStandardMaterial({ color: 0xff9f1c, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide })

class EditFacesTool {
  private faces: Pick[] = []
  private distance = 5
  private hl: Highlights
  private hover: Pick | null = null
  private prompt = el('div', 'vp-prompt')
  private strip = el('div', 'vp-strip editfaces-strip')
  private distBox = el('input')
  private preview: THREE.Mesh | null = null
  private result: THREE.BufferGeometry | null = null
  private runId = 0
  private timer = 0
  private busy = false
  private off: (() => void)[] = []

  constructor(
    private ctx: ModuleContext,
    start: Pick[]
  ) {
    const vp = ctx.viewport
    this.hl = new Highlights(vp)
    // Faces of one body only: the first one's.
    const body = start[0]?.object
    this.faces = start.filter((p) => p.object === body)
    vp.host.append(this.prompt, this.strip)
    vp.blockPick = () => true
    this.buildStrip()
    const bar = showCmdBar(vp.host, { ok: () => void this.ok(), cancel: () => this.close() })
    this.off.push(() => bar.dispose())

    const canvas = vp.renderer.domElement
    let down: { x: number; y: number } | null = null
    let queued: PointerEvent | null = null
    const onDown = (e: PointerEvent): void => void (down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null)
    const onUp = (e: PointerEvent): void => {
      if (e.button !== 0 || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
      down = null
      const p = pickAt(vp, e, { face: true })
      if (p?.kind === 'face') this.toggle(p)
    }
    const onMove = (e: PointerEvent): void => {
      const first = !queued
      queued = e
      if (!first) return
      requestAnimationFrame(() => {
        const ev = queued!
        queued = null
        const h = ev.buttons ? null : pickAt(vp, ev, { face: true })
        if ((h && pickKey(h)) !== (this.hover && pickKey(this.hover))) {
          this.hover = h
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
    this.draw()
    this.schedule()
    this.distBox.focus()
    this.distBox.select()
  }

  private buildStrip(): void {
    const s = this.strip
    s.addEventListener('pointerdown', (e) => e.stopPropagation())
    s.append(el('b', 'vs-title', 'Edit faces'))
    const g = el('div', 'vs-group')
    g.append(el('span', 'vs-label', 'Distance'))
    this.distBox.type = 'number'
    this.distBox.className = 'vs-angle'
    this.distBox.value = String(this.distance)
    this.distBox.title = 'mm along the face normal: positive pulls out (adds), negative pushes in (removes)'
    this.distBox.addEventListener('input', () => {
      const v = parseFloat(this.distBox.value)
      this.distance = Number.isFinite(v) ? v : 0
      this.schedule()
    })
    const flip = el('button', 'btn vs-text', 'Flip')
    flip.title = 'Swap out / in'
    flip.addEventListener('click', () => {
      this.distance = -this.distance
      this.distBox.value = String(this.distance)
      this.schedule()
    })
    g.append(this.distBox, el('span', 'vs-label', 'mm'), flip)
    s.append(g)
  }

  private say(note?: string): void {
    const main = el('span')
    const n = this.faces.length
    main.append(el('b', '', 'Edit faces'), document.createTextNode(n ? `: ${n} face${n === 1 ? '' : 's'}, click faces to add or remove` : ': select the faces to move'))
    this.prompt.replaceChildren(main)
    if (note) this.prompt.append(el('span', 'vp-prompt-note', note))
    this.prompt.append(el('span', 'vp-prompt-esc', 'Enter / tick to apply, Esc to cancel'))
  }

  private toggle(p: Pick): void {
    if (this.faces.length && p.object !== this.faces[0].object) return this.say('Faces must be on the same body.')
    if (!(p.object as THREE.Mesh).geometry.userData.brep) return this.say('That body has no CAD faces (mesh only).')
    const k = pickKey(p)
    const i = this.faces.findIndex((f) => pickKey(f) === k)
    this.faces = i >= 0 ? this.faces.filter((_, j) => j !== i) : [...this.faces, p]
    this.draw()
    this.schedule()
  }

  private draw(): void {
    const list = this.faces.map((pick) => ({ pick, color: 0xff9f1c }))
    if (this.hover && !this.faces.some((f) => pickKey(f) === pickKey(this.hover!))) list.push({ pick: this.hover, color: 0xfff1a8 })
    this.hl.set(list)
  }

  /** Recompute the preview shortly after the last change. */
  private schedule(): void {
    window.clearTimeout(this.timer)
    this.result = null
    this.say()
    this.timer = window.setTimeout(() => void this.compute(), 250)
  }

  private async compute(): Promise<THREE.BufferGeometry | null> {
    const id = ++this.runId
    this.clearPreview()
    if (!this.faces.length || !this.distance) return null
    const mesh = this.faces[0].object as THREE.Mesh
    this.busy = true
    this.say('Working…')
    try {
      const bytes = await editFacesCad(mesh.geometry.userData.brep as Uint8Array, [...new Set(this.faces.map((f) => f.index))], this.distance)
      const root = await readCadFile('brep', bytes.slice().buffer)
      if (id !== this.runId) return null
      root.updateMatrixWorld(true)
      let found: THREE.Mesh | null = null
      root.traverse((o) => {
        if (!found && (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.userData.brep) found = o as THREE.Mesh
      })
      if (!found) throw new Error('The edit gave no solid')
      const m = found as THREE.Mesh
      const geo = m.geometry
      // The kernel keeps the body's own placement inside the B-rep; bake any mesh placement in.
      if (!m.matrixWorld.equals(new THREE.Matrix4())) geo.applyMatrix4(m.matrixWorld)
      geo.computeBoundingBox()
      this.result = geo
      mesh.updateMatrixWorld()
      this.preview = new THREE.Mesh(geo, PREVIEW)
      this.preview.matrixAutoUpdate = false
      this.preview.matrix.copy(mesh.matrixWorld)
      this.preview.raycast = () => {}
      this.preview.renderOrder = 5
      this.ctx.viewport.scene.add(this.preview)
      this.say(`${this.distance > 0 ? 'Out' : 'In'} ${fmt(Math.abs(this.distance))} mm`)
      this.ctx.viewport.requestRender()
      return geo
    } catch (e) {
      if (id === this.runId) this.say((e as Error).message)
      return null
    } finally {
      if (id === this.runId) this.busy = false
    }
  }

  private clearPreview(): void {
    if (this.preview) this.ctx.viewport.scene.remove(this.preview)
    this.preview = null
    this.ctx.viewport.requestRender()
  }

  private async ok(): Promise<void> {
    if (!this.faces.length) return this.say('Select at least one face.')
    window.clearTimeout(this.timer)
    const geo = this.result ?? (this.busy ? null : await this.compute())
    if (!geo) {
      if (this.busy) this.say('Still working, try again in a moment.')
      return
    }
    const mesh = this.faces[0].object as THREE.Mesh
    const id = mesh.userData.docId as string
    // The edited shape: keep the material and the body's place in the tree.
    const g = geo
    delete g.userData.prim
    this.close()
    selection.clear()
    this.ctx.doc.replaceGeometry(id, g, 'Edit faces of')
    this.ctx.status(`Faces moved ${fmt(this.distance)} mm`, 'success')
  }

  close(): void {
    if (active !== this) return
    active = null
    window.clearTimeout(this.timer)
    this.runId++
    this.off.forEach((f) => f())
    this.clearPreview()
    this.hl.dispose()
    this.prompt.remove()
    this.strip.remove()
    this.ctx.viewport.blockPick = null
    this.ctx.refreshRibbon()
  }
}
