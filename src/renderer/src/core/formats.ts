import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js'
import { PLYExporter } from 'three/examples/jsm/exporters/PLYExporter.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { normaliseImported, partMaterial, registerExporter, registerImporter } from './io'

/** Mesh formats that three.js handles natively. B-rep formats (STEP/IGES) come with a later module. */
export function registerBuiltinFormats(): void {
  registerImporter({
    name: 'STL',
    extensions: ['stl'],
    async load(data) {
      const geo = new STLLoader().parse(data)
      geo.computeVertexNormals()
      return new THREE.Mesh(geo, partMaterial())
    }
  })

  registerImporter({
    name: 'Wavefront OBJ',
    extensions: ['obj'],
    async load(data) {
      return normaliseImported(new OBJLoader().parse(new TextDecoder().decode(data)), true)
    }
  })

  registerImporter({
    name: 'PLY',
    extensions: ['ply'],
    async load(data) {
      const geo = new PLYLoader().parse(data)
      if (!geo.attributes.normal) geo.computeVertexNormals()
      const mat = partMaterial()
      if (geo.attributes.color) {
        mat.vertexColors = true
        mat.color.set(0xffffff)
      }
      return new THREE.Mesh(geo, mat)
    }
  })

  registerImporter({
    name: 'glTF / GLB',
    extensions: ['glb', 'gltf'],
    async load(data) {
      const gltf = await new GLTFLoader().parseAsync(data, '')
      return normaliseImported(gltf.scene, false)
    }
  })

  registerImporter({
    name: '3MF',
    extensions: ['3mf'],
    async load(data) {
      const group = new ThreeMFLoader().parse(data)
      return normaliseImported(group, false)
    }
  })

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
    async write(root) {
      return new TextEncoder().encode(new OBJExporter().parse(cleanForExport(root)))
    }
  })

  registerExporter({
    name: 'PLY (binary)',
    extension: 'ply',
    write(root) {
      return new Promise((resolve) => {
        new PLYExporter().parse(
          cleanForExport(root),
          (res) => resolve(new Uint8Array(res as ArrayBuffer)),
          { binary: true }
        )
      })
    }
  })

  registerExporter({
    name: 'GLB',
    extension: 'glb',
    async write(root) {
      const res = await new GLTFExporter().parseAsync(cleanForExport(root), { binary: true })
      return new Uint8Array(res as ArrayBuffer)
    }
  })
}

/** Copy of the scene with display-only helpers (edge overlays, hidden items) removed. */
function cleanForExport(root: THREE.Object3D): THREE.Object3D {
  const copy = root.clone(true)
  const drop: THREE.Object3D[] = []
  copy.traverse((o) => {
    if (o.name === '__edges' || !o.visible) drop.push(o)
  })
  drop.forEach((o) => o.parent?.remove(o))
  copy.updateMatrixWorld(true)
  return copy
}
