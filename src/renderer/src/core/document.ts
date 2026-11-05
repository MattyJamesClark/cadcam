import * as THREE from 'three'
import { Emitter } from './events'

export interface DocItem {
  id: string
  name: string
  kind: string
  object: THREE.Object3D
  visible: boolean
  /** Original file name, if this item came from an import. */
  source?: string
}

type DocEvents = {
  changed: void
  selection: string[]
}

let nextId = 1

/**
 * The open design. Modules add and remove items here; the viewport and model
 * tree listen and stay in sync. Kept deliberately small so future modules
 * (sketch, part design, CAM toolpaths) can each own their own item kinds.
 */
export class CadDocument extends Emitter<DocEvents> {
  readonly root = new THREE.Group()
  private items = new Map<string, DocItem>()
  private selected = new Set<string>()
  name = 'Untitled'

  constructor() {
    super()
    this.root.name = 'document'
  }

  all(): DocItem[] {
    return [...this.items.values()]
  }

  get(id: string): DocItem | undefined {
    return this.items.get(id)
  }

  add(object: THREE.Object3D, opts: { name: string; kind: string; source?: string }): DocItem {
    const id = `item-${nextId++}`
    object.userData.docId = id
    object.traverse((o) => (o.userData.docId = id))
    const item: DocItem = { id, name: opts.name, kind: opts.kind, object, visible: true, source: opts.source }
    this.items.set(id, item)
    this.root.add(object)
    this.emit('changed', undefined)
    return item
  }

  remove(id: string): void {
    const item = this.items.get(id)
    if (!item) return
    this.root.remove(item.object)
    item.object.traverse((o) => {
      const m = o as THREE.Mesh
      m.geometry?.dispose()
      const mat = m.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
      else mat?.dispose()
    })
    this.items.delete(id)
    if (this.selected.delete(id)) this.emit('selection', this.selection())
    this.emit('changed', undefined)
  }

  clear(): void {
    for (const id of [...this.items.keys()]) this.remove(id)
    this.name = 'Untitled'
    this.emit('changed', undefined)
  }

  rename(id: string, name: string): void {
    const item = this.items.get(id)
    if (!item) return
    item.name = name
    this.emit('changed', undefined)
  }

  setVisible(id: string, visible: boolean): void {
    const item = this.items.get(id)
    if (!item) return
    item.visible = visible
    item.object.visible = visible
    this.emit('changed', undefined)
  }

  selection(): string[] {
    return [...this.selected]
  }

  select(ids: string[], additive = false): void {
    if (!additive) this.selected.clear()
    for (const id of ids) {
      if (additive && this.selected.has(id)) this.selected.delete(id)
      else if (this.items.has(id)) this.selected.add(id)
    }
    this.emit('selection', this.selection())
  }

  bounds(onlyVisible = true): THREE.Box3 {
    const box = new THREE.Box3()
    for (const item of this.items.values()) {
      if (onlyVisible && !item.visible) continue
      box.expandByObject(item.object)
    }
    return box
  }
}
