import * as THREE from 'three'
import type { SketchData } from '../sketch/model'
import type { CadDocument, Dimension, DocNode, WorkPlane } from './document'

/**
 * CADCAM Studio project files (.ccs): the whole design in one file, so it opens
 * instantly and exactly as it was saved (tree, names, layers, colours, product
 * data, visibility), with no CAD kernel work.
 *
 * Layout:  "CCS1" | u32 JSON byte length | JSON (padded to 4) | binary buffers
 * The JSON describes the object tree; geometry arrays live in the binary part
 * and are referenced by { o: offset, l: element count, t: type }.
 */

export const PROJECT_EXT = 'ccs'
const MAGIC = 'CCS1'
const EDGE_TAG = '__edges'
/** userData worth keeping; everything else is runtime state. */
const KEEP = ['cadKind', 'layers', 'props', 'fileProps', 'solid', 'wireBody', '__node']

type ArrayKind = 'f32' | 'u32' | 'u16' | 'u8' | 'i16' | 'i8' | 'i32'
interface BufRef {
  o: number
  l: number
  t: ArrayKind
}
interface AttrJson extends BufRef {
  size: number
  norm?: boolean
}
interface GeoJson {
  attrs: Record<string, AttrJson>
  index?: BufRef
  groups?: [number, number, number][]
  edges?: BufRef
  /** Exact B-rep of the body (for STEP / IGES export). */
  brep?: BufRef
  /** Picking data: CAD face per triangle, edge segment ranges, vertex points. */
  triFace?: BufRef
  edgeRanges?: BufRef
  vertices?: BufRef
  /** Quick-shape parameters (exact export of boxes, cylinders, spheres). */
  prim?: Record<string, unknown>
}
interface MatJson {
  type: 'standard' | 'line' | 'points'
  color: [number, number, number]
  vc?: boolean
  def?: boolean
  side?: number
  metalness?: number
  roughness?: number
  opacity?: number
  size?: number
  atten?: boolean
}
interface ObjJson {
  type: 'group' | 'mesh' | 'lines' | 'points'
  name: string
  matrix?: number[]
  hidden?: boolean
  user?: Record<string, unknown>
  geo?: number
  mat?: number | number[]
  children?: ObjJson[]
}
interface RootJson {
  meta: { name: string; detail?: string; source?: string; props?: Record<string, string> }
  obj: ObjJson
}
interface ProjectJson {
  format: 'cadcam-studio'
  version: 1
  app?: string
  name: string
  roots: RootJson[]
}

const ARRAYS: Record<ArrayKind, { new (b: ArrayBuffer, o: number, l: number): ArrayLike<number> & ArrayBufferView }> = {
  f32: Float32Array,
  u32: Uint32Array,
  u16: Uint16Array,
  u8: Uint8Array,
  i16: Int16Array,
  i8: Int8Array,
  i32: Int32Array
}

function kindOf(a: ArrayLike<number>): ArrayKind {
  if (a instanceof Uint32Array) return 'u32'
  if (a instanceof Int32Array) return 'i32'
  if (a instanceof Uint16Array) return 'u16'
  if (a instanceof Uint8Array) return 'u8'
  if (a instanceof Int16Array) return 'i16'
  if (a instanceof Int8Array) return 'i8'
  return 'f32'
}

// ---- save ----------------------------------------------------------------------

export function saveProject(doc: CadDocument, appVersion?: string): Uint8Array {
  const chunks: Uint8Array[] = []
  let size = 0
  const put = (arr: ArrayLike<number>): BufRef => {
    const typed: ArrayBufferView & ArrayLike<number> =
      ArrayBuffer.isView(arr) && !(arr instanceof Float64Array) ? (arr as ArrayBufferView & ArrayLike<number>) : new Float32Array(arr)
    const t = kindOf(typed)
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength)
    const o = size
    chunks.push(bytes.slice())
    size += bytes.byteLength
    const pad = (4 - (size % 4)) % 4
    if (pad) {
      chunks.push(new Uint8Array(pad))
      size += pad
    }
    return { o, l: typed.length, t }
  }

  const geos = new Map<THREE.BufferGeometry, number>()
  const geoJson: GeoJson[] = []
  const geoId = (g: THREE.BufferGeometry): number => {
    let id = geos.get(g)
    if (id !== undefined) return id
    const attrs: Record<string, AttrJson> = {}
    for (const name of ['position', 'normal', 'color', 'uv'] as const) {
      const a = g.getAttribute(name) as THREE.BufferAttribute | undefined
      if (!a || (a as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) continue
      attrs[name] = { ...put(a.array), size: a.itemSize, norm: a.normalized || undefined }
    }
    const json: GeoJson = { attrs }
    if (g.index) json.index = put(g.index.array)
    if (g.groups.length) json.groups = g.groups.map((gr) => [gr.start, gr.count, gr.materialIndex ?? 0])
    if (g.userData.edgePositions) json.edges = put(g.userData.edgePositions as Float32Array)
    if (g.userData.brep) json.brep = put(g.userData.brep as Uint8Array)
    for (const k of ['triFace', 'edgeRanges', 'vertices'] as const) if (g.userData[k]) json[k] = put(g.userData[k] as ArrayLike<number>)
    if (g.userData.prim) json.prim = g.userData.prim
    id = geoJson.length
    geoJson.push(json)
    geos.set(g, id)
    return id
  }

  const mats = new Map<THREE.Material, number>()
  const matJson: MatJson[] = []
  const matId = (m: THREE.Material): number => {
    let id = mats.get(m)
    if (id !== undefined) return id
    const c = (m as THREE.MeshStandardMaterial).color ?? new THREE.Color(0xb8c2cc)
    const j: MatJson = {
      type: (m as THREE.LineBasicMaterial).isLineBasicMaterial ? 'line' : (m as THREE.PointsMaterial).isPointsMaterial ? 'points' : 'standard',
      color: [c.r, c.g, c.b]
    }
    if ((m as THREE.MeshStandardMaterial).vertexColors) j.vc = true
    if (m.userData.defaultColor) j.def = true
    if (m.side !== THREE.FrontSide) j.side = m.side
    if (m.transparent && m.opacity < 1) j.opacity = m.opacity
    const std = m as THREE.MeshStandardMaterial
    if (std.isMeshStandardMaterial) {
      j.metalness = std.metalness
      j.roughness = std.roughness
    }
    const pts = m as THREE.PointsMaterial
    if (pts.isPointsMaterial) {
      j.size = pts.size
      j.atten = pts.sizeAttenuation
    }
    id = matJson.length
    matJson.push(j)
    mats.set(m, id)
    return id
  }

  const objJson = (o: THREE.Object3D): ObjJson => {
    const mesh = o as THREE.Mesh
    const j: ObjJson = {
      type: (o as THREE.LineSegments).isLineSegments ? 'lines' : (o as THREE.Points).isPoints ? 'points' : mesh.isMesh ? 'mesh' : 'group',
      name: o.name
    }
    o.updateMatrix()
    if (!o.matrix.equals(new THREE.Matrix4())) j.matrix = o.matrix.toArray()
    if (!o.visible) j.hidden = true
    const user: Record<string, unknown> = {}
    for (const k of KEEP) if (o.userData[k] !== undefined) user[k] = o.userData[k]
    if (Object.keys(user).length) j.user = user
    if (j.type !== 'group' && mesh.geometry) {
      j.geo = geoId(mesh.geometry)
      j.mat = Array.isArray(mesh.material) ? mesh.material.map(matId) : matId(mesh.material)
    }
    const kids = o.children.filter((c) => c.name !== EDGE_TAG).map(objJson)
    if (kids.length) j.children = kids
    return j
  }

  // Tag every tree node's object so the tree can be rebuilt exactly.
  const tagged: THREE.Object3D[] = []
  const tag = (n: DocNode): void => {
    n.object.userData.__node = { name: n.name, kind: n.kind, detail: n.detail, expanded: n.expanded }
    tagged.push(n.object)
    n.children.forEach(tag)
  }
  doc.roots.forEach(tag)
  let roots: RootJson[]
  try {
    roots = doc.roots.map((n) => ({
      meta: { name: n.name, detail: n.detail, source: n.source, props: n.kind === 'file' ? n.props : undefined },
      obj: objJson(n.object)
    }))
  } finally {
    tagged.forEach((o) => delete o.userData.__node)
  }

  const json = { format: 'cadcam-studio', version: 1, app: appVersion, name: doc.name, roots, geometries: geoJson, materials: matJson, dims: doc.dims, planes: doc.planes.filter((p) => !p.temp), sketches: doc.sketches }
  const text = new TextEncoder().encode(JSON.stringify(json))
  const jsonLen = text.byteLength + ((4 - (text.byteLength % 4)) % 4)
  const out = new Uint8Array(8 + jsonLen + size)
  out.set(new TextEncoder().encode(MAGIC), 0)
  new DataView(out.buffer).setUint32(4, jsonLen, true)
  out.set(text, 8)
  out.fill(0x20, 8 + text.byteLength, 8 + jsonLen) // pad JSON with spaces
  let at = 8 + jsonLen
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

// ---- open ----------------------------------------------------------------------

export function isProject(data: ArrayBuffer): boolean {
  return data.byteLength > 8 && new TextDecoder().decode(new Uint8Array(data, 0, 4)) === MAGIC
}

/** Read a project into objects ready for CadDocument.addRestored. */
export function readProject(data: ArrayBuffer): { name: string; roots: { object: THREE.Object3D; meta: RootJson['meta'] }[]; dims: Dimension[]; planes: WorkPlane[]; sketches: SketchData[] } {
  if (!isProject(data)) throw new Error('Not a CADCAM Studio project file')
  const jsonLen = new DataView(data).getUint32(4, true)
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 8, jsonLen))) as ProjectJson & {
    geometries: GeoJson[]
    materials: MatJson[]
  }
  if (json.format !== 'cadcam-studio') throw new Error('Not a CADCAM Studio project file')
  if (json.version > 1) throw new Error('This project was saved by a newer version of CADCAM Studio. Update the app to open it.')
  const binStart = 8 + jsonLen
  const arr = (r: BufRef): ArrayLike<number> & ArrayBufferView => {
    const C = ARRAYS[r.t]
    // Copy into its own buffer so the file's buffer can be released.
    const bytesPer = (C as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT
    const copy = data.slice(binStart + r.o, binStart + r.o + r.l * bytesPer)
    return new C(copy, 0, r.l)
  }

  const geometries = json.geometries.map((g) => {
    const geo = new THREE.BufferGeometry()
    for (const [name, a] of Object.entries(g.attrs)) geo.setAttribute(name, new THREE.BufferAttribute(arr(a) as THREE.TypedArray, a.size, !!a.norm))
    if (g.index) geo.setIndex(new THREE.BufferAttribute(arr(g.index) as THREE.TypedArray, 1))
    for (const [start, count, mi] of g.groups ?? []) geo.addGroup(start, count, mi)
    if (g.edges) geo.userData.edgePositions = arr(g.edges)
    if (g.brep) geo.userData.brep = arr(g.brep)
    for (const k of ['triFace', 'edgeRanges', 'vertices'] as const) if (g[k]) geo.userData[k] = arr(g[k]!)
    if (g.prim) geo.userData.prim = g.prim
    if (!geo.getAttribute('normal') && g.index) geo.computeVertexNormals()
    return geo
  })
  const materials = json.materials.map((m) => {
    let mat: THREE.Material
    if (m.type === 'line') mat = new THREE.LineBasicMaterial()
    else if (m.type === 'points')
      mat = new THREE.PointsMaterial({ size: m.size ?? 2, sizeAttenuation: m.atten ?? false, vertexColors: !!m.vc })
    else
      mat = new THREE.MeshStandardMaterial({
        metalness: m.metalness ?? 0.15,
        roughness: m.roughness ?? 0.55,
        side: (m.side ?? THREE.DoubleSide) as THREE.Side,
        vertexColors: !!m.vc
      })
    ;(mat as THREE.MeshStandardMaterial).color.setRGB(m.color[0], m.color[1], m.color[2])
    if (m.def) mat.userData.defaultColor = true
    if (m.opacity !== undefined) {
      mat.transparent = true
      mat.opacity = m.opacity
    }
    return mat
  })

  const build = (j: ObjJson): THREE.Object3D => {
    let o: THREE.Object3D
    const geo = j.geo !== undefined ? geometries[j.geo] : undefined
    const mat = j.mat === undefined ? undefined : Array.isArray(j.mat) ? j.mat.map((i) => materials[i]) : materials[j.mat]
    if (j.type === 'mesh' && geo) o = new THREE.Mesh(geo, mat as THREE.Material)
    else if (j.type === 'lines' && geo) o = new THREE.LineSegments(geo, mat as THREE.Material)
    else if (j.type === 'points' && geo) o = new THREE.Points(geo, mat as THREE.Material)
    else o = new THREE.Group()
    o.name = j.name
    if (j.matrix) new THREE.Matrix4().fromArray(j.matrix).decompose(o.position, o.quaternion, o.scale)
    if (j.hidden) o.visible = false
    if (j.user) Object.assign(o.userData, structuredClone(j.user))
    for (const c of j.children ?? []) o.add(build(c))
    return o
  }

  return {
    name: json.name,
    roots: json.roots.map((r) => ({ object: build(r.obj), meta: r.meta })),
    dims: ((json as { dims?: Dimension[] }).dims ?? []) as Dimension[],
    planes: ((json as { planes?: WorkPlane[] }).planes ?? []).filter((p) => Array.isArray(p.matrix) && p.matrix.length === 16),
    sketches: ((json as { sketches?: SketchData[] }).sketches ?? []).filter((k) => Array.isArray(k.plane) && k.plane.length === 16 && Array.isArray(k.points))
  }
}
