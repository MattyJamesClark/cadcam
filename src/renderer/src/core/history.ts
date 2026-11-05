import { Emitter } from './events'

/**
 * One undoable change. `dispose` runs when the entry is forgotten; `applied`
 * says whether the change is in effect at that point (so a deleted body's
 * geometry is freed only once it can no longer come back).
 */
export interface HistoryEntry {
  label: string
  undo(): void
  redo(): void
  dispose?(applied: boolean): void
}

type HistoryEvents = { changed: void }

const LIMIT = 100

/**
 * Undo / redo stack. Changes are recorded as they happen; several changes made
 * by one command are grouped with `batch` so they undo in one step.
 */
export class History extends Emitter<HistoryEvents> {
  private done: HistoryEntry[] = []
  private undone: HistoryEntry[] = []
  private group: HistoryEntry[] | null = null
  private groupLabel = ''
  /** True while undoing/redoing, so the replayed changes aren't recorded again. */
  private replaying = false
  /** Number of changes since the last save (negative after undoing past it). */
  private savedAt = 0
  private position = 0

  get canUndo(): boolean {
    return this.done.length > 0
  }
  get canRedo(): boolean {
    return this.undone.length > 0
  }
  /** Labels, oldest first. */
  get undoLabels(): string[] {
    return this.done.map((e) => e.label)
  }
  get redoLabels(): string[] {
    return [...this.undone].reverse().map((e) => e.label)
  }
  get dirty(): boolean {
    return this.position !== this.savedAt
  }

  record(entry: HistoryEntry): void {
    if (this.replaying) return
    if (this.group) {
      this.group.push(entry)
      return
    }
    this.push(entry)
  }

  /** Run `fn`, recording everything it changes as one step. */
  batch<T>(label: string, fn: () => T): T {
    if (this.group || this.replaying) return fn()
    this.group = []
    this.groupLabel = label
    try {
      return fn()
    } finally {
      const items = this.group
      this.group = null
      if (items.length === 1) this.push({ ...items[0], label })
      else if (items.length > 1)
        this.push({
          label: this.groupLabel,
          undo: () => [...items].reverse().forEach((e) => e.undo()),
          redo: () => items.forEach((e) => e.redo()),
          dispose: (applied) => items.forEach((e) => e.dispose?.(applied))
        })
    }
  }

  undo(steps = 1): void {
    for (let i = 0; i < steps && this.done.length; i++) {
      const e = this.done.pop()!
      this.replay(() => e.undo())
      this.undone.push(e)
      this.position--
    }
    this.emit('changed', undefined)
  }

  redo(steps = 1): void {
    for (let i = 0; i < steps && this.undone.length; i++) {
      const e = this.undone.pop()!
      this.replay(() => e.redo())
      this.done.push(e)
      this.position++
    }
    this.emit('changed', undefined)
  }

  markSaved(): void {
    this.savedAt = this.position
    this.emit('changed', undefined)
  }

  /** Forget everything (e.g. after opening a project). */
  reset(): void {
    this.done.forEach((e) => e.dispose?.(true))
    this.undone.forEach((e) => e.dispose?.(false))
    this.done = []
    this.undone = []
    this.position = this.savedAt = 0
    this.emit('changed', undefined)
  }

  private push(entry: HistoryEntry): void {
    // A new change makes the undone ones unreachable.
    this.undone.forEach((e) => e.dispose?.(false))
    this.undone = []
    if (this.savedAt > this.position) this.savedAt = -1
    this.done.push(entry)
    this.position++
    if (this.done.length > LIMIT) {
      this.done.shift()!.dispose?.(true)
      this.position--
      this.savedAt--
    }
    this.emit('changed', undefined)
  }

  private replay(fn: () => void): void {
    this.replaying = true
    try {
      fn()
    } finally {
      this.replaying = false
    }
  }
}
