import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js'
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js'
import { VRMLLoader } from 'three/examples/jsm/loaders/VRMLLoader.js'
import { AMFLoader } from 'three/examples/jsm/loaders/AMFLoader.js'
import { VTKLoader } from 'three/examples/jsm/loaders/VTKLoader.js'
import { USDLoader } from 'three/examples/jsm/loaders/USDLoader.js'
import { LWOLoader } from 'three/examples/jsm/loaders/LWOLoader.js'
import { PCDLoader } from 'three/examples/jsm/loaders/PCDLoader.js'
import { XYZLoader } from 'three/examples/jsm/loaders/XYZLoader.js'
import { Rhino3dmLoader } from 'three/examples/jsm/loaders/3DMLoader.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js'
import { PLYExporter } from 'three/examples/jsm/exporters/PLYExporter.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { normaliseImported, partMaterial, registerExporter, registerImporter } from './io'
import { readCadFile, writeCadFile, type CadWriteNode } from './occt'

const text = (data: ArrayBuffer): string => new TextDecoder().decode(data)
const meshOf = (geo: THREE.BufferGeometry): THREE.Mesh => {
  if (!geo.attributes.normal) geo.computeVertexNormals()
  const mat = partMaterial()
  if (geo.attributes.color) {
    mat.vertexColors = true
    mat.color.set(0xffffff)
    mat.userData.defaultColor = false
  }
  return new THREE.Mesh(geo, mat)
}
const pointsOf = (geo: THREE.BufferGeometry): THREE.Points =>
  new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      size: 2,
      sizeAttenuation: false,
      vertexColors: !!geo.attributes.color,
      color: geo.attributes.color ? 0xffffff : 0x9aa7b4
    })
  )

/** Every 3D format we can read and write. 2D formats (DXF, DWG) come later. */
export function registerBuiltinFormats(): void {
  // ---- B-rep solids via OpenCascade -------------------------------------
  registerImporter({ name: 'STEP', extensions: ['step', 'stp'], solid: true, load: (d, _n, p) => readCadFile('step', d, p) })
  registerImporter({ name: 'IGES', extensions: ['iges', 'igs'], solid: true, load: (d, _n, p) => readCadFile('iges', d, p) })
  registerImporter({ name: 'OpenCascade BREP', extensions: ['brep', 'brp'], solid: true, load: (d, _n, p) => readCadFile('brep', d, p) })
  registerImporter({
    name: 'Rhino 3DM',
    extensions: ['3dm'],
    load: (d) =>
      new Promise((resolve, reject) => {
        const loader = new Rhino3dmLoader()
        loader.setLibraryPath(new URL('vendor/rhino3dm/', document.baseURI).href)
        const timer = setTimeout(() => reject(new Error('timed out reading the Rhino file')), 120_000)
        loader.parse(
          d,
          (obj) => {
            clearTimeout(timer)
            resolve(normaliseImported(obj, false))
          },
          (e) => {
            clearTimeout(timer)
            reject(e instanceof Error ? e : new Error(String(e)))
          }
        )
      })
  })

  // ---- meshes -----------------------------------------------------------
  registerImporter({
    name: 'STL',
    extensions: ['stl'],
    async load(d) {
      const geo = new STLLoader().parse(d)
      geo.computeVertexNormals()
      return new THREE.Mesh(geo, partMaterial())
    }
  })
  registerImporter({
    name: 'Wavefront OBJ',
    extensions: ['obj'],
    upAxis: 'y',
    load: async (d) => normaliseImported(new OBJLoader().parse(text(d)), true)
  })
  registerImporter({ name: 'PLY', extensions: ['ply'], load: async (d) => meshOf(new PLYLoader().parse(d)) })
  registerImporter({
    name: 'glTF / GLB',
    extensions: ['glb', 'gltf'],
    upAxis: 'y',
    unitScale: 1000,
    load: async (d) => normaliseImported((await new GLTFLoader().parseAsync(d, '')).scene, false)
  })
  registerImporter({ name: '3MF', extensions: ['3mf'], load: async (d) => normaliseImported(new ThreeMFLoader().parse(d), false) })
  registerImporter({ name: 'AMF', extensions: ['amf'], load: async (d) => normaliseImported(new AMFLoader().parse(d), false) })
  registerImporter({
    name: 'Autodesk FBX',
    extensions: ['fbx'],
    upAxis: 'y',
    load: async (d) => normaliseImported(new FBXLoader().parse(d, ''), false)
  })
  registerImporter({
    name: 'Collada',
    extensions: ['dae'],
    upAxis: 'y',
    unitScale: 1000,
    load: async (d) => normaliseImported(new ColladaLoader().parse(text(d), '').scene, false)
  })
  registerImporter({ name: '3D Studio', extensions: ['3ds'], load: async (d) => normaliseImported(new TDSLoader().parse(d, ''), false) })
  registerImporter({
    name: 'VRML',
    extensions: ['wrl', 'vrml'],
    upAxis: 'y',
    load: async (d) => normaliseImported(new VRMLLoader().parse(text(d), ''), false)
  })
  registerImporter({
    name: 'USD',
    extensions: ['usdz', 'usda', 'usdc', 'usd'],
    upAxis: 'y',
    load: async (d) => normaliseImported(new USDLoader().parse(d), false)
  })
  registerImporter({
    name: 'LightWave',
    extensions: ['lwo'],
    upAxis: 'y',
    async load(d, name) {
      const g = new THREE.Group()
      new LWOLoader().parse(d, '', name).meshes.forEach((m) => g.add(m))
      return normaliseImported(g, false)
    }
  })
  registerImporter({ name: 'VTK', extensions: ['vtk', 'vtp'], load: async (d) => meshOf(new VTKLoader().parse(d, '')) })
  registerImporter({ name: 'OFF', extensions: ['off'], load: async (d) => meshOf(parseOff(text(d))) })

  // ---- point clouds (scanning) ------------------------------------------
  registerImporter({ name: 'PCD point cloud', extensions: ['pcd'], load: async (d) => new PCDLoader().parse(d) })
  registerImporter({
    name: 'XYZ point cloud',
    extensions: ['xyz'],
    load: (d) =>
      new Promise((resolve) => {
        // Typings lag behind: newer three returns the geometry, older calls back.
        const r = (new XYZLoader().parse as (t: string, cb: (g: THREE.BufferGeometry) => void) => unknown)(
          text(d),
          (g) => resolve(pointsOf(g))
        ) as THREE.BufferGeometry | undefined
        if (r && (r as THREE.BufferGeometry).isBufferGeometry) resolve(pointsOf(r))
      })
  })

  // ---- exporters ----------------------------------------------------------
  for (const [ext, format, name] of [
    ['step', 'step', 'STEP'],
    ['igs', 'iges', 'IGES'],
    ['brep', 'brep', 'OpenCascade BREP']
  ] as const) {
    const exp: Parameters<typeof registerExporter>[0] = {
      name,
      extension: ext,
      async write(root, progress) {
        const res = await writeCadFile(format, cadSpec(root), progress)
        const notes: string[] = []
        if (res.faceted) notes.push(`${res.faceted} mesh body(ies) written as faceted solids`)
        if (res.skipped) notes.push(`${res.skipped} item(s) left out (no exact geometry)`)
        exp.lastNote = notes.join(', ') || undefined
        return res.bytes
      }
    }
    registerExporter(exp)
  }
  registerExporter({
    name: 'STL (binary)',
    extension: 'stl',
    async write(root) {
      const dv = new STLExporter().parse(cleanForExport(root), { binary: true }) as DataView
      return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)
    }
  })
  registerExporter({
    name: 'Wavefront OBJ',
    extension: 'obj',
    write: async (root) => new TextEncoder().encode(new OBJExporter().parse(cleanForExport(root, true)))
  })
  registerExporter({
    name: 'PLY (binary)',
    extension: 'ply',
    write: (root) =>
      new Promise((resolve) => {
        new PLYExporter().parse(cleanForExport(root), (res) => resolve(new Uint8Array(res as ArrayBuffer)), { binary: true })
      })
  })
  registerExporter({
    name: 'GLB',
    extension: 'glb',
    async write(root) {
      const res = await new GLTFExporter().parseAsync(cleanForExport(root, true, 0.001), { binary: true })
      return new Uint8Array(res as ArrayBuffer)
    }
  })
}

/** Largest mesh (in triangles) the kernel turns into a faceted solid. */
const MAX_FACETED = 60000

/** The model as the CAD kernel's writer takes it: exact bodies where we have them. */
function cadSpec(root: THREE.Object3D): CadWriteNode {
  const brepIds = new Map<Uint8Array, number>()
  const identity = new THREE.Matrix4()
  const node = (o: THREE.Object3D, parentName: string): CadWriteNode | null => {
    if (!o.visible || o.name === '__edges') return null
    o.updateMatrix()
    const e = o.matrix.elements // column-major
    // Unnamed bodies of a part take the part's name (as most CAD systems show them).
    const base: CadWriteNode = { name: o.name || parentName, kind: 'assembly' }
    if (!o.matrix.equals(identity)) base.matrix = [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]]
    const layers = o.userData.layers as string[] | undefined
    if (layers?.length) base.layers = layers
    const shape = o as THREE.Mesh
    if ((shape.isMesh || (o as THREE.LineSegments).isLineSegments) && shape.geometry) {
      const geo = shape.geometry
      const mat = (Array.isArray(shape.material) ? shape.material[0] : shape.material) as THREE.MeshStandardMaterial
      const body: CadWriteNode = { ...base, kind: 'body' }
      if (mat?.color && !mat.userData.defaultColor && !mat.vertexColors) body.color = [mat.color.r, mat.color.g, mat.color.b]
      const brep = geo.userData.brep as Uint8Array | undefined
      if (brep) {
        if (!brepIds.has(brep)) brepIds.set(brep, brepIds.size)
        body.brep = brep
        body.brepId = brepIds.get(brep)
      } else if (geo.userData.prim) body.prim = geo.userData.prim
      else if (shape.isMesh) {
        const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined
        const tris = (geo.index ? geo.index.count : (pos?.count ?? 0)) / 3
        if (pos && tris <= MAX_FACETED && !(pos as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute)
          body.mesh = {
            position: pos.array instanceof Float32Array ? pos.array : new Float32Array(pos.array),
            index: geo.index ? Uint32Array.from(geo.index.array) : undefined
          }
      }
      return body
    }
    if ((o as THREE.Points).isPoints) return null
    const children = o.children.map((c) => node(c, base.name)).filter((c): c is CadWriteNode => !!c)
    if (!children.length) return null
    return { ...base, kind: o.userData.cadKind === 'part' ? 'part' : 'assembly', children }
  }
  const children = root.children.map((c) => node(c, root.name)).filter((c): c is CadWriteNode => !!c)
  // One item without a placement is the model itself; otherwise wrap in an assembly.
  if (children.length === 1 && !children[0].matrix) return children[0]
  return { name: root.name || (children.length === 1 ? children[0].name : 'Assembly'), kind: 'assembly', children }
}

/**
 * Copy of the scene with display-only helpers (edge overlays, hidden items)
 * removed. `yUp` rotates from our Z-up into the Y-up convention of OBJ/glTF;
 * `scale` converts mm to the file's unit (glTF is metres).
 */
function cleanForExport(root: THREE.Object3D, yUp = false, scale = 1): THREE.Object3D {
  const copy = root.clone(true)
  const drop: THREE.Object3D[] = []
  copy.traverse((o) => {
    if (o.name === '__edges' || !o.visible) drop.push(o)
  })
  drop.forEach((o) => o.parent?.remove(o))
  if (!yUp) {
    copy.updateMatrixWorld(true)
    return copy
  }
  const wrap = new THREE.Group()
  wrap.rotation.x = -Math.PI / 2
  wrap.scale.setScalar(scale)
  wrap.add(copy)
  wrap.updateMatrixWorld(true)
  return wrap
}

/** Minimal OFF (Object File Format) reader; polygons are fan-triangulated, colours ignored. */
function parseOff(src: string): THREE.BufferGeometry {
  const lines = src
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
  let li = 0
  let head = lines[li++].split(/\s+/)
  if (/OFF$/.test(head[0])) head = head.length > 1 ? head.slice(1) : lines[li++].split(/\s+/)
  const nv = +head[0]
  const nf = +head[1]
  const pos = new Float32Array(nv * 3)
  for (let v = 0; v < nv; v++) {
    const p = lines[li++].split(/\s+/)
    pos.set([+p[0], +p[1], +p[2]], v * 3)
  }
  const idx: number[] = []
  for (let f = 0; f < nf; f++) {
    const p = lines[li++].split(/\s+/).map(Number)
    const n = p[0]
    for (let k = 2; k < n; k++) idx.push(p[1], p[k], p[k + 1])
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setIndex(idx)
  return geo
}
