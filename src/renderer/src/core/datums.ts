import * as THREE from 'three'
import { Emitter } from './events'

/**
 * Datums: coordinate frames that measurements and bounding boxes can be
 * reported in: the world origin, then the user's work planes (Planes manager).
 */
export interface Datum {
  id: string
  name: string
  /** Datum frame to world. */
  matrix: THREE.Matrix4
}

class Datums extends Emitter<{ changed: void }> {
  private items: Datum[] = [{ id: 'world', name: 'Absolute', matrix: new THREE.Matrix4() }]

  list(): readonly Datum[] {
    return this.items
  }
  get(id: string): Datum {
    return this.items.find((d) => d.id === id) ?? this.items[0]
  }
  /** Replace the user datums (work planes); World stays first. */
  setUser(list: Datum[]): void {
    this.items = [this.items[0], ...list]
    this.emit('changed', undefined)
  }
  /** World to datum frame. */
  inverse(id: string): THREE.Matrix4 {
    return this.get(id).matrix.clone().invert()
  }
}

export const datums = new Datums()
