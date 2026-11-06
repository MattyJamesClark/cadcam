import * as THREE from 'three'
import type { CadModule, Command, ModuleContext } from '@/core/types'
import { addTreeSection, refreshTree } from '@/core/treeext'
import { worldPerPixel } from '@/core/handles'
import { icons } from '@/core/icons'
import { activeEditor, allRelationsShown, editorKeys, setAllRelationsShown, onEditorChange, openEditor, type SketchEditor, type Tool } from '@/sketch/editor'
import { emptySketch, type SketchData } from '@/sketch/model'
import { disposeDrawing, drawSketch } from '@/sketch/render'
import { findRegions } from '@/sketch/profiles'
import { ArcTool, CircleTool, DimensionTool, LineTool, PointTool, PolygonTool, RectTool, SlotTool } from '@/sketch/tools'
import { ChamferTool, ExtendTool, FilletTool, MirrorTool, OffsetTool, TrimTool } from '@/sketch/ops'

/**
 * Sketch: 2D constrained sketching on the active work plane, after
 * SolidCraft's sketcher (lines, rectangles, circles, arcs, slots, polygons,
 * construction geometry, relations, driving dimensions, trim / extend /
 * fillet / chamfer / offset / mirror, closed profile detection).
 *
 * Commands work while a sketch is open; single-key shortcuts (L, C, A, D, T,
 * O, X...) only apply inside a sketch so they don't clash with the rest of
 * the app.
 */

const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

const ico = {
  sketch: svg('<path d="M4 20h16"/><path d="M5 16 15 6l3 3L8 19H5z"/><path d="m13 8 3 3"/>'),
  finish: svg('<path d="M4 20h16"/><path d="m6 12 4 4 8-9"/>'),
  look: svg('<rect x="5" y="5" width="14" height="14" rx="1"/><path d="M12 9v6M9 12h6"/>'),
  line: svg('<path d="M5 19 19 5"/><circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="5" r="1.6"/>'),
  centreline: svg('<path d="M5 19 19 5" stroke-dasharray="4 2 1 2"/>'),
  rect: svg('<rect x="4" y="6" width="16" height="12"/><circle cx="4" cy="6" r="1.4"/><circle cx="20" cy="18" r="1.4"/>'),
  rectCentre: svg('<rect x="4" y="6" width="16" height="12"/><path d="M4 6l16 12M20 6 4 18" stroke-dasharray="2 2" opacity=".6"/><circle cx="12" cy="12" r="1.4"/>'),
  rect3: svg('<path d="m4 14 8-9 8 7-8 9z"/><circle cx="4" cy="14" r="1.3"/><circle cx="12" cy="5" r="1.3"/><circle cx="20" cy="12" r="1.3"/>'),
  circle: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1.2"/><path d="M12 12h8" opacity=".6"/>'),
  circle3: svg('<circle cx="12" cy="12" r="8"/><circle cx="4.5" cy="10" r="1.3"/><circle cx="17" cy="5.8" r="1.3"/><circle cx="16" cy="19" r="1.3"/>'),
  arc: svg('<path d="M5 17a8 8 0 0 1 14 0"/><circle cx="12" cy="17" r="1.2"/><path d="M12 17 5 17" opacity=".5"/>'),
  arc3: svg('<path d="M4 17a9 9 0 0 1 16 0"/><circle cx="4" cy="17" r="1.3"/><circle cx="20" cy="17" r="1.3"/><circle cx="12" cy="8" r="1.3"/>'),
  arcTan: svg('<path d="M3 18h8"/><path d="M11 18a6 6 0 0 0 6-6V6"/><circle cx="11" cy="18" r="1.3"/>'),
  slot: svg('<path d="M8 8h8a4 4 0 0 1 0 8H8a4 4 0 0 1 0-8z"/><path d="M8 12h8" stroke-dasharray="2 2" opacity=".6"/>'),
  polygon: svg('<path d="m12 3 7.8 4.5v9L12 21l-7.8-4.5v-9z"/><circle cx="12" cy="12" r="1.2"/>'),
  point: svg('<circle cx="12" cy="12" r="2.4" fill="currentColor"/><path d="M12 5v3M12 16v3M5 12h3M16 12h3" opacity=".5"/>'),
  construction: svg('<path d="M4 20 20 4" stroke-dasharray="3 3"/><path d="M14 20h6M17 17v6" opacity=".0"/>'),
  dimension: svg('<path d="M4 7v10M20 7v10"/><path d="M4 12h16"/><path d="m7 10-3 2 3 2M17 10l3 2-3 2"/>'),
  trim: svg('<path d="M4 12h6" /><path d="M14 12h6" stroke-dasharray="2 2" opacity=".5"/><path d="M12 4v16"/><path d="m15 9 4 6M19 9l-4 6"/>'),
  extend: svg('<path d="M4 12h9"/><path d="M13 12h5" stroke-dasharray="2 2"/><path d="M20 4v16"/><path d="m15 9 3 3-3 3"/>'),
  fillet: svg('<path d="M4 20V11a7 7 0 0 1 7-7h9"/><path d="M4 4h4M4 4v4" opacity=".4"/>'),
  chamfer: svg('<path d="M4 20V10l6-6h10"/><path d="M4 4h4M4 4v4" opacity=".4"/>'),
  offset: svg('<path d="M4 18 10 8h10"/><path d="M4 13l4-6h12" opacity=".5"/>'),
  relations: svg('<rect x="3" y="5" width="7" height="6" rx="1"/><path d="M5 9V7h3"/><rect x="13" y="13" width="7" height="6" rx="1"/><path d="M15.5 15v2M17.5 15v2"/><path d="M10 8h4l2 5" opacity=".5"/>'),
  mirror: svg('<path d="M12 3v18" stroke-dasharray="3 2"/><path d="M9 7 4 17h5zM15 7l5 10h-5z"/>')
}

let ctxRef: ModuleContext | null = null

// ---- sketches drawn in the view when not being edited ----------------------------------

class SketchLayer {
  private group = new THREE.Group()
  private lastPx = 0
  constructor(private ctx: ModuleContext) {
    this.group.name = '__sketches'
    ctx.viewport.scene.add(this.group)
    ctx.doc.on('sketches', () => this.redraw())
    onEditorChange(() => this.redraw())
    ctx.viewport.beforeRender.add((cam) => {
      const px = worldPerPixel(ctx.viewport, cam, new THREE.Vector3())
      if (this.lastPx && Math.abs(px / this.lastPx - 1) > 0.25) this.redraw(px)
    })
  }
  redraw(px?: number): void {
    const vp = this.ctx.viewport
    for (const c of [...this.group.children]) {
      this.group.remove(c)
      disposeDrawing(c)
    }
    px ??= worldPerPixel(vp, vp.camera, new THREE.Vector3())
    this.lastPx = px
    const editing = activeEditor()?.id
    for (const s of this.ctx.doc.sketches) if (s.visible && s.id !== editing) this.group.add(drawSketch(s, { editing: false, px }))
    vp.requestRender()
    refreshTree()
  }
}

// ---- tree rows ------------------------------------------------------------------------

function treeRows(ctx: ModuleContext, tree: HTMLElement): number {
  const list = ctx.doc.sketches
  if (!list.length) return 0
  const editing = activeEditor()?.id
  const mk = (tag: string, cls: string, html = ''): HTMLElement => {
    const e = document.createElement(tag)
    e.className = cls
    e.innerHTML = html
    return e
  }
  for (const s of list) {
    const li = mk('li', 'tree-item kind-sketch')
    li.style.setProperty('--depth', '0')
    li.classList.toggle('selected', s.id === editing)
    li.classList.toggle('hidden-item', !s.visible)
    const twisty = mk('button', 'tree-twisty') as HTMLButtonElement
    twisty.disabled = true
    const label = mk('span', 'tree-label')
    label.textContent = s.name
    label.title = `${s.name} on ${s.planeName ?? 'a work plane'}: double-click to edit`
    const regions = findRegions(s).length
    const kind = mk('span', 'tree-kind')
    kind.textContent = [`${s.curves.length} ${s.curves.length === 1 ? 'curve' : 'curves'}`, regions ? `${regions} ${regions === 1 ? 'profile' : 'profiles'}` : ''].filter(Boolean).join(' · ')
    const eye = mk('button', 'tree-eye', s.visible ? icons.eye : icons.eyeOff)
    eye.title = s.visible ? 'Hide' : 'Show'
    eye.addEventListener('click', (e) => {
      e.stopPropagation()
      const before = structuredClone(s)
      ctx.doc.updateSketch(s.id, before, { ...structuredClone(s), visible: !s.visible }, s.visible ? `Hide ${s.name}` : `Show ${s.name}`)
    })
    li.append(twisty, mk('span', 'tree-icon', ico.sketch), label, kind, eye)
    li.addEventListener('dblclick', () => editSketch(ctx, s.id))
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (confirm(`Delete ${s.name}?`)) {
        if (activeEditor()?.id === s.id) activeEditor()!.close()
        ctx.doc.removeSketch(s.id)
      }
    })
    tree.append(li)
  }
  return list.length
}

// ---- commands -------------------------------------------------------------------------

function newSketch(ctx: ModuleContext): void {
  const m = ctx.viewport.workplane
  const plane = ctx.doc.planes.find((p) => new THREE.Matrix4().fromArray(p.matrix).equals(m))
  const n = ctx.doc.sketches.length + 1
  let name = `Sketch ${n}`
  for (let i = n; ctx.doc.sketches.some((s) => s.name === name); i++) name = `Sketch ${i + 1}`
  const sk: SketchData = emptySketch(crypto.randomUUID(), name, m.toArray(), plane?.name ?? 'Absolute')
  ctx.doc.addSketch(sk)
  openEditor(ctx, sk.id, true)
  ctx.status(`${name} on ${sk.planeName}: draw with the Sketch tools, ✓ or Enter when done`, 'info')
  ctx.refreshRibbon()
}

function editSketch(ctx: ModuleContext, id?: string): void {
  const target = id ?? ctx.doc.sketches.at(-1)?.id
  if (!target) return ctx.status('No sketches yet: New sketch makes one on the active work plane', 'warn')
  openEditor(ctx, target)
  ctx.refreshRibbon()
}

const editing = (): boolean => !!activeEditor()

function toolCmd(id: string, label: string, icon: string, key: string | null, tooltip: string, make: (ed: SketchEditor) => Tool | null): Command {
  const start = (ed: SketchEditor): void => {
    if (ed.tool?.name === label) return ed.setTool(null)
    const t = make(ed)
    if (t) ed.setTool(t)
  }
  if (key) editorKeys.set(key.toLowerCase(), start)
  return {
    id: `sketch.${id}`,
    label,
    icon,
    tooltip: key ? `${tooltip} (${key} in a sketch)` : tooltip,
    isEnabled: editing,
    isActive: () => activeEditor()?.tool?.name === label,
    run: () => {
      const ed = activeEditor()
      if (ed) start(ed)
    }
  }
}

const mirrorTool = (ed: SketchEditor): Tool | null => {
  const sel = [...ed.selected]
  if (!sel.length) {
    ed.ctx.status('Select the geometry to mirror first, then Mirror and click the mirror line', 'warn')
    return null
  }
  return new MirrorTool(ed, sel)
}

editorKeys.set('x', (ed) => ed.toggleConstruction())
editorKeys.set('g', () => setAllRelationsShown(!allRelationsShown()))

export const sketchModule: CadModule = {
  id: 'sketch',
  title: 'Sketch',
  order: 10,
  init: (ctx) => {
    ctxRef = ctx
    new SketchLayer(ctx)
    addTreeSection({ render: (tree) => treeRows(ctx, tree) })
    onEditorChange(() => ctxRef?.refreshRibbon())
  },
  groups: [
    {
      label: 'Sketch',
      commands: [
        {
          id: 'sketch.new',
          label: 'New sketch',
          icon: ico.sketch,
          tooltip: 'Start a sketch on the active work plane (pick or make one with Planes first)',
          isEnabled: () => !editing(),
          run: (ctx) => newSketch(ctx)
        },
        {
          id: 'sketch.edit',
          label: 'Edit sketch',
          icon: ico.look,
          tooltip: 'Open the last sketch again (or double-click one in the tree)',
          isEnabled: (ctx) => !editing() && ctx.doc.sketches.length > 0,
          run: (ctx) => editSketch(ctx)
        },
        {
          id: 'sketch.finish',
          label: 'Finish',
          icon: ico.finish,
          tooltip: 'Finish the sketch (Enter or the ✓ at the top)',
          isEnabled: editing,
          run: () => activeEditor()?.finish()
        }
      ]
    },
    {
      label: 'Lines',
      commands: [
        toolCmd('line', 'Line', ico.line, 'L', 'Lines end to end; right-click or Enter ends the chain', (ed) => new LineTool(ed)),
        toolCmd('centreline', 'Centreline', ico.centreline, null, 'Construction line (for mirrors, symmetry, slots)', (ed) => new LineTool(ed, true)),
        toolCmd('point', 'Point', ico.point, null, 'Sketch points (hole centres, references)', (ed) => new PointTool(ed)),
        {
          id: 'sketch.construction',
          label: 'Construction',
          icon: ico.construction,
          tooltip: 'Switch the selection between construction and normal geometry, or (nothing selected) draw construction geometry (X in a sketch)',
          isEnabled: editing,
          isActive: () => !!activeEditor()?.constructionMode,
          run: () => activeEditor()?.toggleConstruction()
        }
      ]
    },
    {
      label: 'Shapes',
      commands: [
        toolCmd('rect', 'Rectangle', ico.rect, 'R', 'Rectangle from two corners', (ed) => new RectTool(ed, 'corner')),
        toolCmd('rect-centre', 'Centre rectangle', ico.rectCentre, null, 'Rectangle from its centre and a corner', (ed) => new RectTool(ed, 'centre')),
        toolCmd('rect-3pt', '3-point rectangle', ico.rect3, null, 'Rectangle at any angle: one side, then the height', (ed) => new RectTool(ed, '3pt')),
        toolCmd('slot', 'Slot', ico.slot, null, 'Straight slot from its two centres and width', (ed) => new SlotTool(ed)),
        toolCmd('polygon', 'Polygon', ico.polygon, null, 'Regular polygon, corners on a circle (type the number of sides)', (ed) => new PolygonTool(ed, true)),
        toolCmd('polygon-out', 'Polygon (flats)', ico.polygon, null, 'Regular polygon round a circle (sized across the flats)', (ed) => new PolygonTool(ed, false))
      ]
    },
    {
      label: 'Circles & arcs',
      commands: [
        toolCmd('circle', 'Circle', ico.circle, 'C', 'Circle from its centre and a point (or type Ø)', (ed) => new CircleTool(ed, 'centre')),
        toolCmd('circle-3pt', '3-point circle', ico.circle3, null, 'Circle through three points', (ed) => new CircleTool(ed, '3pt')),
        toolCmd('arc', 'Centre-point arc', ico.arc, 'A', 'Arc from its centre, start and end', (ed) => new ArcTool(ed, 'centre')),
        toolCmd('arc-3pt', '3-point arc', ico.arc3, null, 'Arc from its two ends and a point on it', (ed) => new ArcTool(ed, '3pt')),
        toolCmd('arc-tangent', 'Tangent arc', ico.arcTan, null, 'Arc carrying on smoothly from the end of a line or arc', (ed) => new ArcTool(ed, 'tangent')),
      ]
    },
    {
      label: 'Constrain',
      commands: [
        toolCmd('dimension', 'Smart dimension', ico.dimension, 'D', 'Dimension lengths, diameters, radii, distances and angles; the box and arrow set the size', (ed) => new DimensionTool(ed)),
        {
          id: 'sketch.relations',
          label: 'Show relations',
          icon: ico.relations,
          tooltip: 'Show every relation (H, V, ∥, =, T...). Off: only those on what you hover or select (G in a sketch)',
          isEnabled: editing,
          isActive: () => allRelationsShown(),
          run: () => setAllRelationsShown(!allRelationsShown())
        }
      ]
    },
    {
      label: 'Modify',
      commands: [
        toolCmd('trim', 'Trim', ico.trim, 'T', 'Click the part of a curve to cut away', (ed) => new TrimTool(ed)),
        toolCmd('extend', 'Extend', ico.extend, 'E', 'Click near an end to run it to the next curve', (ed) => new ExtendTool(ed)),
        toolCmd('fillet', 'Fillet', ico.fillet, null, 'Round a corner of two lines', (ed) => new FilletTool(ed)),
        toolCmd('chamfer', 'Chamfer', ico.chamfer, null, 'Bevel a corner of two lines', (ed) => new ChamferTool(ed)),
        toolCmd('offset', 'Offset', ico.offset, 'O', 'Copy a connected chain of curves a distance to one side', (ed) => new OffsetTool(ed)),
        toolCmd('mirror', 'Mirror', ico.mirror, null, 'Mirror the selection about a line (keeps them symmetric)', mirrorTool)
      ]
    }
  ]
}
