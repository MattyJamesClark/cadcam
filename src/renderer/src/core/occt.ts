import * as THREE from 'three'
import { settings } from './settings'

/**
 * STEP / IGES / BREP import through the full OpenCascade kernel (WebAssembly,
 * in a background worker). Keeps assemblies, names, colours and layers.
 */

type RGB = [number, number, number]
interface CadNode {
  name: string
  kind: 'assembly' | 'part' | 'body'
  color?: RGB | null
  layers?: string[]
  matrix?: number[]
  mesh?: number
  children: CadNode[]
}
interface CadMesh {
  position: Float32Array
  index: Uint32Array
  faces: [number, number, RGB | null][]
  edges: Float32Array
}
interface CadResult {
  root: CadNode
  meshes: CadMesh[]
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (r: CadResult) => void; reject: (e: Error) => void }>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('vendor/ocjs/worker.mjs', document.baseURI), { type: 'module' })
  worker.onmessage = (ev: MessageEvent<{ id: number; result?: CadResult; error?: string }>) => {
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

/** Start loading the kernel in the background (call at app start). */
export function warmUpCadKernel(): void {
  getWorker()
}

export async function readCadFile(format: 'step' | 'iges' | 'brep', data: ArrayBuffer): Promise<THREE.Object3D> {
  const id = nextId++
  const result = await new Promise<CadResult>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const buf = data.slice(0)
    getWorker().postMessage({ id, format, buffer: buf, quality: settings.get().importQuality }, [buf])
  })
  return buildScene(result)
}

function buildScene(res: CadResult): THREE.Object3D {
  // One geometry per distinct part, shared by every instance of it.
  const geometries = res.meshes.map((m) => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(m.position, 3))
    geo.setIndex(new THREE.BufferAttribute(m.index, 1))
    geo.computeVertexNormals() // vertices aren't shared between faces, so edges stay sharp
    geo.userData.edgePositions = m.edges
    return geo
  })

  const material = (c: RGB | null | undefined): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide })
    if (c) m.color.setRGB(c[0], c[1], c[2]) // OCCT colours are linear RGB, as three.js expects
    else {
      m.color.set(settings.get().partColor)
      m.userData.defaultColor = true
    }
    return m
  }

  const build = (n: CadNode, inherited: RGB | null): THREE.Object3D => {
    const color = n.color ?? inherited
    let obj: THREE.Object3D
    if (n.kind === 'body' && n.mesh !== undefined) {
      const src = res.meshes[n.mesh]
      const geo = geometries[n.mesh]
      const mesh = new THREE.Mesh(geo)
      const faceColours = src.faces.some((f) => f[2])
      if (faceColours) {
        // Per-face colours: one material per distinct colour, as geometry groups.
        // Groups live on the shared geometry, so set them up once.
        const keyOf = (c: RGB | null): string => (c ? c.map((v) => v.toFixed(4)).join(',') : 'body')
        const keys: string[] = []
        if (!geo.userData.grouped) {
          for (const [first, last, c] of src.faces) {
            const k = keyOf(c)
            if (!keys.includes(k)) keys.push(k)
            geo.addGroup(first * 3, (last - first + 1) * 3, keys.indexOf(k))
          }
          geo.userData.grouped = keys
        }
        const groupKeys = geo.userData.grouped as string[]
        mesh.material = groupKeys.map((k) =>
          material(k === 'body' ? color : (k.split(',').map(Number) as RGB))
        )
      } else {
        mesh.material = material(color)
      }
      obj = mesh
    } else {
      obj = new THREE.Group()
      for (const c of n.children) obj.add(build(c, color))
    }
    obj.name = n.name
    obj.userData.cadKind = n.kind
    if (n.layers?.length) obj.userData.layers = n.layers
    if (n.matrix) new THREE.Matrix4().fromArray(n.matrix).decompose(obj.position, obj.quaternion, obj.scale)
    return obj
  }
  return build(res.root, null)
}
