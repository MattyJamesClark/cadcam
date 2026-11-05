import * as THREE from 'three'
import { Emitter } from './events'

/**
 * Datums: coordinate frames that measurements and bounding boxes can be
 * reported in. For now there is only the world origin; user datums (on a
 * face, a point, a hole...) will be added to this list later.
 */
export interface Datum {
  id: string
  name: string
  /** Datum frame to world. */
  matrix: THREE.Matrix4
}

class Datums extends Emitter<{ changed: void }> {
  private items: Datum[] = [{ id: 'world', name: 'World origin', matrix: new THREE.Matrix4() }]

  list(): readonly Datum[] {
    return this.items
  }
  get(id: string): Datum {
    return this.items.find((d) => d.id === id) ?? this.items[0]
  }
  /** World to datum frame. */
  inverse(id: string): THREE.Matrix4 {
    return this.get(id).matrix.clone().invert()
  }
}

export const datums = new Datums()
