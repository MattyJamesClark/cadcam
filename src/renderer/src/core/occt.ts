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
  /** Triangle range, colour and CAD face index of each face. */
  faces: [number, number, RGB | null, number?][]
  edges: Float32Array
  /** Per CAD edge: first segment in `edges`, segment count. */
  edgeRanges?: Uint32Array
  /** Per CAD vertex: x, y, z. */
  vertices?: Float32Array
  /** The exact body (OCCT binary B-rep), kept so it can be exported again. */
  brep?: Uint8Array
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { resolve: (r: any) => void; reject: (e: Error) => void; progress?: CadProgress }
>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('vendor/cadkernel/worker.mjs', document.baseURI), { type: 'module' })
  worker.onmessage = (
    ev: MessageEvent<{ id: number; result?: unknown; error?: string; stage?: string; done?: number; total?: number }>
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

/** A node of the model as the kernel's writer takes it (see kernel/cadkernel.cpp). */
export interface CadWriteNode {
  name: string
  kind: 'assembly' | 'part' | 'body'
  color?: RGB
  layers?: string[]
  /** Placement in the parent, row-major 3x4. */
  matrix?: number[]
  children?: CadWriteNode[]
  brep?: Uint8Array
  brepId?: number
  prim?: Record<string, unknown>
  mesh?: { position: Float32Array; index?: Uint32Array }
}

export interface CadWriteResult {
  bytes: Uint8Array
  /** Bodies with no usable geometry (e.g. huge meshes, point clouds). */
  skipped: number
  /** Mesh bodies written as faceted solids. */
  faceted: number
}

/** Write STEP / IGES / BREP through the CAD kernel. */
export function writeCadFile(
  format: 'step' | 'iges' | 'brep',
  root: CadWriteNode,
  progress?: CadProgress
): Promise<CadWriteResult> {
  const id = nextId++
  return new Promise<CadWriteResult>((resolve, reject) => {
    pending.set(id, { resolve, reject, progress })
    // Structured clone copies the B-rep buffers, so the scene keeps its own.
    getWorker().postMessage({ id, op: 'write', format, spec: { root } })
  })
}

// ---- measuring -----------------------------------------------------------------
// The kernel keeps bodies it has measured, by key, so each B-rep is sent once.

const brepKeys = new WeakMap<Uint8Array, number>()
let nextKey = 1
let sentKeys = new Set<number>()
let sentFor: Worker | null = null

export interface MeasureItem {
  brep: Uint8Array
  kind: 'body' | 'face' | 'edge' | 'vertex'
  index: number
  /** Body to world (or datum) placement, row-major 3x4. */
  matrix: number[]
}

async function kernelCall<T>(op: 'measure' | 'bounds', items: { brep: Uint8Array; [k: string]: unknown }[]): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const w = getWorker()
    if (sentFor !== w) {
      sentFor = w
      sentKeys = new Set()
    }
    const payload = items.map(({ brep, ...rest }) => {
      let key = brepKeys.get(brep)
      if (key === undefined) brepKeys.set(brep, (key = nextKey++))
      const first = !sentKeys.has(key)
      sentKeys.add(key)
      return { ...rest, key, brep: first ? brep : undefined }
    })
    const id = nextId++
    try {
      return await new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        w.postMessage({ id, op, items: payload })
      })
    } catch (e) {
      // The kernel lost its copy (restarted): send everything again.
      if ((e as Error).message !== 'missing-shape' || attempt) throw e
      sentKeys = new Set()
    }
  }
  throw new Error('unreachable')
}

export type Vec3 = [number, number, number]
export interface MeasureResult {
  items: Record<string, unknown>[]
  pair?: { distance?: number; p1?: Vec3; p2?: Vec3; angle?: number; centerDistance?: number; c1?: Vec3; c2?: Vec3 }
}

/** Exact properties of 1 or 2 picked items, and how they relate. */
export function measureCad(items: MeasureItem[]): Promise<MeasureResult> {
  return kernelCall<MeasureResult>('measure', items as unknown as { brep: Uint8Array }[])
}

/** Exact bounding box of bodies; matrices take each body into the frame to measure in. */
export function boundsCad(items: { brep: Uint8Array; matrix: number[] }[]): Promise<{ min: Vec3; max: Vec3 }> {
  return kernelCall('bounds', items)
}

// ---- import cache (IndexedDB) ---------------------------------------------
// Converting B-rep to triangles is the slow part of an import, and toolmakers
// reopen the same files a lot. The result is kept per file content + quality.

/** Bump when the reader's output changes, so stale results aren't reused. */
const READER_VERSION = 6
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
    if (m.brep) geo.userData.brep = m.brep
    if (m.edgeRanges) geo.userData.edgeRanges = m.edgeRanges
    if (m.vertices) geo.userData.vertices = m.vertices
    if (m.index.length === 0) return geo // wireframe body: edges only
    let index = m.index
    // CAD face of each triangle (in the final triangle order), for picking faces.
    const triFace = m.faces[0]?.[3] !== undefined ? new Int32Array(m.index.length / 3) : null
    if (triFace) for (const [first, last, , f] of m.faces) triFace.fill(f!, first, last + 1)
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
      const sorted = triFace ? new Int32Array(triFace.length) : null
      keys.forEach((k, gi) => {
        const start = at
        for (const [first, last] of byKey.get(k)!) {
          index.set(m.index.subarray(first * 3, (last + 1) * 3), at)
          sorted?.set(triFace!.subarray(first, last + 1), at / 3)
          at += (last - first + 1) * 3
        }
        geo.addGroup(start, at - start, gi)
      })
      geo.userData.grouped = keys
      if (sorted) geo.userData.triFace = sorted
    } else if (triFace) geo.userData.triFace = triFace
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
      if (src.brep) geo.userData.brep = src.brep
      if (src.edgeRanges) geo.userData.edgeRanges = src.edgeRanges
      if (src.vertices) geo.userData.vertices = src.vertices
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
