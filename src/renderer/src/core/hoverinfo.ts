import type { ModuleContext } from './types'
import { measureCad } from './occt'
import { pickKey, rowMajor, type Pick } from './picking'
import { selection } from './selection'
import { el, fmt } from './toolpanel'
import type * as THREE from 'three'

/**
 * Hover info: with no tool running, the face / edge / point under the
 * pointer gets a small label (radius, diameter, length...).
 */

const KEY = 'cadcam.hoverInfo'
let enabled = localStorage.getItem(KEY) !== '0'
let instance: HoverInfo | null = null

export const hoverInfoEnabled = (): boolean => enabled
export function setHoverInfo(on: boolean): void {
  enabled = on
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
  if (!on) instance?.clear(true)
}

export function startHoverInfo(ctx: ModuleContext): void {
  instance ??= new HoverInfo(ctx)
}

/** Label beside the pointer; the highlight itself is drawn by the selection. */
class HoverInfo {
  private hover: Pick | null = null
  private label = el('div', 'hover-label')
  private cache = new Map<string, string>()
  private lastXY = { x: 0, y: 0 }

  constructor(private ctx: ModuleContext) {
    this.label.hidden = true
    ctx.viewport.host.append(this.label)
    selection.on('hover', ({ pick, x, y }) => {
      this.lastXY = { x, y }
      const changed = (pick && pickKey(pick)) !== (this.hover && pickKey(this.hover))
      this.hover = pick
      if (changed) void this.refresh()
      else this.placeHover()
    })
    // The model changed: labels may be stale.
    ctx.doc.history.on('changed', () => {
      this.cache.clear()
      this.clear(true)
    })
  }

  clear(_all: boolean): void {
    this.hover = null
    void this.refresh()
  }

  private async refresh(): Promise<void> {
    const hover = this.hover
    this.label.hidden = true
    if (!hover || !enabled) return
    const text = await this.textOf(hover)
    if (hover === this.hover && text) {
      this.label.textContent = text
      this.label.hidden = false
      this.placeHover()
    }
  }

  private placeHover(): void {
    const r = this.ctx.viewport.host.getBoundingClientRect()
    this.label.style.left = `${this.lastXY.x - r.left + 14}px`
    this.label.style.top = `${this.lastXY.y - r.top + 16}px`
  }

  private async textOf(p: Pick): Promise<string> {
    const key = pickKey(p)
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit
    let text = ''
    const geo = (p.object as THREE.Mesh).geometry
    if (p.kind === 'body') {
      const n = this.ctx.doc.get(p.object.userData.docId as string)
      if (!n) return 'Body'
      return `Body  ${/^(Body|Wireframe) \d+$/.test(n.name) && n.parent ? `${n.parent.name} › ${n.name}` : n.name}`
    }
    if (p.kind === 'point') text = `${p.snap === 'centre' ? 'Centre' : p.snap === 'quadrant' ? 'Quadrant' : p.snap === 'mid' ? 'Midpoint' : 'Point'}  ${fmt(p.point.x)}, ${fmt(p.point.y)}, ${fmt(p.point.z)}`
    else if (geo?.userData.brep) {
      try {
        p.object.updateMatrixWorld()
        const res = await measureCad([{ brep: geo.userData.brep as Uint8Array, kind: p.kind, index: p.index, matrix: rowMajor(p.object.matrixWorld) }])
        text = describe(res.items[0])
      } catch {
        text = ''
      }
    }
    this.cache.set(key, text)
    return text
  }
}

function describe(d: Record<string, unknown>): string {
  const n = (k: string): number => d[k] as number
  if (d.kind === 'vertex') {
    const [x, y, z] = d.point as number[]
    return `Point  ${fmt(x)}, ${fmt(y)}, ${fmt(z)}`
  }
  if (d.kind === 'edge') {
    switch (d.curve) {
      case 'Circle':
        return `Circle  Ø${fmt(n('radius') * 2)}  R${fmt(n('radius'))}`
      case 'Arc':
        return `Arc  R${fmt(n('radius'))}  ${fmt(n('sweep'), 2)}°  L${fmt(n('length'))}`
      case 'Line':
        return `Line  L${fmt(n('length'))}`
      case 'Ellipse':
        return `Ellipse  ${fmt(n('major'))} × ${fmt(n('minor'))}`
      default:
        return `Curve  L${fmt(n('length'))}`
    }
  }
  switch (d.surface) {
    case 'Cylinder':
      return `Cylinder  Ø${fmt(n('radius') * 2)}  R${fmt(n('radius'))}`
    case 'Sphere':
      return `Sphere  SR${fmt(n('radius'))}`
    case 'Cone':
      return `Cone  ${fmt(n('halfAngle') * 2, 2)}° incl.`
    case 'Torus':
      return `Torus  R${fmt(n('minor'))} on R${fmt(n('major'))}`
    case 'Plane':
      return `Plane  ${fmt(n('area'), 1)} mm²`
    default:
      return `Surface  ${fmt(n('area'), 1)} mm²`
  }
}
