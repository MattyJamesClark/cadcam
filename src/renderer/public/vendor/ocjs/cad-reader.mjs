/**
 * Full-structure CAD reader on OpenCascade (opencascade.js, XCAF).
 *
 * Reads STEP / IGES / BREP into a plain-data tree that keeps what the source
 * CAD system wrote:
 *  - nested assemblies and sub-assemblies, with instance placements
 *  - part / instance names (product names in STEP)
 *  - colours on assemblies, instances, parts, solids and individual faces
 *  - layers (IGES levels / STEP presentation layers)
 *  - multiple solid bodies inside one part
 * A part used many times is meshed once and shared by its instances.
 *
 * Output (all lengths in mm):
 *   { root: Node, meshes: Mesh[] }
 *   Node = { name, kind: 'assembly'|'part'|'body', color?, layers?, matrix?: number[16] (column-major),
 *            mesh?: index, children: Node[] }
 *   Mesh = { position: Float32Array, index: Uint32Array, faces: [first, last, colorOrNull][], edges: Float32Array }
 */

const QUALITY = {
  draft: { ratio: 0.003, angle: 0.8 },
  normal: { ratio: 0.001, angle: 0.35 },
  fine: { ratio: 0.0003, angle: 0.15 }
}

export function readCad(oc, bytes, format, quality = 'normal') {
  const q = QUALITY[quality] || QUALITY.normal
  const path = '/import.' + format
  oc.FS.writeFile(path, bytes)
  try {
    if (format === 'brep') return readBrep(oc, path, q)
    return readXcaf(oc, path, format, q)
  } finally {
    try { oc.FS.unlink(path) } catch (e) { /* ignore */ }
  }
}

// ---- helpers ----------------------------------------------------------------

function asciiOf(oc, ext) {
  try { return new oc.TCollection_AsciiString_13(ext, 63).ToCString() } catch (e) { return '' }
}

function entryOf(oc, label) {
  const s = new oc.TCollection_AsciiString_1()
  oc.TDF_Tool.Entry(label, s)
  return s.ToCString()
}

function nameOf(oc, label) {
  const h = new oc.Handle_TDF_Attribute_1()
  if (!label.FindAttribute_1(oc.TDataStd_Name.GetID(), h)) return ''
  const n = asciiOf(oc, h.get().Get()).trim()
  // OCCT's placeholder names for unnamed instances look like "=>[0:1:1:3]".
  return n.startsWith('=>') ? '' : n
}

function colorFromQ(c) {
  return [c.Red(), c.Green(), c.Blue()]
}

function trsfToMatrix(trsf) {
  // gp_Trsf is a 3x4 [R|t]; return a column-major 4x4 for three.js.
  const v = (r, c) => trsf.Value(r, c)
  return [
    v(1, 1), v(2, 1), v(3, 1), 0,
    v(1, 2), v(2, 2), v(3, 2), 0,
    v(1, 3), v(2, 3), v(3, 3), 0,
    v(1, 4), v(2, 4), v(3, 4), 1
  ]
}

function isIdentity(m) {
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  return m.every((x, i) => Math.abs(x - id[i]) < 1e-12)
}

function shapeDiagonal(oc, shape) {
  const box = new oc.Bnd_Box_1()
  oc.BRepBndLib.Add(shape, box, false)
  if (box.IsVoid()) return 100
  const a = box.CornerMin(), b = box.CornerMax()
  return Math.hypot(b.X() - a.X(), b.Y() - a.Y(), b.Z() - a.Z()) || 100
}

function countSubShapes(oc, shape, type) {
  const map = new oc.TopTools_IndexedMapOfShape_1()
  oc.TopExp.MapShapes_1(shape, type, map)
  return map
}

// ---- meshing ------------------------------------------------------------------

/** Mesh one body (solid / shell / face set). Face colours come from `faceColor(face)`. */
function meshBody(oc, shape, q, defl, faceColor) {
  const T = oc.TopAbs_ShapeEnum
  const positions = []
  const indices = []
  const faces = []
  let tri = 0
  const faceMap = countSubShapes(oc, shape, T.TopAbs_FACE)
  for (let i = 1; i <= faceMap.Extent(); i++) {
    const face = oc.TopoDS.Face_1(faceMap.FindKey(i))
    const loc = new oc.TopLoc_Location_1()
    const h = oc.BRep_Tool.Triangulation(face, loc, 0)
    if (h.IsNull()) continue
    const t = h.get()
    const trsf = loc.Transformation()
    const base = positions.length / 3
    const nn = t.NbNodes()
    for (let n = 1; n <= nn; n++) {
      const p = t.Node(n).Transformed(trsf)
      positions.push(p.X(), p.Y(), p.Z())
    }
    const reversed = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED
    const nt = t.NbTriangles()
    for (let k = 1; k <= nt; k++) {
      const tr = t.Triangle(k)
      const a = tr.Value(1) - 1, b = tr.Value(2) - 1, c = tr.Value(3) - 1
      if (reversed) indices.push(base + a, base + c, base + b)
      else indices.push(base + a, base + b, base + c)
    }
    faces.push([tri, tri + nt - 1, faceColor(face)])
    tri += nt
  }

  // Model edges as line segments, sampled from the true curves.
  const edges = []
  const edgeMap = countSubShapes(oc, shape, T.TopAbs_EDGE)
  for (let i = 1; i <= edgeMap.Extent(); i++) {
    const edge = oc.TopoDS.Edge_1(edgeMap.FindKey(i))
    if (oc.BRep_Tool.Degenerated(edge)) continue
    try {
      const curve = new oc.BRepAdaptor_Curve_2(edge)
      const pts = new oc.GCPnts_TangentialDeflection_2(curve, q.angle, defl, 2, 1e-9, 1e-7)
      let prev = null
      for (let k = 1; k <= pts.NbPoints(); k++) {
        const p = pts.Value(k)
        const cur = [p.X(), p.Y(), p.Z()]
        if (prev) edges.push(...prev, ...cur)
        prev = cur
      }
    } catch (e) { /* edge without 3D curve: skip */ }
  }

  return {
    position: new Float32Array(positions),
    index: new Uint32Array(indices),
    faces,
    edges: new Float32Array(edges)
  }
}

/** Split a shape into its bodies: solids, else shells, else the faces as one body. */
function bodiesOf(oc, shape) {
  const T = oc.TopAbs_ShapeEnum
  for (const type of [T.TopAbs_SOLID, T.TopAbs_SHELL]) {
    const map = countSubShapes(oc, shape, type)
    if (map.Extent() > 0) {
      const out = []
      for (let i = 1; i <= map.Extent(); i++) out.push(map.FindKey(i))
      // Shells that belong to solids were already covered; shells only matter when there are no solids.
      return out
    }
  }
  return countSubShapes(oc, shape, T.TopAbs_FACE).Extent() > 0 ? [shape] : []
}

// ---- XCAF (STEP / IGES) -------------------------------------------------------

function readXcaf(oc, path, format, q) {
  const doc = new oc.TDocStd_Document(new oc.TCollection_ExtendedString_1())
  const hdoc = new oc.Handle_TDocStd_Document_2(doc)
  const progress = new oc.Message_ProgressRange_1()
  let ok
  if (format === 'step') {
    const r = new oc.STEPCAFControl_Reader_1()
    r.SetColorMode(true); r.SetNameMode(true); r.SetLayerMode(true)
    if (r.ReadFile(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error('Not a readable STEP file')
    ok = r.Transfer_1(hdoc, progress)
  } else {
    const r = new oc.IGESCAFControl_Reader_1()
    r.SetColorMode(true); r.SetNameMode(true); r.SetLayerMode(true)
    if (r.ReadFile(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error('Not a readable IGES file')
    ok = r.Transfer(hdoc, progress)
  }
  if (!ok) throw new Error('The CAD kernel could not convert this file')

  const ST = oc.XCAFDoc_ShapeTool
  const shapeTool = oc.XCAFDoc_DocumentTool.ShapeTool(doc.Main()).get()
  const colorTool = oc.XCAFDoc_DocumentTool.ColorTool(doc.Main()).get()
  const layerTool = oc.XCAFDoc_DocumentTool.LayerTool(doc.Main()).get()
  const CT = oc.XCAFDoc_ColorType
  const qc = new oc.Quantity_Color_1()

  const labelColor = (label) => {
    for (const t of [CT.XCAFDoc_ColorSurf, CT.XCAFDoc_ColorGen]) if (colorTool.GetColor_4(label, t, qc)) return colorFromQ(qc)
    return null
  }
  const shapeColor = (shape) => {
    for (const t of [CT.XCAFDoc_ColorSurf, CT.XCAFDoc_ColorGen]) if (colorTool.GetColor_7(shape, t, qc)) return colorFromQ(qc)
    return null
  }
  const layersOf = (label) => {
    try {
      const h = layerTool.GetLayers_3(label)
      if (h.IsNull()) return []
      const seq = h.get()
      const out = []
      for (let i = 1; i <= seq.Length(); i++) out.push(asciiOf(oc, seq.Value(i)))
      return out.filter(Boolean)
    } catch (e) { return [] }
  }

  // Find the overall size once, so mesh accuracy scales with the model.
  const free = new oc.TDF_LabelSequence_1()
  shapeTool.GetFreeShapes(free)
  let diag = 0
  for (let i = 1; i <= free.Length(); i++) diag = Math.max(diag, shapeDiagonal(oc, ST.GetShape_2(free.Value(i))))
  const defl = Math.max(1e-4, diag * q.ratio)

  const meshes = []
  const partCache = new Map() // label entry -> built part node (without placement)

  /** Bodies of a simple-shape label, meshed (once per label). */
  const buildPart = (label, name) => {
    const key = entryOf(oc, label)
    const cached = partCache.get(key)
    if (cached) return structuredClone(cached)
    const shape = ST.GetShape_2(label)
    new oc.BRepMesh_IncrementalMesh_2(shape, defl, false, q.angle, false)
    const partColor = labelColor(label) || shapeColor(shape)
    const children = []
    const bodies = bodiesOf(oc, shape)
    bodies.forEach((body, i) => {
      // A body may have its own sub-shape label with a name / colour.
      const sub = new oc.TDF_Label()
      const hasSub = shapeTool.FindSubShape(label, body, sub)
      const bodyName = (hasSub && nameOf(oc, sub)) || ''
      const bodyColor = (hasSub && labelColor(sub)) || shapeColor(body)
      const data = meshBody(oc, body, q, defl, (face) => shapeColor(face))
      if (data.index.length === 0) return
      meshes.push(data)
      children.push({ name: bodyName, kind: 'body', color: bodyColor, mesh: meshes.length - 1, children: [] })
    })
    const layers = layersOf(label)
    // One body: the part *is* the body.
    const node =
      children.length === 1
        ? { ...children[0], name: children[0].name || name, color: children[0].color || partColor, layers }
        : { name, kind: 'part', color: partColor, layers, children }
    partCache.set(key, node)
    return structuredClone(node)
  }

  /** A "part" in STEP is often an assembly of plain shapes (solid + construction geometry). */
  const isPartLike = (label) => {
    if (!ST.IsAssembly(label)) return false
    const comps = new oc.TDF_LabelSequence_1()
    ST.GetComponents(label, comps, false)
    for (let i = 1; i <= comps.Length(); i++) {
      const ref = new oc.TDF_Label()
      ST.GetReferredShape(comps.Value(i), ref)
      if (ST.IsAssembly(ref)) return false
    }
    return true
  }

  const build = (label, name) => {
    name = name || nameOf(oc, label)
    if (!ST.IsAssembly(label) || isPartLike(label)) {
      if (!ST.IsAssembly(label)) return buildPart(label, name)
      // Merge the plain shapes of a part-like assembly into one part.
      const comps = new oc.TDF_LabelSequence_1()
      ST.GetComponents(label, comps, false)
      const kids = []
      for (let i = 1; i <= comps.Length(); i++) {
        const comp = comps.Value(i)
        const ref = new oc.TDF_Label()
        ST.GetReferredShape(comp, ref)
        const child = buildPart(ref, nameOf(oc, comp) || nameOf(oc, ref))
        if (child.kind === 'part' && child.children.length === 0) continue
        const m = trsfToMatrix(ST.GetLocation(comp).Transformation())
        if (!isIdentity(m)) child.matrix = m
        child.color = child.color || labelColor(comp)
        kids.push(child)
      }
      const color = labelColor(label)
      const layers = layersOf(label)
      if (kids.length === 1) return { ...kids[0], name, color: kids[0].color || color, layers }
      return { name, kind: 'part', color, layers, children: kids }
    }
    const comps = new oc.TDF_LabelSequence_1()
    ST.GetComponents(label, comps, false)
    const children = []
    for (let i = 1; i <= comps.Length(); i++) {
      const comp = comps.Value(i)
      const ref = new oc.TDF_Label()
      ST.GetReferredShape(comp, ref)
      // Instance name (e.g. "BOLT<2>") wins over the product name.
      const child = build(ref, nameOf(oc, comp) || nameOf(oc, ref))
      if (!child || (child.kind !== 'body' && child.children.length === 0)) continue
      const m = trsfToMatrix(ST.GetLocation(comp).Transformation())
      if (!isIdentity(m)) child.matrix = m
      child.color = labelColor(comp) || child.color
      children.push(child)
    }
    return { name, kind: 'assembly', color: labelColor(label), layers: layersOf(label), children }
  }

  const roots = []
  for (let i = 1; i <= free.Length(); i++) {
    const n = build(free.Value(i), '')
    if (n && (n.kind === 'body' || n.children.length)) roots.push(n)
  }
  const root = roots.length === 1 ? roots[0] : { name: '', kind: 'assembly', children: roots }
  return { root, meshes }
}

// ---- BREP ---------------------------------------------------------------------

function readBrep(oc, path, q) {
  const shape = new oc.TopoDS_Shape()
  const builder = new oc.BRep_Builder()
  if (!oc.BRepTools.Read_2(shape, path, builder, new oc.Message_ProgressRange_1())) throw new Error('Not a readable BREP file')
  const defl = Math.max(1e-4, shapeDiagonal(oc, shape) * q.ratio)
  new oc.BRepMesh_IncrementalMesh_2(shape, defl, false, q.angle, false)
  const meshes = []
  const children = []
  for (const body of bodiesOf(oc, shape)) {
    const data = meshBody(oc, body, q, defl, () => null)
    if (!data.index.length) continue
    meshes.push(data)
    children.push({ name: '', kind: 'body', mesh: meshes.length - 1, children: [] })
  }
  return { root: { name: '', kind: 'part', children }, meshes }
}
