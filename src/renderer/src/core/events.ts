/** Tiny typed event emitter. */
export class Emitter<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<(p: never) => void>>()

  on<K extends keyof Events>(type: K, fn: (payload: Events[K]) => void): () => void {
    let set = this.handlers.get(type)
    if (!set) this.handlers.set(type, (set = new Set()))
    set.add(fn as (p: never) => void)
    return () => set!.delete(fn as (p: never) => void)
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    this.handlers.get(type)?.forEach((fn) => (fn as (p: Events[K]) => void)(payload))
  }
}
