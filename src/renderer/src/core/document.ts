import * as THREE from 'three'
import { Emitter } from './events'

/** part = one CAD part that holds several bodies. */
export type NodeKind = 'file' | 'assembly' | 'part' | 'body'

/** One row of the model tree: an imported file, a sub-assembly, or a body. */
export interface DocNode {
  id: string
  name: string
  kind: NodeKind
  object: THREE.Object3D
  children: DocNode[]
  parent: DocNode | null
  /** Format name for files ("STEP"), shape type for bodies ("Box"). */
  detail?: string
  /** Original file name, for file nodes. */
  source?: string
  /** Layers / levels the source CAD file put this on. */
  layers?: string[]
  /** Product data from the source file (part number, description...) or, for files, header data. */
  props?: Record<string, string>
  expanded: boolean
}

/** Geometry facts about a node, for the properties panel. */
export interface Measure {
  bodies: number
  triangles: number
  /** Axis-aligned size in world space (mm). */
  size: THREE.Vector3 | null
  /** Surface area (mm²). */
  area: number
  /** Enclosed volume (mm³); null if any body is open or wireframe. */
  volume: number | null
}

type DocEvents = {
  changed: void
  selection: string[]
}

let nextId = 1
const newId = (): string => `n${nextId++}`
const EDGE_TAG = '__edges'
/** Names exporters give bodies that tell the user nothing. */
/** Names exporters give bodies that tell the user nothing. Part numbers (long digit runs) are kept. */
const GENERIC = /^((solid|body|mesh|shape|part|object|geometry|default|node|compound|shell)[\s_-]*\d*|\d{0,2})$/i

const isRenderable = (o: THREE.Object3D): boolean =>
  ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.LineSegments).isLineSegments) &&
  o.name !== EDGE_TAG

function countBodies(o: THREE.Object3D): number {
  let n = 0
  o.traverse((c) => {
    if (isRenderable(c)) n++
  })
  return n
}

/**
 * The open design: a tree of files, sub-assemblies and bodies. Modules add and
 * remove nodes here; the viewport and model tree listen and stay in sync.
 * Every rendered mesh carries userData.docId = the id of the body it belongs
 * to, which is how picking in the viewport maps back to the tree.
 */
export class CadDocument extends Emitter<DocEvents> {
  readonly root = new THREE.Group()
  readonly roots: DocNode[] = []
  private nodes = new Map<string, DocNode>()
  private selected = new Set<string>()
  name = 'Untitled'

  constructor() {
    super()
    this.root.name = 'document'
  }

  // ---- queries -----------------------------------------------------------

  get(id: string): DocNode | undefined {
    return this.nodes.get(id)
  }

  /** Every node, depth-first. */
  all(): DocNode[] {
    const out: DocNode[] = []
    const walk = (n: DocNode): void => {
      out.push(n)
      n.children.forEach(walk)
    }
    this.roots.forEach(walk)
    return out
  }

  bodies(of?: DocNode): DocNode[] {
    return (of ? collect(of) : this.all()).filter((n) => n.kind === 'body')
  }

  isEmpty(): boolean {
    return this.roots.length === 0
  }

  /** True if the node and all its parents are visible. */
  isShown(n: DocNode): boolean {
    for (let p: DocNode | null = n; p; p = p.parent) if (!p.object.visible) return false
    return true
  }

  // ---- adding ------------------------------------------------------------

  /** Add an imported file. Its sub-assemblies and bodies become child nodes. */
  addFile(object: THREE.Object3D, opts: { name: string; format: string; source?: string }): DocNode {
    const file = this.makeNode(object, opts.name, 'file', null)
    file.detail = opts.format
    file.source = opts.source
    if (object.userData.fileProps) file.props = object.userData.fileProps
    this.buildChildren(object, file)
    // A file holding exactly one assembly is that assembly: lift its contents up.
    if (file.children.length === 1 && file.children[0].kind === 'assembly') {
      const only = file.children[0]
      if (only.layers && !file.layers) file.layers = only.layers
      this.nodes.delete(only.id)
      file.children = only.children
      file.children.forEach((c) => (c.parent = file))
    }
    // A file with nothing recognisable still gets one body so it can be selected.
    if (file.children.length === 0) this.makeBody(object, (object.name && !GENERIC.test(object.name) && object.name) || opts.name, file)
    dedupeNames(file)
    this.roots.push(file)
    this.root.add(object)
    this.emit('changed', undefined)
    return file
  }

  /** Add a single standalone body (e.g. a quick shape). */
  addBody(object: THREE.Object3D, name: string, detail?: string): DocNode {
    const n = this.makeBody(object, name, null)
    n.detail = detail
    this.roots.push(n)
    this.root.add(object)
    this.emit('changed', undefined)
    return n
  }

  private makeNode(object: THREE.Object3D, name: string, kind: NodeKind, parent: DocNode | null): DocNode {
    const n: DocNode = { id: newId(), name, kind, object, children: [], parent, expanded: kind === 'file' }
    if (object.userData.layers) n.layers = object.userData.layers
    if (object.userData.props) n.props = object.userData.props
    this.nodes.set(n.id, n)
    parent?.children.push(n)
    return n
  }

  private makeBody(object: THREE.Object3D, name: string, parent: DocNode | null): DocNode {
    const n = this.makeNode(object, name, 'body', parent)
    object.traverse((o) => (o.userData.docId = n.id))
    return n
  }

  private buildChildren(obj: THREE.Object3D, parent: DocNode): void {
    for (const child of obj.children) {
      if (child.name === EDGE_TAG) continue
      // CAD kernel imports say exactly what each object is.
      const cadKind = child.userData.cadKind as NodeKind | undefined
      if (cadKind) {
        if (countBodies(child) === 0) continue
        if (cadKind === 'body') this.makeBody(child, child.name, parent)
        else this.buildChildren(child, this.makeNode(child, child.name, cadKind, parent))
        continue
      }
      if (isRenderable(child)) {
        this.makeBody(child, child.name, parent)
        continue
      }
      const bodies = countBodies(child)
      if (bodies === 0) continue
      const named = !!child.name && !GENERIC.test(child.name)
      if (bodies === 1 && named) this.makeBody(child, child.name, parent)
      else if (!named) this.buildChildren(child, parent)
      else this.buildChildren(child, this.makeNode(child, child.name, 'assembly', parent))
    }
  }

  // ---- editing -----------------------------------------------------------

  remove(id: string): void {
    const n = this.nodes.get(id)
    if (!n) return
    n.object.parent?.remove(n.object)
    // Dispose only what nobody else uses: geometry/material of this subtree.
    n.object.traverse((o) => {
      const m = o as THREE.Mesh
      m.geometry?.dispose()
    })
    for (const d of collect(n)) {
      this.nodes.delete(d.id)
      this.selected.delete(d.id)
    }
    const siblings = n.parent ? n.parent.children : this.roots
    siblings.splice(siblings.indexOf(n), 1)
    // Drop assemblies/files left empty.
    if (n.parent && n.parent.children.length === 0) this.remove(n.parent.id)
    this.emit('selection', this.selection())
    this.emit('changed', undefined)
  }

  clear(): void {
    for (const n of [...this.roots]) this.remove(n.id)
    this.name = 'Untitled'
    this.emit('changed', undefined)
  }

  rename(id: string, name: string): void {
    const n = this.nodes.get(id)
    if (!n) return
    n.name = name
    this.emit('changed', undefined)
  }

  setVisible(id: string | string[], visible: boolean): void {
    for (const i of Array.isArray(id) ? id : [id]) {
      const n = this.nodes.get(i)
      if (n) n.object.visible = visible
    }
    this.emit('changed', undefined)
  }

  /** Make everything visible again. */
  showAll(): void {
    this.all().forEach((n) => (n.object.visible = true))
    this.emit('changed', undefined)
  }

  setExpanded(id: string, expanded: boolean): void {
    const n = this.nodes.get(id)
    if (!n) return
    n.expanded = expanded
    this.emit('changed', undefined)
  }

  // ---- selection ---------------------------------------------------------

  selection(): string[] {
    return [...this.selected]
  }

  /** Selected nodes, without children whose parent is also selected. */
  selectedTopNodes(): DocNode[] {
    return this.selection()
      .map((id) => this.nodes.get(id)!)
      .filter((n) => {
        for (let p = n.parent; p; p = p.parent) if (this.selected.has(p.id)) return false
        return true
      })
  }

  /** Is this body selected directly or through a selected parent? */
  isSelected(id: string): boolean {
    for (let n = this.nodes.get(id) ?? null; n; n = n.parent) if (this.selected.has(n.id)) return true
    return false
  }

  select(ids: string[], additive = false): void {
    if (!additive) this.selected.clear()
    for (const id of ids) {
      if (additive && this.selected.has(id)) this.selected.delete(id)
      else if (this.nodes.has(id)) {
        this.selected.add(id)
        // Reveal it in the tree.
        for (let p = this.nodes.get(id)!.parent; p; p = p.parent) p.expanded = true
      }
    }
    this.emit('selection', this.selection())
  }

  /** Layers a node is on: its own, else the nearest parent's. */
  layersOf(n: DocNode): string[] {
    for (let p: DocNode | null = n; p; p = p.parent) if (p.layers?.length) return p.layers
    return []
  }

  /** Every layer used in the document, with the bodies on it ('' = no layer). */
  layerMap(): Map<string, DocNode[]> {
    const map = new Map<string, DocNode[]>()
    for (const b of this.bodies()) {
      const ls = this.layersOf(b)
      for (const l of ls.length ? ls : ['']) {
        if (!map.has(l)) map.set(l, [])
        map.get(l)!.push(b)
      }
    }
    return map
  }

  // ---- geometry ----------------------------------------------------------

  /** Bodies, triangles, size, area and volume of the given nodes (world space). */
  measure(nodes: DocNode[]): Measure {
    this.root.updateMatrixWorld(true)
    const seen = new Set<string>()
    const box = new THREE.Box3()
    let bodies = 0, triangles = 0, area = 0
    let volume: number | null = 0
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    const ab = new THREE.Vector3(), ac = new THREE.Vector3()
    for (const top of nodes)
      for (const body of collect(top)) {
        if (body.kind !== 'body' || seen.has(body.id)) continue
        seen.add(body.id)
        bodies++
        body.object.traverse((o) => {
          if (!isRenderable(o)) return
          box.expandByObject(o, false)
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh) {
            volume = null
            return
          }
          const pos = mesh.geometry.attributes.position
          const idx = mesh.geometry.index
          const m = mesh.matrixWorld
          const n = idx ? idx.count : pos.count
          triangles += n / 3
          let vol = 0
          for (let i = 0; i < n; i += 3) {
            const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2
            a.fromBufferAttribute(pos, i0).applyMatrix4(m)
            b.fromBufferAttribute(pos, i1).applyMatrix4(m)
            c.fromBufferAttribute(pos, i2).applyMatrix4(m)
            area += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2
            vol += a.dot(ab.crossVectors(b, c)) / 6
          }
          if (volume !== null) volume += Math.abs(vol)
        })
      }
    // A body made of loose faces has no meaningful volume.
    const closed = nodes.every((t) => collect(t).every((n) => n.kind !== 'body' || n.object.userData.solid !== false))
    return {
      bodies,
      triangles,
      size: box.isEmpty() ? null : box.getSize(new THREE.Vector3()),
      area,
      volume: closed ? volume : null
    }
  }

  bounds(nodes?: DocNode[]): THREE.Box3 {
    this.root.updateMatrixWorld(true)
    const box = new THREE.Box3()
    for (const n of nodes ?? this.roots) {
      if (!this.isShown(n)) continue
      n.object.traverseVisible((o) => {
        if (isRenderable(o)) box.expandByObject(o, false)
      })
    }
    return box
  }
}

function collect(n: DocNode): DocNode[] {
  const out: DocNode[] = [n]
  n.children.forEach((c) => out.push(...collect(c)))
  return out
}

/** Give unnamed / generically named siblings readable unique names: Body 1, Body 2... */
function dedupeNames(n: DocNode): void {
  let i = 0
  const seen = new Map<string, number>()
  for (const c of n.children) {
    if (!c.name || GENERIC.test(c.name)) c.name = c.kind === 'body' ? (c.object.userData.wireBody ? `Wireframe ${++i}` : `Body ${++i}`) : c.kind === 'part' ? `Part ${++i}` : `Assembly ${++i}`
    const k = seen.get(c.name) ?? 0
    seen.set(c.name, k + 1)
    if (k > 0) c.name = `${c.name} (${k + 1})`
    dedupeNames(c)
  }
}
