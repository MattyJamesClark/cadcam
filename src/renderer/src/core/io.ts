import * as THREE from 'three'

/**
 * File format registry. Each format is a small adapter; adding STEP, IGES,
 * DXF, etc. later means registering another importer/exporter here.
 */
export interface Importer {
  name: string
  extensions: string[]
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

export function importerFor(fileName: string): Importer | undefined {
  const ext = extOf(fileName)
  return importers.find((i) => i.extensions.includes(ext))
}

export const PART_MATERIAL_COLOR = 0x9aa7b4

export function partMaterial(color = PART_MATERIAL_COLOR): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide })
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
