import * as THREE from 'three'
import { Emitter } from './events'

export type NodeKind = 'file' | 'assembly' | 'body'

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
  expanded: boolean
}

type DocEvents = {
  changed: void
  selection: string[]
}

let nextId = 1
const newId = (): string => `n${nextId++}`
const EDGE_TAG = '__edges'
/** Names exporters give bodies that tell the user nothing. */
const GENERIC = /^(solid|body|mesh|shape|part|object|geometry|default|node)?[\s_-]*\d*$/i

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
    this.buildChildren(object, file)
    // A file holding exactly one assembly is that assembly: lift its contents up.
    if (file.children.length === 1 && file.children[0].kind === 'assembly') {
      const only = file.children[0]
      this.nodes.delete(only.id)
      file.children = only.children
      file.children.forEach((c) => (c.parent = file))
    }
    // A file with nothing recognisable still gets one body so it can be selected.
    if (file.children.length === 0) this.makeBody(object, opts.name, file)
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

  setVisible(id: string, visible: boolean): void {
    const n = this.nodes.get(id)
    if (!n) return
    n.object.visible = visible
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

  // ---- geometry ----------------------------------------------------------

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
    if (!c.name || GENERIC.test(c.name)) c.name = c.kind === 'body' ? `Body ${++i}` : `Assembly ${++i}`
    const k = seen.get(c.name) ?? 0
    seen.set(c.name, k + 1)
    if (k > 0) c.name = `${c.name} (${k + 1})`
    dedupeNames(c)
  }
}
