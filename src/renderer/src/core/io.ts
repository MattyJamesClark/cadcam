import * as THREE from 'three'
import { settings } from './settings'

/**
 * File format registry. Each format is a small adapter; adding STEP, IGES,
 * DXF, etc. later means registering another importer/exporter here.
 */
export interface Importer {
  name: string
  extensions: string[]
  /** "y" for formats that are Y-up by convention; they get rotated to our Z-up. */
  upAxis?: 'y' | 'z'
  /** Multiply to get millimetres, for formats with a defined unit (glTF/Collada are metres). */
  unitScale?: number
  /** True for B-rep CAD formats read through the CAD kernel. */
  solid?: boolean
  load(data: ArrayBuffer, fileName: string): Promise<THREE.Object3D>
}

export interface Exporter {
  name: string
  extension: string
  write(root: THREE.Object3D): Promise<Uint8Array>
}

const importers: Importer[] = []
const exporters: Exporter[] = []

export function registerImporter(i: Importer): void {
  importers.push(i)
}
export function registerExporter(e: Exporter): void {
  exporters.push(e)
}
export function listImporters(): readonly Importer[] {
  return importers
}
export function listExporters(): readonly Exporter[] {
  return exporters
}

export function extOf(fileName: string): string {
  const i = fileName.lastIndexOf('.')
  return i < 0 ? '' : fileName.slice(i + 1).toLowerCase()
}

/** Load a file with the right importer and convert it to Z-up. */
export async function loadFile(imp: Importer, data: ArrayBuffer, fileName: string): Promise<THREE.Object3D> {
  const obj = await imp.load(data, fileName)
  if (imp.upAxis !== 'y' && !imp.unitScale) return obj
  const wrap = new THREE.Group()
  wrap.name = obj.name
  if (imp.upAxis === 'y') wrap.rotation.x = Math.PI / 2
  if (imp.unitScale) wrap.scale.setScalar(imp.unitScale)
  wrap.add(obj)
  wrap.updateMatrixWorld(true)
  return wrap
}

/**
 * Formats we can't read because they need a licensed, closed-source kernel.
 * Key: extension, value: [format name, app to export STEP from].
 */
const PROPRIETARY: Record<string, [string, string]> = {
  x_t: ['Parasolid', 'the source CAD system'],
  x_b: ['Parasolid', 'the source CAD system'],
  xmt_txt: ['Parasolid', 'the source CAD system'],
  xmt_bin: ['Parasolid', 'the source CAD system'],
  sldprt: ['SolidWorks part', 'SolidWorks'],
  sldasm: ['SolidWorks assembly', 'SolidWorks'],
  catpart: ['CATIA part', 'CATIA'],
  catproduct: ['CATIA product', 'CATIA'],
  prt: ['NX / Creo part', 'NX or Creo'],
  asm: ['NX / Creo / Solid Edge assembly', 'the source CAD system'],
  ipt: ['Inventor part', 'Inventor'],
  iam: ['Inventor assembly', 'Inventor'],
  par: ['Solid Edge part', 'Solid Edge'],
  psm: ['Solid Edge sheet metal', 'Solid Edge'],
  sat: ['ACIS', 'the source CAD system'],
  sab: ['ACIS', 'the source CAD system'],
  jt: ['JT', 'the source CAD system'],
  '3dxml': ['3DXML', 'CATIA / 3DEXPERIENCE'],
  f3d: ['Fusion 360', 'Fusion 360'],
  skp: ['SketchUp', 'SketchUp']
}

/** A human explanation for files we can't open, or null if we simply don't know the format. */
export function unsupportedReason(fileName: string): string {
  const ext = extOf(fileName)
  const p = PROPRIETARY[ext]
  if (p)
    return `${fileName}: ${p[0]} (.${ext}) is a closed format that needs a licensed kernel. Export it as STEP from ${p[1]} and open the .step file.`
  return `${fileName}: .${ext} files aren't supported yet`
}

export function importerFor(fileName: string): Importer | undefined {
  const ext = extOf(fileName)
  return importers.find((i) => i.extensions.includes(ext))
}

/** Standard part material. Without an explicit colour it follows the "Part colour" setting. */
export function partMaterial(color?: THREE.ColorRepresentation): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: color ?? settings.get().partColor,
    metalness: 0.15,
    roughness: 0.55,
    side: THREE.DoubleSide
  })
  if (color === undefined) m.userData.defaultColor = true
  return m
}

/**
 * Make an imported object behave like the rest of the document: every mesh
 * gets its own material (so selection highlight is per part) and normals.
 */
export function normaliseImported(root: THREE.Object3D, forceMaterial: boolean): THREE.Object3D {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    if (!mesh.geometry.attributes.normal) mesh.geometry.computeVertexNormals()
    if (forceMaterial) {
      mesh.material = partMaterial()
    } else {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const cloned = mats.map((m) => {
        const c = m.clone()
        c.side = THREE.DoubleSide
        return c
      })
      mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0]
    }
  })
  return root
}
