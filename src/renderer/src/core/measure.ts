import * as THREE from 'three'
import type { ModuleContext } from './types'
import { datums } from './datums'
import { measureCad, type MeasureResult, type Vec3 } from './occt'
import { dotMaterial, Highlights, pickAt, pickKey, rowMajor, selectFilter, type Pick, type SelectFilter } from './picking'
import { el, fmt, resultRows, toolPanel } from './toolpanel'

/**
 * Measure: click points, edges, faces (or bodies, per the select filter) to get
 * their exact sizes from the CAD kernel; pick two for distance, centre distance
 * and angle. Coordinates are given relative to the chosen datum.
 */

const COLORS = [0xff9f1c, 0x22d3ee]
const HOVER = 0xfff1a8
let active: MeasureTool | null = null

export function openMeasure(ctx: ModuleContext): void {
  if (active) return
  active = new MeasureTool(ctx)
}
export const isMeasuring = (): boolean => !!active

class MeasureTool {
  private picks: Pick[] = []
  private hover: Pick | null = null
  private hl: Highlights
  private panel: HTMLElement
  private body: HTMLElement
  private sub: HTMLElement
  private resultBox = el('div')
  private datumId = 'world'
  private dims = new THREE.Group()
  private labels: { el: HTMLElement; at: THREE.Vector3 }[] = []
  private off: (() => void)[] = []
  private run = 0
  private moveQueued: PointerEvent | null = null

  constructor(private ctx: ModuleContext) {
    const vp = ctx.viewport
    this.hl = new Highlights(vp)
    this.dims.name = '__dims'
    vp.scene.add(this.dims)
    const p = toolPanel('Quick measure', () => this.close())
    this.panel = p.panel
    this.panel.classList.add('wide')
    this.body = p.body
    this.sub = p.sub
    this.buildBody()
    vp.host.appendChild(this.panel)
    vp.blockPick = () => true

    const canvas = vp.renderer.domElement
    let down: { x: number; y: number } | null = null
    const onDown = (e: PointerEvent): void => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY }
    }
    const onUp = (e: PointerEvent): void => {
      if (e.button !== 0 || !down) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
      down = null
      if (moved <= 4) this.click(pickAt(vp, e))
    }
    const onMove = (e: PointerEvent): void => {
      if (this.moveQueued) {
        this.moveQueued = e
        return
      }
      this.moveQueued = e
      requestAnimationFrame(() => {
        const ev = this.moveQueued!
        this.moveQueued = null
        if (e.buttons) return // navigating
        const h = pickAt(vp, ev)
        if ((h && pickKey(h)) !== (this.hover && pickKey(this.hover))) {
          this.hover = h
          this.showHighlights()
        }
      })
    }
    const onLeave = (): void => {
      this.hover = null
      this.showHighlights()
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerleave', onLeave)
    this.off.push(() => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
    })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (this.picks.length) this.setPicks([])
      else this.close()
    }
    window.addEventListener('keydown', onKey, true)
    this.off.push(() => window.removeEventListener('keydown', onKey, true))
    // Edits (move, delete, undo...) make the picks stale.
    this.off.push(ctx.doc.history.on('changed', () => this.setPicks([])))
    this.off.push(selectFilter.on('changed', () => this.buildBody()))
    const place = (): void => this.placeLabels()
    vp.afterRender.add(place)
    this.off.push(() => vp.afterRender.delete(place))
    ctx.refreshRibbon()
  }

  private buildBody(): void {
    this.body.replaceChildren()
    // Select filter (same as Query > Select).
    const filter = el('div', 'tool-filter')
    const names: [keyof SelectFilter, string][] = [['vertex', 'Points'], ['edge', 'Edges'], ['face', 'Faces'], ['surface', 'Surfaces'], ['body', 'Bodies']]
    for (const [k, label] of names) {
      const b = el('button', selectFilter.value[k] ? 'on' : '', label)
      b.title = `Pick ${label.toLowerCase()}`
      b.addEventListener('click', () => {
        selectFilter.toggle(k)
        this.ctx.refreshRibbon()
      })
      filter.append(b)
    }
    this.body.append(filter)

    const field = el('label', 'tool-field')
    const select = el('select')
    for (const d of datums.list()) {
      const o = el('option', '', d.name)
      o.value = d.id
      select.append(o)
    }
    select.value = this.datumId
    select.addEventListener('change', () => {
      this.datumId = select.value
      void this.update()
    })
    field.append(el('span', '', 'Relative to'), select)
    this.body.append(field, this.resultBox)
    void this.update()
  }

  private click(p: Pick | null): void {
    if (!p) return this.setPicks([])
    const k = pickKey(p)
    const at = this.picks.findIndex((x) => pickKey(x) === k)
    if (at >= 0) this.setPicks(this.picks.filter((_, i) => i !== at))
    else this.setPicks(this.picks.length >= 2 ? [p] : [...this.picks, p])
  }

  private setPicks(p: Pick[]): void {
    this.picks = p
    this.showHighlights()
    void this.update()
  }

  private showHighlights(): void {
    const list = this.picks.map((pick, i) => ({ pick, color: COLORS[i] }))
    if (this.hover && !this.picks.some((p) => pickKey(p) === pickKey(this.hover!))) list.push({ pick: this.hover, color: HOVER })
    this.hl.set(list)
  }

  private nameOf(p: Pick): string {
    const id = p.object.userData.docId as string | undefined
    const n = id ? this.ctx.doc.get(id) : undefined
    if (!n) return 'Body'
    // "Body 2" alone says little: name the part it belongs to.
    return /^(Body|Wireframe) \d+$/.test(n.name) && n.parent ? `${n.parent.name} › ${n.name}` : n.name
  }

  private async update(): Promise<void> {
    const run = ++this.run
    this.clearDims()
    const picks = this.picks
    this.sub.textContent = picks.length ? `${picks.length} picked` : ''
    if (!picks.length) {
      this.resultBox.replaceChildren(el('div', 'tool-empty', 'Click a point, edge or face. Pick a second one for distance and angle. Esc clears.'))
      return
    }
    const inv = datums.inverse(this.datumId)
    const P = (v: Vec3 | THREE.Vector3): THREE.Vector3 => (Array.isArray(v) ? new THREE.Vector3(...v) : v.clone()).applyMatrix4(inv)
    const D = (v: Vec3): THREE.Vector3 => new THREE.Vector3(...v).transformDirection(inv)
    const xyz = (v: THREE.Vector3): string => `${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)}`

    let res: MeasureResult | null = null
    const exact = picks.every((p) => p.kind !== 'point' && (p.object as THREE.Mesh).geometry?.userData.brep)
    if (exact) {
      try {
        res = await measureCad(
          picks.map((p) => {
            p.object.updateMatrixWorld()
            return {
              brep: (p.object as THREE.Mesh).geometry.userData.brep as Uint8Array,
              kind: p.kind as 'body' | 'face' | 'edge' | 'vertex',
              index: p.index,
              matrix: rowMajor(p.object.matrixWorld)
            }
          })
        )
      } catch (e) {
        if (run !== this.run) return
        this.resultBox.replaceChildren(el('div', 'tool-empty', `Couldn't measure: ${(e as Error).message}`))
        return
      }
    }
    if (run !== this.run) return

    const rows: [string, string | null][] = []
    picks.forEach((p, i) => {
      const d = res?.items[i] as Record<string, unknown> | undefined
      const swatch = `#${COLORS[i].toString(16).padStart(6, '0')}`
      rows.push([`${i + 1}. ${title(p, d)} · ${this.nameOf(p)}`, null])
      ;(rows as unknown as { swatch?: string }).swatch = swatch
      if (!d) {
        rows.push(['Point X, Y, Z', xyz(P(p.point))])
        return
      }
      const num = (k: string): number => d[k] as number
      const vec = (k: string): Vec3 => d[k] as Vec3
      if (d.kind === 'vertex') rows.push(['X, Y, Z', xyz(P(vec('point')))])
      else if (d.kind === 'edge') {
        if (d.curve === 'Circle' || d.curve === 'Arc') {
          rows.push(['Diameter', fmt(num('radius') * 2)], ['Radius', fmt(num('radius'))], ['Centre', xyz(P(vec('center')))])
          if (d.curve === 'Arc') rows.push(['Arc angle', `${fmt(num('sweep'), 2)}°`])
        }
        if (d.curve === 'Ellipse') rows.push(['Major / minor radius', `${fmt(num('major'))} / ${fmt(num('minor'))}`], ['Centre', xyz(P(vec('center')))])
        rows.push(['Length', fmt(num('length'))])
        if (d.curve === 'Line') {
          const dv = P(vec('end')).sub(P(vec('start')))
          rows.push(['dX, dY, dZ', xyz(new THREE.Vector3(Math.abs(dv.x), Math.abs(dv.y), Math.abs(dv.z)))])
        }
      } else if (d.kind === 'face') {
        if (d.surface === 'Cylinder') rows.push(['Diameter', fmt(num('radius') * 2)], ['Radius', fmt(num('radius'))], ['Axis', xyz(D(vec('axis')))])
        if (d.surface === 'Sphere') rows.push(['Diameter', fmt(num('radius') * 2)], ['Centre', xyz(P(vec('center')))])
        if (d.surface === 'Cone') rows.push(['Half angle', `${fmt(num('halfAngle'), 2)}°`], ['Axis', xyz(D(vec('axis')))])
        if (d.surface === 'Torus') rows.push(['Major / minor radius', `${fmt(num('major'))} / ${fmt(num('minor'))}`])
        if (d.surface === 'Plane') rows.push(['Normal', xyz(D(vec('normal')))])
        rows.push(['Area', `${fmt(num('area'))} mm²`])
      } else if (d.kind === 'body') {
        if (d.volume !== undefined) rows.push(['Volume', `${fmt(num('volume'))} mm³`])
        rows.push(['Surface area', `${fmt(num('area'))} mm²`])
        if (d.centroid) rows.push(['Centre of mass', xyz(P(vec('centroid')))])
      }
    })

    if (picks.length === 2) {
      rows.push(['Between 1 and 2', null])
      const pair = res?.pair
      let a: THREE.Vector3 | undefined
      let b: THREE.Vector3 | undefined
      if (pair?.distance !== undefined && pair.p1 && pair.p2) {
        a = new THREE.Vector3(...pair.p1)
        b = new THREE.Vector3(...pair.p2)
        rows.push(['Distance', fmt(pair.distance)])
      } else if (!res) {
        a = picks[0].point
        b = picks[1].point
        rows.push(['Distance', fmt(a.distanceTo(b))])
      }
      if (a && b) {
        const dv = P(b).sub(P(a))
        rows.push(['dX, dY, dZ', xyz(new THREE.Vector3(Math.abs(dv.x), Math.abs(dv.y), Math.abs(dv.z)))])
        this.addDim(a, b, COLORS[0])
      }
      if (pair?.centerDistance !== undefined && pair.c1 && pair.c2) {
        const c1 = new THREE.Vector3(...pair.c1)
        const c2 = new THREE.Vector3(...pair.c2)
        const dv = P(c2).sub(P(c1))
        rows.push(['Centre distance', fmt(pair.centerDistance)], ['Centre dX, dY, dZ', xyz(new THREE.Vector3(Math.abs(dv.x), Math.abs(dv.y), Math.abs(dv.z)))])
        if (pair.centerDistance > 1e-9 && (!a || c1.distanceTo(a) + c2.distanceTo(b!) > 1e-6)) this.addDim(c1, c2, COLORS[1])
      }
      if (pair?.angle !== undefined) rows.push(['Angle', `${fmt(pair.angle, 3)}°`])
    }
    this.resultBox.replaceChildren(resultRows(rows))
    // Colour the item headings like their highlight.
    this.resultBox.querySelectorAll('.tool-section').forEach((h, i) => {
      if (i < picks.length) (h as HTMLElement).style.color = `#${COLORS[i].toString(16).padStart(6, '0')}`
      else (h as HTMLElement).style.color = ''
    })
    this.ctx.viewport.requestRender()
  }

  private addDim(a: THREE.Vector3, b: THREE.Vector3, color: number): void {
    if (a.distanceTo(b) < 1e-9) return
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([...a.toArray(), ...b.toArray()], 3))
    const line = new THREE.LineSegments(g, new THREE.LineDashedMaterial({ color, depthTest: false, dashSize: 1e9, gapSize: 0 }))
    line.renderOrder = 13
    const pts = new THREE.Points(g, dotMaterial(color, 9))
    pts.renderOrder = 13
    this.dims.add(line, pts)
    const label = el('div', 'dim-label', fmt(a.distanceTo(b)))
    this.ctx.viewport.host.appendChild(label)
    this.labels.push({ el: label, at: a.clone().add(b).multiplyScalar(0.5) })
  }

  private placeLabels(): void {
    for (const l of this.labels) {
      const s = this.ctx.viewport.toScreen(l.at)
      l.el.style.left = `${s.x}px`
      l.el.style.top = `${s.y}px`
    }
  }

  private clearDims(): void {
    this.dims.children.forEach((c) => {
      ;(c as THREE.Mesh).geometry?.dispose()
      ;((c as THREE.Mesh).material as THREE.Material).dispose()
    })
    this.dims.clear()
    this.labels.forEach((l) => l.el.remove())
    this.labels = []
  }

  close(): void {
    if (active !== this) return
    active = null
    this.off.forEach((f) => f())
    this.clearDims()
    this.ctx.viewport.scene.remove(this.dims)
    this.hl.dispose()
    this.panel.remove()
    this.ctx.viewport.blockPick = null
    this.ctx.refreshRibbon()
    this.ctx.viewport.requestRender()
  }
}

export function closeMeasure(): void {
  active?.close()
}

function title(p: Pick, d?: Record<string, unknown>): string {
  if (p.kind === 'point') return 'Point'
  if (p.kind === 'vertex') return 'Point'
  if (p.kind === 'edge') return `Edge${d?.curve ? ` (${String(d.curve).toLowerCase()})` : ''}`
  if (p.kind === 'face') return `Face${d?.surface ? ` (${String(d.surface).toLowerCase()})` : ''}`
  return 'Body'
}
