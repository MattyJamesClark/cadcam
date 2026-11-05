import * as THREE from 'three'
import type { ModuleContext } from './types'
import { Emitter } from './events'
import { Highlights, pickAt, pickKey, type Pick } from './picking'

/**
 * The one selection the whole app works on. A click selects one item at a
 * time (clicking it again deselects it); with Shift held, or Multi-select on
 * (bottom bar), clicks add items and take them out again. What a click can pick is set by the
 * selection filter. Whole bodies live in the document's selection (so the tree,
 * Translate and Delete see them); points, edges and faces are kept here.
 * Previous swaps back the selection before the last change, to recover from a
 * stray click or an accidental clear.
 */

const HOVER = 0xfff1a8
const SELECTED = 0xff9f1c

interface Snapshot {
  nodes: string[]
  subs: Pick[]
}

class Selection extends Emitter<{ changed: void; hover: { pick: Pick | null; x: number; y: number } }> {
  private ctx: ModuleContext | null = null
  private subs: Pick[] = []
  private hover: Pick | null = null
  private hl: Highlights | null = null
  private last: Snapshot = { nodes: [], subs: [] }
  private previous: Snapshot | null = null
  private queued: PointerEvent | null = null
  /** Multi-select button on the bottom bar. */
  multi = false

  /** Points, edges and faces picked (bodies are in doc.selection()). */
  get items(): readonly Pick[] {
    return this.subs
  }
  get nodes(): string[] {
    return this.ctx?.doc.selection() ?? []
  }
  get isEmpty(): boolean {
    return !this.subs.length && !this.nodes.length
  }
  get hasPrevious(): boolean {
    return !!this.previous && (this.previous.nodes.length > 0 || this.previous.subs.length > 0)
  }

  start(ctx: ModuleContext): void {
    if (this.ctx) return
    this.ctx = ctx
    const vp = ctx.viewport
    this.hl = new Highlights(vp)
    const canvas = vp.renderer.domElement
    let down: { x: number; y: number } | null = null
    canvas.addEventListener('pointerdown', (e) => {
      down = e.button === 0 && !vp.blockPick?.() ? { x: e.clientX, y: e.clientY } : null
    })
    canvas.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !down) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
      down = null
      if (moved > 4 || vp.blockPick?.()) return
      const p = pickAt(vp, e)
      if (p) this.pick(p, this.multi || e.shiftKey)
      // Empty space clears (Previous brings it back); a body the filter skips does not.
      else if (!vp.hitTest(vp.ndcOf(e))) this.clear()
    })
    canvas.addEventListener('pointermove', (e) => {
      const first = !this.queued
      this.queued = e
      if (first) requestAnimationFrame(() => this.move())
    })
    canvas.addEventListener('pointerleave', () => this.setHover(null, 0, 0))
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || vp.blockPick?.()) return
      const t = e.target as HTMLElement
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || document.querySelector('.modal-backdrop, .menu-pop, .group-menu')) return
      this.clear()
    })
    ctx.doc.on('selection', () => this.changed())
    // Edits can remove or move what was picked.
    ctx.doc.history.on('changed', () => {
      const live = (o: THREE.Object3D): boolean => {
        for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === vp.scene) return true
        return false
      }
      const keep = this.subs.filter((p) => live(p.object))
      if (keep.length !== this.subs.length) this.subs = keep
      this.changed()
    })
  }

  private move(): void {
    const e = this.queued
    this.queued = null
    const vp = this.ctx?.viewport
    if (!e || !vp) return
    if (e.buttons || vp.blockPick?.()) return this.setHover(null, e.clientX, e.clientY)
    this.setHover(pickAt(vp, e), e.clientX, e.clientY)
  }

  private setHover(p: Pick | null, x: number, y: number): void {
    const same = (p && pickKey(p)) === (this.hover && pickKey(this.hover))
    this.hover = p
    if (!same) this.draw()
    this.emit('hover', { pick: p, x, y })
  }

  /** Select the item alone, or with `add` add it / take it out. Picking the only selected item again deselects it. */
  pick(p: Pick, add: boolean): void {
    if (add) return this.toggle(p)
    const doc = this.ctx!.doc
    const id = p.object.userData.docId as string | undefined
    const k = pickKey(p)
    const alone =
      p.kind === 'body'
        ? !this.subs.length && this.nodes.length === 1 && this.nodes[0] === id
        : !this.nodes.length && this.subs.length === 1 && pickKey(this.subs[0]) === k
    if (alone) return this.clear()
    if (p.kind === 'body') {
      this.subs = []
      if (id) doc.select([id])
      return
    }
    this.subs = [p]
    if (this.nodes.length) doc.select([])
    else this.changed()
  }

  /** Add the item, or take it out if it is already selected. */
  toggle(p: Pick): void {
    const doc = this.ctx!.doc
    if (p.kind === 'body') {
      const id = p.object.userData.docId as string | undefined
      if (id) doc.select([id], true)
      return
    }
    const k = pickKey(p)
    const i = this.subs.findIndex((x) => pickKey(x) === k)
    this.subs = i >= 0 ? this.subs.filter((_, j) => j !== i) : [...this.subs, p]
    this.changed()
  }

  clear(): void {
    if (this.isEmpty) return
    this.subs = []
    if (this.nodes.length) this.ctx!.doc.select([])
    else this.changed()
  }

  /** Swap back to the selection before the last change. */
  restorePrevious(): void {
    const prev = this.previous
    if (!prev || !this.ctx) return
    this.subs = prev.subs
    this.ctx.doc.select(prev.nodes.filter((id) => this.ctx!.doc.get(id)))
    this.changed()
  }

  private changed(): void {
    const now: Snapshot = { nodes: this.nodes, subs: [...this.subs] }
    const key = (s: Snapshot): string => [...s.nodes, ...s.subs.map(pickKey)].join('|')
    if (key(now) !== key(this.last)) {
      if (this.last.nodes.length || this.last.subs.length) this.previous = this.last
      this.last = now
    }
    this.draw()
    this.emit('changed', undefined)
  }

  private draw(): void {
    if (!this.hl) return
    const list = this.subs.map((pick) => ({ pick, color: SELECTED }))
    const h = this.hover
    if (h && !this.subs.some((p) => pickKey(p) === pickKey(h))) {
      const id = h.object.userData.docId as string | undefined
      // A selected body already shows in the accent colour.
      if (!(h.kind === 'body' && id && this.ctx?.doc.isSelected(id))) list.push({ pick: h, color: HOVER })
    }
    this.hl.set(list)
  }

  /** "2 faces, 1 edge, 3 bodies" */
  summary(): string {
    const counts = new Map<string, number>()
    const add = (k: string): void => void counts.set(k, (counts.get(k) ?? 0) + 1)
    for (const p of this.subs) add(p.kind === 'vertex' || p.kind === 'point' ? 'point' : p.kind)
    for (const id of this.nodes) {
      const n = this.ctx!.doc.get(id)
      const o = n?.object
      add(n?.kind === 'body' ? (o?.userData.solid === false ? 'surface' : 'body') : 'part')
    }
    const order: [string, string, string][] = [
      ['point', 'point', 'points'],
      ['edge', 'edge', 'edges'],
      ['face', 'face', 'faces'],
      ['surface', 'surface', 'surfaces'],
      ['body', 'body', 'bodies'],
      ['part', 'part', 'parts']
    ]
    return order
      .filter(([k]) => counts.get(k))
      .map(([k, one, many]) => `${counts.get(k)} ${counts.get(k) === 1 ? one : many}`)
      .join(', ')
  }
}

export const selection = new Selection()
