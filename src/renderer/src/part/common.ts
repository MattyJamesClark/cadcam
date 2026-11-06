import * as THREE from 'three'
import { solidsGeometry, type SolidMake, type SolidSpec, type Vec3 } from '@/core/occt'
import type { ModuleContext } from '@/core/types'
import { el } from '@/core/toolpanel'

/** Shared bits of the Part Design commands. */

export type Mode = 'new' | 'fuse' | 'cut' | 'common'
export const MODE_LABEL: Record<Mode, string> = { new: 'New body', fuse: 'Add', cut: 'Cut', common: 'Intersect' }
export const MODE_COLOUR: Record<Mode, number> = { new: 0x4fb3ff, fuse: 0x45c46b, cut: 0xff5a4f, common: 0xb07cff }

export function previewMaterial(color: number, opacity = 0.5): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
}

/** The kernel's text B-rep read back as a mesh geometry (with its exact B-rep attached for later edits). */
export async function geometryOf(bytes: Uint8Array): Promise<THREE.BufferGeometry> {
  // Every solid of the result is kept (see solidsGeometry).
  return solidsGeometry(bytes)
}

/** Every body in the document that has an exact B-rep (can take part in solid modelling). */
export function solidBodies(ctx: ModuleContext): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  for (const n of ctx.doc.bodies()) {
    const m = n.object as THREE.Mesh
    if (m.isMesh && m.geometry?.userData.brep && ctx.doc.isShown(n)) out.push(m)
  }
  return out
}

export const bodyName = (ctx: ModuleContext, m: THREE.Mesh | null): string => (m ? (ctx.doc.get(m.userData.docId as string)?.name ?? 'body') : 'none')

/** Move a solid-making spec into another frame (e.g. the target body's own). */
export function transformMake(mk: SolidMake, m: THREE.Matrix4): SolidMake {
  const P = (p: Vec3): Vec3 => new THREE.Vector3(...p).applyMatrix4(m).toArray() as Vec3
  const D = (p: Vec3): Vec3 => new THREE.Vector3(...p).transformDirection(m).toArray() as Vec3
  const seg = (s: { a: Vec3; b: Vec3; m?: Vec3 }): { a: Vec3; b: Vec3; m?: Vec3 } => ({ a: P(s.a), b: P(s.b), ...(s.m ? { m: P(s.m) } : {}) })
  return {
    ...mk,
    origin: P(mk.origin),
    normal: D(mk.normal),
    profiles: mk.profiles.map((p) => ({ outer: p.outer.map(seg), holes: p.holes.map((h) => h.map(seg)) })),
    ...(mk.axisOrigin ? { axisOrigin: P(mk.axisOrigin) } : {}),
    ...(mk.axis ? { axis: D(mk.axis) } : {}),
    ...(mk.path ? { path: mk.path.map(seg) } : {})
  }
}

export type { SolidSpec }

/** A labelled number box for a command strip. */
export function numberBox(label: string, unit: string, value: number, tip: string, onInput: (v: number) => void): { group: HTMLElement; box: HTMLInputElement } {
  const group = el('div', 'vs-group')
  const box = el('input')
  box.type = 'number'
  box.className = 'vs-angle'
  box.value = String(value)
  box.title = tip
  box.addEventListener('input', () => {
    const v = parseFloat(box.value)
    onInput(Number.isFinite(v) ? v : 0)
  })
  group.append(el('span', 'vs-label', label), box)
  if (unit) group.append(el('span', 'vs-label', unit))
  return { group, box }
}

export function checkBox(label: string, tip: string, value: boolean, onChange: (v: boolean) => void): { label: HTMLLabelElement; box: HTMLInputElement } {
  const lab = el('label', 'check vs-check')
  const box = el('input')
  box.type = 'checkbox'
  box.checked = value
  box.addEventListener('change', () => onChange(box.checked))
  lab.title = tip
  lab.append(box, document.createTextNode(` ${label}`))
  return { label: lab, box }
}

/** Small segmented switch for a strip. */
export function strSeg<T extends string>(options: [T, string, string?][], value: T, onChange: (v: T) => void): { el: HTMLElement; set(v: T): void } {
  const seg = el('div', 'seg vs-seg')
  const buttons = new Map<T, HTMLButtonElement>()
  const set = (v: T): void => buttons.forEach((b, k) => b.classList.toggle('on', k === v))
  for (const [v, label, tip] of options) {
    const b = el('button', 'seg-btn', label)
    if (tip) b.title = tip
    b.addEventListener('click', () => {
      set(v)
      onChange(v)
    })
    buttons.set(v, b)
    seg.append(b)
  }
  set(value)
  return { el: seg, set }
}
