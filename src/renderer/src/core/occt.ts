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
  /** STEP product data (part number, description, revision...). */
  props?: Record<string, string>
  /** Curve-only body (wireframe geometry). */
  wire?: boolean
  /** Closed solid (has a volume), as opposed to loose faces / shells. */
  solid?: boolean
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
  /** File header data (author, originating system, schema...). */
  file?: Record<string, string>
}

export type CadProgress = (stage: string, done?: number, total?: number) => void

let worker: Worker | null = null
let nextId = 1
const pending = new Map<
  number,
  { resolve: (r: CadResult) => void; reject: (e: Error) => void; progress?: CadProgress }
>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('vendor/cadkernel/worker.mjs', document.baseURI), { type: 'module' })
  worker.onmessage = (
    ev: MessageEvent<{ id: number; result?: CadResult; error?: string; stage?: string; done?: number; total?: number }>
  ) => {
    const p = pending.get(ev.data.id)
    if (!p) return
    if (ev.data.stage) {
      p.progress?.(ev.data.stage, ev.data.done, ev.data.total)
      return
    }
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

export async function readCadFile(
  format: 'step' | 'iges' | 'brep',
  data: ArrayBuffer,
  progress?: CadProgress
): Promise<THREE.Object3D> {
  const quality = settings.get().importQuality
  // Files opened before come straight from the cache: no kernel work at all.
  const key = await cacheKey(data, format, quality)
  const cached = key ? await cacheGet(key) : null
  if (cached) {
    progress?.('Loading from cache')
    return buildScene(cached)
  }
  const id = nextId++
  const result = await new Promise<CadResult>((resolve, reject) => {
    pending.set(id, { resolve, reject, progress })
    const buf = data.slice(0)
    getWorker().postMessage({ id, format, buffer: buf, quality }, [buf])
  })
  if (key) void cachePut(key, result)
  return buildScene(result)
}

// ---- import cache (IndexedDB) ---------------------------------------------
// Converting B-rep to triangles is the slow part of an import, and toolmakers
// reopen the same files a lot. The result is kept per file content + quality.

/** Bump when the reader's output changes, so stale results aren't reused. */
const READER_VERSION = 4
const CACHE_ENTRIES = 24

async function cacheKey(data: ArrayBuffer, format: string, quality: string): Promise<string | null> {
  try {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
    return `${READER_VERSION}:${format}:${quality}:${[...hash].map((b) => b.toString(16).padStart(2, '0')).join('')}`
  } catch {
    return null
  }
}

let dbPromise: Promise<IDBDatabase> | null = null
function db(): Promise<IDBDatabase> {
  if (!dbPromise)
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('cadcam-import-cache', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('results')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction('results', mode).objectStore('results'))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
  )
}

const USED_KEY = 'cadcam.importCacheUsed'
function usedMap(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(USED_KEY) || '{}')
  } catch {
    return {}
  }
}
function touch(key: string): Record<string, number> {
  const used = usedMap()
  used[key] = Date.now()
  try {
    localStorage.setItem(USED_KEY, JSON.stringify(used))
  } catch {
    /* ignore */
  }
  return used
}

async function cacheGet(key: string): Promise<CadResult | null> {
  try {
    const hit = (await tx('readonly', (s) => s.get(key))) as CadResult | undefined
    if (!hit) return null
    touch(key)
    return hit
  } catch {
    return null
  }
}

async function cachePut(key: string, result: CadResult): Promise<void> {
  try {
    await tx('readwrite', (s) => s.put(result, key))
    const used = touch(key)
    // Keep the cache small: drop the least recently used entries.
    const keys = (await tx('readonly', (s) => s.getAllKeys())) as string[]
    if (keys.length <= CACHE_ENTRIES) return
    keys.sort((a, b) => (used[a] ?? 0) - (used[b] ?? 0))
    for (const k of keys.slice(0, keys.length - CACHE_ENTRIES)) {
      await tx('readwrite', (s) => s.delete(k))
      delete used[k]
    }
    localStorage.setItem(USED_KEY, JSON.stringify(used))
  } catch {
    /* cache is best-effort */
  }
}

function buildScene(res: CadResult): THREE.Object3D {
  // One geometry per distinct part, shared by every instance of it.
  const keyOf = (c: RGB | null): string => (c ? c.map((v) => v.toFixed(4)).join(',') : 'body')
  const geometries = res.meshes.map((m) => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(m.position, 3))
    geo.userData.edgePositions = m.edges
    if (m.index.length === 0) return geo // wireframe body: edges only
    let index = m.index
    if (m.faces.some((f) => f[2])) {
      // Sort triangles by colour so each colour is one draw call, not one per face.
      const keys: string[] = []
      const byKey = new Map<string, [number, number][]>()
      for (const [first, last, c] of m.faces) {
        const k = keyOf(c)
        if (!byKey.has(k)) {
          byKey.set(k, [])
          keys.push(k)
        }
        byKey.get(k)!.push([first, last])
      }
      index = new Uint32Array(m.index.length)
      let at = 0
      keys.forEach((k, gi) => {
        const start = at
        for (const [first, last] of byKey.get(k)!) {
          index.set(m.index.subarray(first * 3, (last + 1) * 3), at)
          at += (last - first + 1) * 3
        }
        geo.addGroup(start, at - start, gi)
      })
      geo.userData.grouped = keys
    }
    geo.setIndex(new THREE.BufferAttribute(index, 1))
    geo.computeVertexNormals() // vertices aren't shared between faces, so edges stay sharp
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
    if (n.kind === 'body' && n.mesh !== undefined && n.wire) {
      // Wireframe geometry (curves): drawn as lines in its own colour.
      const src = res.meshes[n.mesh]
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(src.edges, 3))
      const mat = new THREE.LineBasicMaterial()
      if (color) mat.color.setRGB(color[0], color[1], color[2])
      else mat.userData.defaultColor = true
      const lines = new THREE.LineSegments(geo, mat)
      lines.userData.wireBody = true
      obj = lines
    } else if (n.kind === 'body' && n.mesh !== undefined) {
      const geo = geometries[n.mesh]
      const mesh = new THREE.Mesh(geo)
      if (geo.userData.grouped) {
        // Per-face colours: one material per distinct colour, as geometry groups.
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
    if (n.props && Object.keys(n.props).length) obj.userData.props = n.props
    if (n.kind === 'body') obj.userData.solid = !!n.solid
    if (n.matrix) new THREE.Matrix4().fromArray(n.matrix).decompose(obj.position, obj.quaternion, obj.scale)
    return obj
  }
  const root = build(res.root, null)
  if (res.file) root.userData.fileProps = res.file
  return root
}
