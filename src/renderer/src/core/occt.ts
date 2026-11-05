import * as THREE from 'three'
import { settings, type ImportQuality } from './settings'

/**
 * STEP / IGES / BREP import through OpenCascade (compiled to WebAssembly),
 * running in a background worker so big assemblies don't freeze the UI.
 */

interface OcctMesh {
  name?: string
  color?: [number, number, number]
  brep_faces?: { first: number; last: number; color: [number, number, number] | null }[]
  attributes: { position: { array: Float32Array }; normal?: { array: Float32Array } }
  index: { array: Uint32Array }
}
interface OcctNode {
  name?: string
  meshes: number[]
  children: OcctNode[]
}
interface OcctResult {
  root: OcctNode
  meshes: OcctMesh[]
}

const QUALITY: Record<ImportQuality, { linearDeflection: number; angularDeflection: number }> = {
  draft: { linearDeflection: 0.003, angularDeflection: 0.8 },
  normal: { linearDeflection: 0.001, angularDeflection: 0.35 },
  fine: { linearDeflection: 0.0003, angularDeflection: 0.15 }
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (r: OcctResult) => void; reject: (e: Error) => void }>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('vendor/occt/worker.js', document.baseURI))
  worker.onmessage = (ev: MessageEvent<{ id: number; result?: OcctResult; error?: string }>) => {
    const p = pending.get(ev.data.id)
    if (!p) return
    pending.delete(ev.data.id)
    if (ev.data.error) p.reject(new Error(ev.data.error))
    else p.resolve(ev.data.result!)
  }
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'CAD kernel failed to start'))
    pending.clear()
    worker = null
  }
  return worker
}

export async function readCadFile(format: 'step' | 'iges' | 'brep', data: ArrayBuffer): Promise<THREE.Object3D> {
  const q = QUALITY[settings.get().importQuality]
  const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', ...q }
  const id = nextId++
  const result = await new Promise<OcctResult>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    // Copy, so the caller's buffer stays usable; transfer the copy.
    const buf = data.slice(0)
    getWorker().postMessage({ id, format, buffer: buf, params }, [buf])
  })
  return buildScene(result)
}

function buildScene(res: OcctResult): THREE.Object3D {
  // Materials are shared within a body only, so selecting one body never tints another.
  let materials = new Map<string, THREE.MeshStandardMaterial>()
  const mat = (c: [number, number, number] | null | undefined): THREE.MeshStandardMaterial => {
    const key = c ? c.map((v) => v.toFixed(3)).join(',') : 'default'
    let m = materials.get(key)
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color: c ? new THREE.Color(c[0], c[1], c[2]) : settings.get().partColor,
        metalness: 0.15,
        roughness: 0.55,
        side: THREE.DoubleSide
      })
      if (!c) m.userData.defaultColor = true
      materials.set(key, m)
    }
    return m
  }

  const meshes = res.meshes.map((src, i) => {
    materials = new Map()
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(src.attributes.position.array, 3))
    if (src.attributes.normal) geo.setAttribute('normal', new THREE.BufferAttribute(src.attributes.normal.array, 3))
    geo.setIndex(new THREE.BufferAttribute(src.index.array, 1))
    if (!src.attributes.normal) geo.computeVertexNormals()

    // Per-face colours become geometry groups; otherwise one material for the body.
    const faces = src.brep_faces ?? []
    const faceColours = faces.some((f) => f.color)
    let material: THREE.Material | THREE.Material[]
    if (faceColours) {
      const list: THREE.MeshStandardMaterial[] = []
      const indexOf = new Map<THREE.MeshStandardMaterial, number>()
      for (const f of faces) {
        const m = mat(f.color ?? src.color)
        if (!indexOf.has(m)) {
          indexOf.set(m, list.length)
          list.push(m)
        }
        geo.addGroup(f.first * 3, (f.last - f.first + 1) * 3, indexOf.get(m)!)
      }
      material = list
    } else {
      material = mat(src.color)
    }
    const mesh = new THREE.Mesh(geo, material)
    mesh.name = src.name || `Body ${i + 1}`
    // Keep B-rep face ranges for face picking in later modules.
    mesh.userData.brepFaces = faces.map((f) => [f.first, f.last])
    return mesh
  })

  // Every mesh index is used once per occurrence; clone repeats so the
  // scene graph stays a tree.
  const used = new Set<number>()
  const build = (node: OcctNode): THREE.Group => {
    const g = new THREE.Group()
    g.name = node.name || ''
    for (const i of node.meshes) {
      g.add(used.has(i) ? cloneBody(meshes[i]) : meshes[i])
      used.add(i)
    }
    for (const c of node.children) g.add(build(c))
    return g
  }
  return build(res.root)
}

function cloneBody(m: THREE.Mesh): THREE.Mesh {
  const c = m.clone()
  c.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : m.material.clone()
  return c
}
