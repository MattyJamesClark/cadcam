import * as THREE from 'three'
import { curvePoints, isDim, type SketchData, SketchIndex } from './model'
import { sample, type P2 } from './geom'
import { findRegions } from './profiles'
import { dimDraw } from './dimgeom'
import { dotMaterial } from '@/core/picking'
import { effectiveTheme, settings } from '@/core/settings'

/**
 * Draws a sketch: curves (construction dashed), points, closed regions
 * lightly filled, and dimension lines. Colours follow how well defined each
 * item is while editing (blue = still free, solid = fully defined).
 */

export interface DrawStyle {
  editing: boolean
  /** Mm per screen pixel at the sketch. */
  px: number
  defined?: { points: Set<string>; curves: Set<string> }
  selected?: Set<string>
  hover?: string | null
  /** Points / curves the last solve could not satisfy. */
  failing?: Set<string>
  showDims?: boolean
  showRegions?: boolean
  /** Open ends (shown in their own colour so gaps stand out). */
  loose?: Set<string>
}

export const COL = {
  free: 0x4da3ff,
  definedDark: 0xf2f4f7,
  definedLight: 0x111827,
  shown: 0x8fb8de,
  construction: 0xd9a35f,
  selected: 0xff9f1c,
  hover: 0xfff1a8,
  fail: 0xff5a5a,
  loose: 0xff7a45,
  region: 0x4da3ff,
  dim: 0x9fd0ff
}
export const definedColour = (): number => (effectiveTheme(settings.get()) === 'light' ? COL.definedLight : COL.definedDark)

const lineMats = new Map<string, THREE.Material>()
function lineMat(color: number, dashed: boolean, onTop: boolean): THREE.Material {
  const key = `${color}:${dashed}:${onTop}`
  let m = lineMats.get(key)
  if (!m) {
    m = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 1, gapSize: 1, depthTest: !onTop, transparent: true })
      : new THREE.LineBasicMaterial({ color, depthTest: !onTop, transparent: true })
    lineMats.set(key, m)
  }
  return m
}

const v3 = (p: P2, z = 0): THREE.Vector3 => new THREE.Vector3(p[0], p[1], z)

export function drawSketch(s: SketchData, st: DrawStyle): THREE.Group {
  const g = new THREE.Group()
  g.name = '__sketch'
  g.matrixAutoUpdate = false
  g.matrix.fromArray(s.plane)
  const ix = new SketchIndex(s)
  const onTop = st.editing
  const order = st.editing ? 30 : 3
  const defCol = definedColour()

  const colourOf = (id: string, kind: 'point' | 'curve'): number => {
    if (st.hover === id) return COL.hover
    if (st.selected?.has(id)) return COL.selected
    if (st.failing?.has(id)) return COL.fail
    if (!st.editing) return COL.shown
    if (kind === 'point' && st.loose?.has(id)) return COL.loose
    const def = kind === 'point' ? st.defined?.points.has(id) : st.defined?.curves.has(id)
    return def ? defCol : COL.free
  }

  // Regions first so lines draw over them.
  if (st.showRegions !== false) {
    for (const r of findRegions(s)) {
      const shape = new THREE.Shape(r.outer.poly.map((p) => new THREE.Vector2(p[0], p[1])))
      for (const h of r.holes) shape.holes.push(new THREE.Path(h.poly.map((p) => new THREE.Vector2(p[0], p[1]))))
      const mesh = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshBasicMaterial({ color: COL.region, transparent: true, opacity: st.editing ? 0.12 : 0.07, side: THREE.DoubleSide, depthWrite: false, depthTest: !onTop })
      )
      mesh.renderOrder = order - 1
      mesh.raycast = () => {}
      g.add(mesh)
    }
  }

  for (const c of s.curves) {
    const pts = sample(ix, c, st.px).map((p) => v3(p))
    const geo = new THREE.BufferGeometry().setFromPoints(pts)
    const line = new THREE.Line(geo, lineMat(colourOf(c.id, 'curve'), !!c.construction, onTop))
    if (c.construction) {
      const m = line.material as THREE.LineDashedMaterial
      m.dashSize = 6 * st.px
      m.gapSize = 4 * st.px
      line.computeLineDistances()
    }
    line.renderOrder = order
    line.userData.sketchItem = c.id
    line.raycast = () => {}
    g.add(line)
  }

  // Points: ends, centres and loose points; only while editing (and loose points always).
  const used = new Set(s.curves.flatMap(curvePoints))
  const groups = new Map<number, P2[]>()
  for (const p of s.points) {
    if (!st.editing && used.has(p.id)) continue
    const col = colourOf(p.id, 'point')
    if (!groups.has(col)) groups.set(col, [])
    groups.get(col)!.push([p.x, p.y])
  }
  for (const [col, list] of groups) {
    const pts = new THREE.Points(new THREE.BufferGeometry().setFromPoints(list.map((p) => v3(p))), dotMaterial(col, st.editing ? 7 : 5))
    pts.renderOrder = order + 1
    pts.raycast = () => {}
    g.add(pts)
  }

  if (st.showDims !== false) {
    const segs: THREE.Vector3[] = []
    const tris: THREE.Vector3[] = []
    const selSegs: THREE.Vector3[] = []
    const selTris: THREE.Vector3[] = []
    for (const k of s.constraints) {
      if (!isDim(k)) continue
      const d = dimDraw(s, k, st.px, ix)
      if (!d) continue
      const sel = st.selected?.has(k.id) || st.hover === k.id
      ;(sel ? selSegs : segs).push(...d.segs.map((p) => v3(p)))
      ;(sel ? selTris : tris).push(...d.tris.map((p) => v3(p)))
    }
    const dimCol = st.editing ? COL.dim : COL.shown
    for (const [list, tri, col] of [
      [segs, tris, dimCol],
      [selSegs, selTris, COL.selected]
    ] as [THREE.Vector3[], THREE.Vector3[], number][]) {
      if (list.length) {
        const ls = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(list), lineMat(col, false, onTop))
        ls.renderOrder = order
        ls.raycast = () => {}
        g.add(ls)
      }
      if (tri.length) {
        const m = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints(tri), new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide, depthTest: !onTop }))
        m.renderOrder = order
        m.raycast = () => {}
        g.add(m)
      }
    }
  }
  g.updateMatrixWorld(true)
  return g
}

/** Free a drawn sketch (shared line materials are kept). */
export function disposeDrawing(g: THREE.Object3D): void {
  g.traverse((o) => {
    const m = o as THREE.Mesh
    m.geometry?.dispose()
    const mat = m.material as THREE.Material | undefined
    if (mat && !(mat instanceof THREE.LineBasicMaterial) && !(mat instanceof THREE.LineDashedMaterial)) mat.dispose()
  })
}
