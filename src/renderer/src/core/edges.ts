import * as THREE from 'three'

/**
 * Feature edges for display.
 *
 * For B-rep solids (STEP/IGES) we know which triangles belong to which CAD
 * face, so the edges are exactly the face boundaries — the same lines a CAD
 * system draws, with no triangle clutter on curved faces. For plain meshes we
 * fall back to a crease-angle test.
 */
export function featureEdges(mesh: THREE.Mesh): THREE.BufferGeometry {
  // Exact edges sampled from the CAD curves by the kernel (shared between instances).
  const exact = mesh.geometry.userData.edgePositions as Float32Array | undefined
  if (exact) {
    let g = mesh.geometry.userData.edgeGeometry as THREE.BufferGeometry | undefined
    if (!g) {
      g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(exact, 3))
      mesh.geometry.userData.edgeGeometry = g
    }
    return g
  }
  const faces = mesh.userData.brepFaces as [number, number][] | undefined
  if (faces?.length) return brepEdges(mesh.geometry, faces)
  return new THREE.EdgesGeometry(mesh.geometry, 25)
}

function brepEdges(geo: THREE.BufferGeometry, faces: [number, number][]): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute
  const index = geo.index
  const triCount = index ? index.count / 3 : pos.count / 3
  const vert = (t: number, k: number): number => (index ? index.getX(t * 3 + k) : t * 3 + k)

  // Which CAD face each triangle came from.
  const triFace = new Int32Array(triCount).fill(-1)
  faces.forEach(([first, last], f) => {
    for (let t = first; t <= last && t < triCount; t++) triFace[t] = f
  })

  // Weld vertices by position: faces are tessellated separately, so the same
  // point on a shared edge appears once per face.
  const weld = new Map<string, number>()
  const welded = new Int32Array(pos.count)
  const points: number[] = []
  const q = (v: number): number => Math.round(v * 1e4)
  for (let i = 0; i < pos.count; i++) {
    const key = `${q(pos.getX(i))},${q(pos.getY(i))},${q(pos.getZ(i))}`
    let id = weld.get(key)
    if (id === undefined) {
      id = points.length / 3
      weld.set(key, id)
      points.push(pos.getX(i), pos.getY(i), pos.getZ(i))
    }
    welded[i] = id
  }

  // An edge is drawn if it borders two different CAD faces, or only one triangle.
  const seen = new Map<number, number>() // edgeKey -> face id, or -2 once it's a feature edge
  const count = new Map<number, number>()
  const nPts = points.length / 3
  for (let t = 0; t < triCount; t++) {
    const f = triFace[t]
    for (let k = 0; k < 3; k++) {
      let a = welded[vert(t, k)]
      let b = welded[vert(t, (k + 1) % 3)]
      if (a === b) continue
      if (a > b) [a, b] = [b, a]
      const key = a * nPts + b
      const prev = seen.get(key)
      if (prev === undefined) seen.set(key, f)
      else if (prev !== f) seen.set(key, -2)
      count.set(key, (count.get(key) ?? 0) + 1)
    }
  }

  const out: number[] = []
  for (const [key, f] of seen) {
    if (f !== -2 && count.get(key)! > 1) continue
    const a = Math.floor(key / nPts)
    const b = key % nPts
    out.push(points[a * 3], points[a * 3 + 1], points[a * 3 + 2], points[b * 3], points[b * 3 + 1], points[b * 3 + 2])
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3))
  return g
}
