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
 *   Node = { name, kind: 'assembly'|'part'|'body', color?, layers?, props?, wire?, matrix?: number[16] (column-major),
 *            mesh?: index, children: Node[] }
 *   props = STEP product data: { 'Part number', 'Nomenclature', 'Description', 'Revision', 'Source', ... }
 *   wire  = true for curve-only bodies (wireframe geometry); their mesh has edges but no triangles
 *   Mesh = { position: Float32Array, index: Uint32Array, faces: [first, last, colorOrNull][], edges: Float32Array }
 */

const QUALITY = {
  draft: { ratio: 0.003, angle: 0.8 },
  normal: { ratio: 0.001, angle: 0.35 },
  fine: { ratio: 0.0003, angle: 0.15 }
}

export function readCad(oc, bytes, format, quality = 'normal', onStage = () => {}) {
  const q = QUALITY[quality] || QUALITY.normal
  const path = '/import.' + format
  oc.FS.writeFile(path, bytes)
  try {
    if (format === 'brep') return readBrep(oc, path, q)
    const info = format === 'step' ? readStepInfo(bytes) : null
    const res = readXcaf(oc, path, format, q, onStage, info)
    if (info) res.file = info.header
    return res
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

/** Mesh one body (solid / shell / face set / wires). Face colours come from `faceColor(face)`. */
function meshBody(oc, shape, q, defl, faceColor) {
  const T = oc.TopAbs_ShapeEnum
  const faceMap = countSubShapes(oc, shape, T.TopAbs_FACE)
  // Count first so the arrays are allocated once.
  const tris = []
  let nNodes = 0, nTris = 0
  for (let i = 1; i <= faceMap.Extent(); i++) {
    const face = oc.TopoDS.Face_1(faceMap.FindKey(i))
    const loc = new oc.TopLoc_Location_1()
    const h = oc.BRep_Tool.Triangulation(face, loc, 0)
    if (h.IsNull()) { loc.delete(); h.delete(); continue }
    const t = h.get()
    tris.push({ face, loc, h, t, nn: t.NbNodes(), nt: t.NbTriangles() })
    nNodes += t.NbNodes(); nTris += t.NbTriangles()
  }
  const position = new Float32Array(nNodes * 3)
  const index = new Uint32Array(nTris * 3)
  const faces = []
  let pv = 0, pi = 0, tri = 0
  for (const { face, loc, h, t, nn, nt } of tris) {
    const base = pv / 3
    const ident = loc.IsIdentity()
    const trsf = ident ? null : loc.Transformation()
    for (let n = 1; n <= nn; n++) {
      const p = t.Node(n)
      if (trsf) p.Transform(trsf)
      position[pv++] = p.X(); position[pv++] = p.Y(); position[pv++] = p.Z()
      p.delete()
    }
    const reversed = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED
    for (let k = 1; k <= nt; k++) {
      const tr = t.Triangle(k)
      const a = base + tr.Value(1) - 1, b = base + tr.Value(2) - 1, c = base + tr.Value(3) - 1
      tr.delete()
      index[pi++] = a
      if (reversed) { index[pi++] = c; index[pi++] = b } else { index[pi++] = b; index[pi++] = c }
    }
    faces.push([tri, tri + nt - 1, faceColor(face)])
    tri += nt
    if (trsf) trsf.delete()
    loc.delete(); h.delete()
  }

  // Model edges as line segments, sampled from the true curves.
  const edges = []
  const edgeMap = countSubShapes(oc, shape, T.TopAbs_EDGE)
  for (let i = 1; i <= edgeMap.Extent(); i++) {
    const edge = oc.TopoDS.Edge_1(edgeMap.FindKey(i))
    if (oc.BRep_Tool.Degenerated(edge)) continue
    let curve = null, pts = null
    try {
      curve = new oc.BRepAdaptor_Curve_2(edge)
      pts = new oc.GCPnts_TangentialDeflection_2(curve, q.angle, defl, 2, 1e-9, 1e-7)
      const np = pts.NbPoints()
      let px = 0, py = 0, pz = 0
      for (let k = 1; k <= np; k++) {
        const p = pts.Value(k)
        const x = p.X(), y = p.Y(), z = p.Z()
        p.delete()
        if (k > 1) edges.push(px, py, pz, x, y, z)
        px = x; py = y; pz = z
      }
    } catch (e) { /* edge without 3D curve: skip */ }
    pts?.delete(); curve?.delete()
  }
  faceMap.delete(); edgeMap.delete()

  return { position, index, faces, edges: new Float32Array(edges) }
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
      out.solid = type === T.TopAbs_SOLID
      return out
    }
  }
  // Faces without a shell, or wireframe curves only: one body.
  if (countSubShapes(oc, shape, T.TopAbs_FACE).Extent() > 0) return [shape]
  return countSubShapes(oc, shape, T.TopAbs_EDGE).Extent() > 0 ? [shape] : []
}

// ---- XCAF (STEP / IGES) -------------------------------------------------------

function readXcaf(oc, path, format, q, onStage, info) {
  const doc = new oc.TDocStd_Document(new oc.TCollection_ExtendedString_1())
  const hdoc = new oc.Handle_TDocStd_Document_2(doc)
  const progress = new oc.Message_ProgressRange_1()
  let ok
  if (format === 'step') {
    const r = new oc.STEPCAFControl_Reader_1()
    r.SetColorMode(true); r.SetNameMode(true); r.SetLayerMode(true)
    // Keep names given to individual solids/faces inside a part (multi-body parts).
    try { oc.Interface_Static.SetIVal('read.stepcaf.subshapes.name', 1) } catch (e) { /* older kernel */ }
    onStage('Reading file')
    if (r.ReadFile(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error('Not a readable STEP file')
    onStage('Converting geometry')
    ok = r.Transfer_1(hdoc, progress)
  } else {
    const r = new oc.IGESCAFControl_Reader_1()
    r.SetColorMode(true); r.SetNameMode(true); r.SetLayerMode(true)
    onStage('Reading file')
    if (r.ReadFile(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error('Not a readable IGES file')
    onStage('Converting geometry')
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
  const layerNames = (seq) => {
    const out = []
    for (let i = 1; i <= seq.Length(); i++) {
      const s = new oc.TCollection_ExtendedString_1()
      layerTool.GetLayer(seq.Value(i), s)
      const n = asciiOf(oc, s).trim()
      if (n && !out.includes(n)) out.push(n)
    }
    return out
  }
  const layersOf = (label) => {
    try {
      const seq = new oc.TDF_LabelSequence_1()
      return layerTool.GetLayers_2(label, seq) ? layerNames(seq) : []
    } catch (e) { return [] }
  }
  const shapeLayers = (shape) => {
    try {
      const seq = new oc.TDF_LabelSequence_1()
      return layerTool.GetLayers_5(shape, seq) ? layerNames(seq) : []
    } catch (e) { return [] }
  }
  const propsOf = (...names) => {
    if (!info) return undefined
    for (const n of names) if (n && info.products.has(n)) return info.products.get(n)
    return undefined
  }
  let partsDone = 0
  const totalParts = Math.max(1, (() => { const s = new oc.TDF_LabelSequence_1(); shapeTool.GetShapes(s); return s.Length() })())

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
    onStage(`Meshing parts`, ++partsDone, totalParts)
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
      const bodyLayers = (hasSub && layersOf(sub)) || []
      const data = meshBody(oc, body, q, defl, (face) => shapeColor(face))
      if (data.index.length === 0 && data.edges.length === 0) return
      const wire = data.index.length === 0
      if (!bodyLayers.length && (bodies.length > 1 || wire)) bodyLayers.push(...shapeLayers(body))
      meshes.push(data)
      const b = { name: bodyName, kind: 'body', color: bodyColor, mesh: meshes.length - 1, children: [] }
      if (wire) b.wire = true
      else b.solid = !!bodies.solid
      if (bodyLayers.length) b.layers = bodyLayers
      children.push(b)
    })
    const layers = layersOf(label)
    const props = propsOf(nameOf(oc, label), name)
    // One body: the part *is* the body.
    const node =
      children.length === 1
        ? { ...children[0], name: children[0].name || name, color: children[0].color || partColor, layers: layers.length ? layers : children[0].layers || [], props }
        : { name, kind: 'part', color: partColor, layers, props, children }
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
      const props = propsOf(nameOf(oc, label), name)
      if (kids.length === 1) return { ...kids[0], name, color: kids[0].color || color, layers: layers.length ? layers : kids[0].layers, props: props || kids[0].props }
      return { name, kind: 'part', color, layers, props, children: kids }
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
    return { name, kind: 'assembly', color: labelColor(label), layers: layersOf(label), props: propsOf(nameOf(oc, label), name), children }
  }

  const roots = []
  for (let i = 1; i <= free.Length(); i++) {
    const n = build(free.Value(i), '')
    if (n && (n.kind === 'body' || n.children.length)) roots.push(n)
  }
  const root = roots.length === 1 ? roots[0] : { name: '', kind: 'assembly', children: roots }
  return { root, meshes }
}

// ---- STEP product data ----------------------------------------------------------
// XCAF keeps names but drops the rest of the product data (part number,
// description, revision...). It is plain text in the file, so read it directly.

const PROD_TYPES = /^(PRODUCT|PRODUCT_DEFINITION_FORMATION(?:_WITH_SPECIFIED_SOURCE)?|PRODUCT_DEFINITION|PRODUCT_RELATED_PRODUCT_CATEGORY)$/

/** Split a STEP argument list into top-level values (strings unquoted, lists as arrays). */
function stepArgs(src) {
  let i = 0
  const value = () => {
    while (src[i] === ' ' || src[i] === '\n' || src[i] === '\r') i++
    if (src[i] === "'") {
      let out = ''
      i++
      for (;;) {
        const j = src.indexOf("'", i)
        if (j < 0) { out += src.slice(i); i = src.length; break }
        out += src.slice(i, j)
        i = j + 1
        if (src[i] === "'") { out += "'"; i++ } else break
      }
      return decodeStepString(out)
    }
    if (src[i] === '(') {
      i++
      const list = []
      while (i < src.length && src[i] !== ')') {
        list.push(value())
        while (src[i] === ' ' || src[i] === '\n' || src[i] === '\r') i++
        if (src[i] === ',') i++
      }
      i++
      return list
    }
    let j = i
    let depth = 0
    while (j < src.length && (depth > 0 || (src[j] !== ',' && src[j] !== ')'))) {
      if (src[j] === '(') depth++
      else if (src[j] === ')') depth--
      j++
    }
    const tok = src.slice(i, j).trim()
    i = j
    return tok
  }
  const out = []
  while (i < src.length) {
    out.push(value())
    while (src[i] === ' ' || src[i] === '\n' || src[i] === '\r') i++
    if (src[i] === ',') i++
    else break
  }
  return out
}

/** STEP string escapes: \X2\....\X0\ (UTF-16 hex), \X\hh (latin-1), \S\c. */
function decodeStepString(s) {
  if (!s.includes('\\')) return s
  return s
    .replace(/\\X2\\([0-9A-F]+)\\X0\\/gi, (_, hex) => {
      let out = ''
      for (let k = 0; k + 4 <= hex.length; k += 4) out += String.fromCharCode(parseInt(hex.slice(k, k + 4), 16))
      return out
    })
    .replace(/\\X\\([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\S\\(.)/g, (_, c) => String.fromCharCode(c.charCodeAt(0) + 128))
}

const blank = (v) => (typeof v === 'string' && v.trim() && v.trim() !== '$' && !/^none$/i.test(v.trim()) ? v.trim() : '')

function readStepInfo(bytes) {
  try {
    const text = new TextDecoder('latin1').decode(bytes)
    const header = {}
    const hdr = (type) => {
      const m = text.match(new RegExp(type + '\\s*\\(([\\s\\S]*?)\\);\\s*(?:\\n|\\r|FILE_|ENDSEC)'))
      return m ? stepArgs(m[1]) : null
    }
    const fn = hdr('FILE_NAME')
    if (fn) {
      if (blank(fn[1])) header['Saved'] = blank(fn[1]).replace('T', ' ').trim()
      const author = (fn[2] || []).map(blank).filter(Boolean).join(', ')
      const org = (fn[3] || []).map(blank).filter(Boolean).join(', ')
      if (author) header['Author'] = author
      if (org) header['Organisation'] = org
      if (blank(fn[4])) header['Exported by'] = blank(fn[4])
      if (blank(fn[5])) header['Originating system'] = blank(fn[5])
    }
    const fs = hdr('FILE_SCHEMA')
    if (fs) {
      const schema = String((fs[0] || [])[0] || '')
      header['STEP schema'] = /AP242|managed_model_based_3d/i.test(schema) ? 'AP242'
        : /AP214|AUTOMOTIVE_DESIGN/i.test(schema) ? 'AP214'
        : /AP203|CONFIG_CONTROL_DESIGN/i.test(schema) ? 'AP203'
        : schema.split(/\s/)[0]
    }

    // #n=TYPE(args); for the product entities only.
    const ents = new Map()
    const re = /#(\d+)\s*=\s*([A-Z_]+)\s*\(/g
    let m
    while ((m = re.exec(text))) {
      if (!PROD_TYPES.test(m[2])) continue
      // Find the closing ");" of this entity, skipping strings.
      let i = re.lastIndex, depth = 1
      while (i < text.length && depth > 0) {
        const c = text[i]
        if (c === "'") { i = text.indexOf("'", i + 1); while (text[i + 1] === "'") i = text.indexOf("'", i + 2) }
        else if (c === '(') depth++
        else if (c === ')') depth--
        i++
      }
      ents.set('#' + m[1], { id: '#' + m[1], type: m[2], args: stepArgs(text.slice(re.lastIndex, i - 1)) })
      re.lastIndex = i
    }

    const byProduct = new Map()
    for (const [id, e] of ents) if (e.type === 'PRODUCT') byProduct.set(id, { e, formations: [], categories: [] })
    for (const e of ents.values()) {
      if (e.type.startsWith('PRODUCT_DEFINITION_FORMATION')) byProduct.get(e.args[2])?.formations.push(e)
      if (e.type === 'PRODUCT_RELATED_PRODUCT_CATEGORY') for (const p of e.args[2] || []) byProduct.get(p)?.categories.push(blank(e.args[0]))
    }
    const defs = new Map()
    for (const e of ents.values()) if (e.type === 'PRODUCT_DEFINITION') defs.set(e.args[2], e)

    const products = new Map()
    for (const { e, formations, categories } of byProduct.values()) {
      const [pid, pname, pdesc] = e.args
      const props = {}
      if (blank(pid)) props['Part number'] = blank(pid)
      if (blank(pname)) props['Nomenclature'] = blank(pname)
      if (blank(pdesc)) props['Description'] = blank(pdesc)
      const f = formations[0]
      if (f) {
        if (blank(f.args[0])) props['Revision'] = blank(f.args[0])
        if (blank(f.args[1])) props['Revision note'] = blank(f.args[1])
        if (f.args[3]) props['Source'] = { '.MADE.': 'Made', '.BOUGHT.': 'Bought', '.NOT_KNOWN.': 'Not known' }[f.args[3]] || f.args[3].replace(/\./g, '')
        const d = defs.get(f.id)
        if (d && blank(d.args[1])) props['Definition'] = blank(d.args[1])
      }
      const cats = [...new Set(categories.filter(Boolean))].filter((c) => !/^(part|detail)$/i.test(c))
      if (categories.some((c) => /^assembly$/i.test(c))) props['Category'] = 'Assembly'
      else if (cats.length) props['Category'] = cats.join(', ')
      for (const key of [pname, pid].map(blank)) if (key && !products.has(key)) products.set(key, props)
    }
    return { header, products }
  } catch (e) {
    return null
  }
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
  const bodies = bodiesOf(oc, shape)
  for (const body of bodies) {
    const data = meshBody(oc, body, q, defl, () => null)
    if (!data.index.length && !data.edges.length) continue
    meshes.push(data)
    const wire = !data.index.length
    children.push({ name: '', kind: 'body', mesh: meshes.length - 1, wire, solid: !wire && !!bodies.solid, children: [] })
  }
  return { root: { name: '', kind: 'part', children }, meshes }
}
