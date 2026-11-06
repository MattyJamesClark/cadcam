// CADCAM Studio CAD kernel: OpenCascade compiled to WebAssembly.
//
// Reads STEP / IGES / BREP and returns the model as plain data in one call:
// the assembly tree (names, colours, layers, placements) and triangle meshes
// plus model edges per body. Doing the mesh extraction here in C++ (instead of
// thousands of small JS<->wasm calls) and building with native wasm exceptions
// is what makes imports fast.
//
// JS:  Module.readCad(path, format, ratio, angle, progress) -> { root, meshes }
//      Module.writeCad(path, format, spec) -> { skipped } | { error }   (see writer below)
//   Node = { name, ref, kind: 'assembly'|'part'|'body', color?, layers?, matrix?,
//            mesh?, wire?, solid?, children }
//   Mesh = { position: Float32Array, index: Uint32Array, faces: [first, last, color|null][], edges: Float32Array,
//            brep: Uint8Array (the exact body, OCCT binary format, kept so it can be written back out) }
//   `ref` is the product name of the referenced shape (to look up STEP product data).

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepBndLib.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <gp_Circ.hxx>
#include <gp_Cone.hxx>
#include <gp_Cylinder.hxx>
#include <gp_Elips.hxx>
#include <gp_Lin.hxx>
#include <gp_Pln.hxx>
#include <gp_Sphere.hxx>
#include <gp_Torus.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <BRepOffsetAPI_MakePipeShell.hxx>
#include <BRepOffsetAPI_DraftAngle.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <GC_MakeArcOfCircle.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <ShapeFix_Face.hxx>
#include <ShapeFix_Shape.hxx>
#include <gp_Ax1.hxx>
#include <BRepOffset_MakeOffset.hxx>
#include <BRepLib.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <TopTools_ListOfShape.hxx>
#include <BinTools.hxx>
#include <IGESCAFControl_Writer.hxx>
#include <IGESControl_Controller.hxx>
#include <STEPCAFControl_Writer.hxx>
#include <STEPControl_StepModelType.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Iterator.hxx>
#include <TopoDS_Shell.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GCPnts_TangentialDeflection.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <IGESCAFControl_Reader.hxx>
#include <Interface_Static.hxx>
#include <Message_ProgressRange.hxx>
#include <Poly_Triangulation.hxx>
#include <Quantity_Color.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <Standard_Failure.hxx>
#include <TColStd_HSequenceOfExtendedString.hxx>
#include <TCollection_AsciiString.hxx>
#include <TCollection_ExtendedString.hxx>
#include <TDF_Label.hxx>
#include <TDF_LabelSequence.hxx>
#include <TDF_Tool.hxx>
#include <TDataStd_Name.hxx>
#include <TDocStd_Document.hxx>
#include <TopAbs.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Vertex.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <XCAFDoc_ColorType.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_LayerTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <gp.hxx>
#include <gp_Ax2.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>

#include <algorithm>
#include <functional>
#include <array>
#include <sstream>
#include <stdexcept>
#include <cmath>
#include <map>
#include <optional>
#include <string>
#include <vector>

using emscripten::val;

namespace {

using RGB = std::array<double, 3>;

std::string utf8(const TCollection_ExtendedString& s) {
  // replaceNonAscii = 0 converts to UTF-8.
  return TCollection_AsciiString(s, 0).ToCString();
}

std::string trim(std::string s) {
  const char* ws = " \t\r\n";
  s.erase(0, s.find_first_not_of(ws));
  s.erase(s.find_last_not_of(ws) + 1);
  return s;
}

val rgbVal(const std::optional<RGB>& c) {
  if (!c) return val::null();
  val a = val::array();
  a.call<void>("push", (*c)[0], (*c)[1], (*c)[2]);
  return a;
}

val stringArray(const std::vector<std::string>& v) {
  val a = val::array();
  for (const auto& s : v) a.call<void>("push", s);
  return a;
}

template <typename T>
val typedCopy(const std::vector<T>& v) {
  // Copy out of wasm memory so the buffer can be transferred to the UI thread.
  return val(emscripten::typed_memory_view(v.size(), v.data())).call<val>("slice");
}

struct Progress {
  val fn;
  void operator()(const std::string& stage, int done = 0, int total = 0) const {
    if (!fn.isUndefined() && !fn.isNull()) fn(stage, done, total);
  }
};

// ---- meshing ---------------------------------------------------------------

struct MeshOut {
  std::vector<float> position;
  std::vector<uint32_t> index;
  std::vector<float> edges;
  struct Face {
    uint32_t first, last;
    std::optional<RGB> color;
    int index;  // 0-based in TopExp::MapShapes(shape, TopAbs_FACE) order
  };
  std::vector<Face> faces;
  std::vector<uint32_t> edgeRanges;  // per edge (MapShapes order): first segment, segment count
  std::vector<float> vertices;       // per vertex (MapShapes order): x, y, z
  std::string brep;
};

template <typename ColorFn>
MeshOut meshBody(const TopoDS_Shape& shape, double angle, double defl, ColorFn faceColor) {
  MeshOut out;
  TopTools_IndexedMapOfShape faceMap;
  TopExp::MapShapes(shape, TopAbs_FACE, faceMap);
  uint32_t tri = 0;
  for (int i = 1; i <= faceMap.Extent(); i++) {
    const TopoDS_Face& face = TopoDS::Face(faceMap.FindKey(i));
    TopLoc_Location loc;
    Handle(Poly_Triangulation) t = BRep_Tool::Triangulation(face, loc);
    if (t.IsNull() || t->NbTriangles() == 0) continue;
    const gp_Trsf trsf = loc.Transformation();
    const bool ident = loc.IsIdentity();
    const uint32_t base = static_cast<uint32_t>(out.position.size() / 3);
    for (int n = 1; n <= t->NbNodes(); n++) {
      gp_Pnt p = t->Node(n);
      if (!ident) p.Transform(trsf);
      out.position.push_back(static_cast<float>(p.X()));
      out.position.push_back(static_cast<float>(p.Y()));
      out.position.push_back(static_cast<float>(p.Z()));
    }
    const bool reversed = face.Orientation() == TopAbs_REVERSED;
    const int nt = t->NbTriangles();
    for (int k = 1; k <= nt; k++) {
      int a, b, c;
      t->Triangle(k).Get(a, b, c);
      out.index.push_back(base + a - 1);
      if (reversed) {
        out.index.push_back(base + c - 1);
        out.index.push_back(base + b - 1);
      } else {
        out.index.push_back(base + b - 1);
        out.index.push_back(base + c - 1);
      }
    }
    out.faces.push_back({tri, tri + nt - 1, faceColor(face), i - 1});
    tri += nt;
  }

  // Model edges as line segments sampled from the true curves.
  TopTools_IndexedMapOfShape edgeMap;
  TopExp::MapShapes(shape, TopAbs_EDGE, edgeMap);
  // Seams (where a sphere or cylinder face closes on itself) are not real
  // edges: they keep their index but get no line.
  TopTools_IndexedDataMapOfShapeListOfShape edgeFaces;
  TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, edgeFaces);
  auto isSeam = [&](const TopoDS_Edge& e) {
    const int at = edgeFaces.FindIndex(e);
    if (!at) return false;
    const TopTools_ListOfShape& faces = edgeFaces.FindFromIndex(at);
    if (faces.IsEmpty()) return false;
    for (TopTools_ListIteratorOfListOfShape it(faces); it.More(); it.Next())
      if (!BRep_Tool::IsClosed(e, TopoDS::Face(it.Value()))) return false;
    return true;
  };
  for (int i = 1; i <= edgeMap.Extent(); i++) {
    const TopoDS_Edge& edge = TopoDS::Edge(edgeMap.FindKey(i));
    out.edgeRanges.push_back(static_cast<uint32_t>(out.edges.size() / 6));
    out.edgeRanges.push_back(0);
    const size_t before = out.edges.size();
    struct Count {
      MeshOut& o;
      size_t before;
      ~Count() { o.edgeRanges.back() = static_cast<uint32_t>((o.edges.size() - before) / 6); }
    } count{out, before};
    if (BRep_Tool::Degenerated(edge) || isSeam(edge)) continue;
    try {
      BRepAdaptor_Curve curve(edge);
      GCPnts_TangentialDeflection pts(curve, angle, defl, 2, 1e-9, 1e-7);
      for (int k = 2; k <= pts.NbPoints(); k++) {
        const gp_Pnt a = pts.Value(k - 1), b = pts.Value(k);
        out.edges.insert(out.edges.end(), {float(a.X()), float(a.Y()), float(a.Z()), float(b.X()), float(b.Y()), float(b.Z())});
      }
    } catch (const Standard_Failure&) {
      // Edge without a 3D curve: skip it.
    }
  }
  TopTools_IndexedMapOfShape vertexMap;
  TopExp::MapShapes(shape, TopAbs_VERTEX, vertexMap);
  for (int i = 1; i <= vertexMap.Extent(); i++) {
    const gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(vertexMap.FindKey(i)));
    out.vertices.insert(out.vertices.end(), {float(p.X()), float(p.Y()), float(p.Z())});
  }

  // The exact shape, without the display triangles (they're rebuilt on read).
  try {
    std::ostringstream os;
    BinTools::Write(shape, os, false, false, BinTools_FormatVersion_CURRENT);
    out.brep = os.str();
  } catch (const Standard_Failure&) {
    // Not fatal: the body just can't be exported exactly.
  }
  return out;
}

val meshVal(const MeshOut& m) {
  val o = val::object();
  o.set("position", typedCopy(m.position));
  o.set("index", typedCopy(m.index));
  o.set("edges", typedCopy(m.edges));
  o.set("edgeRanges", typedCopy(m.edgeRanges));
  o.set("vertices", typedCopy(m.vertices));
  val faces = val::array();
  for (const auto& f : m.faces) {
    val e = val::array();
    e.call<void>("push", f.first, f.last, rgbVal(f.color));
    e.call<void>("push", f.index);
    faces.call<void>("push", e);
  }
  o.set("faces", faces);
  if (!m.brep.empty())
    o.set("brep", val(emscripten::typed_memory_view(m.brep.size(), reinterpret_cast<const uint8_t*>(m.brep.data())))
                      .call<val>("slice"));
  return o;
}

struct Bodies {
  std::vector<TopoDS_Shape> shapes;
  std::vector<bool> solid;
};

/**
 * Split a shape into bodies: each solid, each shell not in a solid, and the
 * loose faces / curves of each compound as one more (a surface model).
 */
Bodies bodiesOf(const TopoDS_Shape& shape, bool dropCurves) {
  Bodies b;
  BRep_Builder bb;
  auto hasVolume = [](const TopoDS_Shape& s) {
    return TopExp_Explorer(s, TopAbs_SHELL).More();
  };
  std::function<void(const TopoDS_Shape&)> walk = [&](const TopoDS_Shape& s) {
    if (!hasVolume(s)) {
      // Surfaces / curves only (e.g. a group of construction curves): one body.
      b.shapes.push_back(s);
      b.solid.push_back(false);
      return;
    }
    if (s.ShapeType() == TopAbs_SOLID || s.ShapeType() == TopAbs_SHELL) {
      b.shapes.push_back(s);
      b.solid.push_back(s.ShapeType() == TopAbs_SOLID);
      return;
    }
    if (s.ShapeType() != TopAbs_COMPOUND && s.ShapeType() != TopAbs_COMPSOLID) {
      b.shapes.push_back(s);
      b.solid.push_back(false);
      return;
    }
    TopoDS_Compound rest;
    bb.MakeCompound(rest);
    bool hasRest = false;
    for (TopoDS_Iterator it(s); it.More(); it.Next()) {
      const TopAbs_ShapeEnum t = it.Value().ShapeType();
      if (t == TopAbs_COMPOUND || t == TopAbs_COMPSOLID || t == TopAbs_SOLID || t == TopAbs_SHELL) walk(it.Value());
      else {
        bb.Add(rest, it.Value());
        hasRest = true;
      }
    }
    if (hasRest) {
      b.shapes.push_back(rest);
      b.solid.push_back(false);
    }
  };
  if (!shape.IsNull()) walk(shape);
  // In a CAD part, curve-only leftovers next to solids are construction geometry (axes, sketches): leave them out.
  bool anySolid = false;
  for (size_t i = 0; i < b.shapes.size(); i++)
    if (b.shapes[i].ShapeType() == TopAbs_SOLID || b.shapes[i].ShapeType() == TopAbs_SHELL) anySolid = true;
  if (anySolid && dropCurves) {
    Bodies kept;
    for (size_t i = 0; i < b.shapes.size(); i++) {
      TopExp_Explorer faces(b.shapes[i], TopAbs_FACE);
      if (!faces.More()) continue;
      kept.shapes.push_back(b.shapes[i]);
      kept.solid.push_back(b.solid[i]);
    }
    return kept;
  }
  return b;
}

double diagonal(const TopoDS_Shape& shape) {
  Bnd_Box box;
  BRepBndLib::Add(shape, box, false);
  if (box.IsVoid()) return 100;
  const double d = box.CornerMin().Distance(box.CornerMax());
  return d > 0 ? d : 100;
}

val matrixVal(const gp_Trsf& t, bool& identity) {
  double m[16] = {t.Value(1, 1), t.Value(2, 1), t.Value(3, 1), 0, t.Value(1, 2), t.Value(2, 2), t.Value(3, 2), 0,
                  t.Value(1, 3), t.Value(2, 3), t.Value(3, 3), 0, t.Value(1, 4), t.Value(2, 4), t.Value(3, 4), 1};
  static const double id[16] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
  identity = true;
  for (int i = 0; i < 16; i++)
    if (std::fabs(m[i] - id[i]) > 1e-12) identity = false;
  val a = val::array();
  for (double x : m) a.call<void>("push", x);
  return a;
}

// ---- XCAF reader -------------------------------------------------------------

class XcafReader {
 public:
  XcafReader(Handle(TDocStd_Document) doc, double ratio, double angle, Progress progress)
      : doc_(doc), angle_(angle), progress_(progress) {
    shapeTool_ = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
    colorTool_ = XCAFDoc_DocumentTool::ColorTool(doc->Main());
    layerTool_ = XCAFDoc_DocumentTool::LayerTool(doc->Main());
    shapeTool_->GetFreeShapes(free_);
    double diag = 0;
    for (int i = 1; i <= free_.Length(); i++) diag = std::max(diag, diagonal(XCAFDoc_ShapeTool::GetShape(free_.Value(i))));
    defl_ = std::max(1e-4, diag * ratio);
    TDF_LabelSequence all;
    shapeTool_->GetShapes(all);
    totalParts_ = std::max(1, all.Length());
    meshes_ = val::array();
  }

  val run() {
    val roots = val::array();
    int count = 0;
    val last = val::null();
    for (int i = 1; i <= free_.Length(); i++) {
      val n = build(free_.Value(i), "");
      if (!n.isNull() && (n["kind"].as<std::string>() == "body" || n["children"]["length"].as<int>() > 0)) {
        roots.call<void>("push", n);
        last = n;
        count++;
      }
    }
    val root = val::object();
    if (count == 1) root = last;
    else {
      root.set("name", "");
      root.set("kind", "assembly");
      root.set("children", roots);
    }
    val res = val::object();
    res.set("root", root);
    res.set("meshes", meshes_);
    return res;
  }

 private:
  struct BodyInfo {
    std::string name;
    std::optional<RGB> color;
    std::vector<std::string> layers;
    int mesh;
    bool wire, solid;
  };
  struct PartInfo {
    std::vector<BodyInfo> bodies;
    std::optional<RGB> color;
    std::vector<std::string> layers;
  };

  std::string nameOf(const TDF_Label& label) const {
    Handle(TDataStd_Name) attr;
    if (!label.FindAttribute(TDataStd_Name::GetID(), attr)) return "";
    std::string n = trim(utf8(attr->Get()));
    // OCCT's placeholder names for unnamed instances look like "=>[0:1:1:3]".
    return n.rfind("=>", 0) == 0 ? "" : n;
  }

  std::optional<RGB> labelColor(const TDF_Label& label) const {
    Quantity_Color c;
    for (auto t : {XCAFDoc_ColorSurf, XCAFDoc_ColorGen})
      if (colorTool_->GetColor(label, t, c)) return RGB{c.Red(), c.Green(), c.Blue()};
    return std::nullopt;
  }

  std::optional<RGB> shapeColor(const TopoDS_Shape& shape) const {
    Quantity_Color c;
    for (auto t : {XCAFDoc_ColorSurf, XCAFDoc_ColorGen})
      if (colorTool_->GetColor(shape, t, c)) return RGB{c.Red(), c.Green(), c.Blue()};
    return std::nullopt;
  }

  std::vector<std::string> layerNames(const TDF_LabelSequence& seq) const {
    std::vector<std::string> out;
    for (int i = 1; i <= seq.Length(); i++) {
      TCollection_ExtendedString s;
      if (!layerTool_->GetLayer(seq.Value(i), s)) continue;
      std::string n = trim(utf8(s));
      if (!n.empty() && std::find(out.begin(), out.end(), n) == out.end()) out.push_back(n);
    }
    return out;
  }
  std::vector<std::string> layersOf(const TDF_Label& label) const {
    TDF_LabelSequence seq;
    return layerTool_->GetLayers(label, seq) ? layerNames(seq) : std::vector<std::string>{};
  }
  std::vector<std::string> shapeLayers(const TopoDS_Shape& shape) const {
    TDF_LabelSequence seq;
    return layerTool_->GetLayers(shape, seq) ? layerNames(seq) : std::vector<std::string>{};
  }

  const PartInfo& part(const TDF_Label& label) {
    TCollection_AsciiString entry;
    TDF_Tool::Entry(label, entry);
    auto it = parts_.find(entry.ToCString());
    if (it != parts_.end()) return it->second;
    PartInfo info;
    const TopoDS_Shape shape = XCAFDoc_ShapeTool::GetShape(label);
    progress_("Meshing parts", ++partsDone_, totalParts_);
    BRepMesh_IncrementalMesh(shape, defl_, false, angle_, false);
    info.color = labelColor(label);
    if (!info.color) info.color = shapeColor(shape);
    info.layers = layersOf(label);
    Bodies bodies = bodiesOf(shape, true);
    for (size_t bi = 0; bi < bodies.shapes.size(); bi++) {
      const TopoDS_Shape& body = bodies.shapes[bi];
      TDF_Label sub;
      const bool hasSub = shapeTool_->FindSubShape(label, body, sub);
      BodyInfo b;
      b.name = hasSub ? nameOf(sub) : "";
      b.color = hasSub ? labelColor(sub) : std::nullopt;
      if (!b.color) b.color = shapeColor(body);
      if (hasSub) b.layers = layersOf(sub);
      MeshOut m = meshBody(body, angle_, defl_, [this](const TopoDS_Face& f) { return shapeColor(f); });
      if (m.index.empty() && m.edges.empty()) continue;
      b.wire = m.index.empty();
      b.solid = !b.wire && bodies.solid[bi];
      if (b.layers.empty() && (bodies.shapes.size() > 1 || b.wire)) b.layers = shapeLayers(body);
      b.mesh = meshes_["length"].as<int>();
      meshes_.call<void>("push", meshVal(m));
      info.bodies.push_back(std::move(b));
    }
    return parts_.emplace(entry.ToCString(), std::move(info)).first->second;
  }

  static val bodyVal(const BodyInfo& b, const std::string& fallbackName) {
    val n = val::object();
    n.set("name", b.name.empty() ? fallbackName : b.name);
    n.set("kind", "body");
    n.set("color", rgbVal(b.color));
    if (!b.layers.empty()) n.set("layers", stringArray(b.layers));
    n.set("mesh", b.mesh);
    if (b.wire) n.set("wire", true);
    else n.set("solid", b.solid);
    n.set("children", val::array());
    return n;
  }

  /** A fresh node for a simple-shape label (meshes are shared between instances). */
  val partNode(const TDF_Label& label, const std::string& name) {
    const PartInfo& p = part(label);
    val n = val::object();
    n.set("ref", nameOf(label));
    if (p.bodies.size() == 1) {
      // One body: the part *is* the body.
      const BodyInfo& b = p.bodies[0];
      n = bodyVal(b, name);
      n.set("ref", nameOf(label));
      if (!b.color && p.color) n.set("color", rgbVal(p.color));
      if (!p.layers.empty()) n.set("layers", stringArray(p.layers));
      return n;
    }
    n.set("name", name);
    n.set("kind", "part");
    n.set("color", rgbVal(p.color));
    if (!p.layers.empty()) n.set("layers", stringArray(p.layers));
    val kids = val::array();
    for (const auto& b : p.bodies) kids.call<void>("push", bodyVal(b, ""));
    n.set("children", kids);
    return n;
  }

  /** A "part" in STEP is often an assembly of plain shapes (solid + construction geometry). */
  bool isPartLike(const TDF_Label& label) const {
    if (!XCAFDoc_ShapeTool::IsAssembly(label)) return false;
    TDF_LabelSequence comps;
    XCAFDoc_ShapeTool::GetComponents(label, comps, false);
    for (int i = 1; i <= comps.Length(); i++) {
      TDF_Label ref;
      XCAFDoc_ShapeTool::GetReferredShape(comps.Value(i), ref);
      if (XCAFDoc_ShapeTool::IsAssembly(ref)) return false;
    }
    return true;
  }

  static bool isEmptyPart(val& n) {
    return n["kind"].as<std::string>() != "body" && n["children"]["length"].as<int>() == 0;
  }

  void place(val& child, const TDF_Label& comp) {
    bool identity;
    val m = matrixVal(XCAFDoc_ShapeTool::GetLocation(comp).Transformation(), identity);
    if (!identity) child.set("matrix", m);
  }

  val build(const TDF_Label& label, std::string name) {
    if (name.empty()) name = nameOf(label);
    const bool assembly = XCAFDoc_ShapeTool::IsAssembly(label);
    if (!assembly) return partNode(label, name);

    TDF_LabelSequence comps;
    XCAFDoc_ShapeTool::GetComponents(label, comps, false);
    val kids = val::array();
    int count = 0;
    val only = val::null();
    const bool partLike = isPartLike(label);
    for (int i = 1; i <= comps.Length(); i++) {
      const TDF_Label comp = comps.Value(i);
      TDF_Label ref;
      XCAFDoc_ShapeTool::GetReferredShape(comp, ref);
      // Instance name (e.g. "BOLT<2>") wins over the product name.
      std::string childName = nameOf(comp);
      if (childName.empty()) childName = nameOf(ref);
      val child = partLike ? partNode(ref, childName) : build(ref, childName);
      if (child.isNull() || isEmptyPart(child)) continue;
      place(child, comp);
      if (auto c = labelColor(comp)) {
        if (!partLike || child["color"].isNull()) child.set("color", rgbVal(c));
      }
      kids.call<void>("push", child);
      only = child;
      count++;
    }
    const auto color = labelColor(label);
    const auto layers = layersOf(label);
    if (partLike && count == 1) {
      // A part made of one plain shape: lift it.
      only.set("name", name);
      only.set("ref", nameOf(label));
      if (only["color"].isNull() && color) only.set("color", rgbVal(color));
      if (!layers.empty()) only.set("layers", stringArray(layers));
      return only;
    }
    val n = val::object();
    n.set("name", name);
    n.set("ref", nameOf(label));
    n.set("kind", partLike ? "part" : "assembly");
    n.set("color", rgbVal(color));
    if (!layers.empty()) n.set("layers", stringArray(layers));
    n.set("children", kids);
    return n;
  }

  Handle(TDocStd_Document) doc_;
  Handle(XCAFDoc_ShapeTool) shapeTool_;
  Handle(XCAFDoc_ColorTool) colorTool_;
  Handle(XCAFDoc_LayerTool) layerTool_;
  TDF_LabelSequence free_;
  double angle_, defl_ = 0.1;
  Progress progress_;
  std::map<std::string, PartInfo> parts_;
  int partsDone_ = 0, totalParts_ = 1;
  val meshes_ = val::null();
};

val readBrep(const std::string& path, double ratio, double angle, Progress progress) {
  TopoDS_Shape shape;
  BRep_Builder builder;
  progress("Reading file");
  if (!BRepTools::Read(shape, path.c_str(), builder)) throw std::runtime_error("Not a readable BREP file");
  const double defl = std::max(1e-4, diagonal(shape) * ratio);
  progress("Meshing parts", 1, 1);
  BRepMesh_IncrementalMesh(shape, defl, false, angle, false);
  val meshes = val::array();
  val kids = val::array();
  Bodies bodies = bodiesOf(shape, false);
  for (size_t bi = 0; bi < bodies.shapes.size(); bi++) {
    const TopoDS_Shape& body = bodies.shapes[bi];
    MeshOut m = meshBody(body, angle, defl, [](const TopoDS_Face&) { return std::optional<RGB>(); });
    if (m.index.empty() && m.edges.empty()) continue;
    val n = val::object();
    n.set("name", "");
    n.set("kind", "body");
    n.set("mesh", meshes["length"]);
    if (m.index.empty()) n.set("wire", true);
    else n.set("solid", bool(bodies.solid[bi]));
    n.set("children", val::array());
    meshes.call<void>("push", meshVal(m));
    kids.call<void>("push", n);
  }
  val root = val::object();
  root.set("name", "");
  root.set("kind", "part");
  root.set("children", kids);
  val res = val::object();
  res.set("root", root);
  res.set("meshes", meshes);
  return res;
}


// ---- writer --------------------------------------------------------------------
//
// spec = { name, format, root: Node }
//   Node = { name, kind: 'assembly'|'part'|'body', color?: [r,g,b], layers?: string[],
//            matrix?: number[12] (row-major 3x4, placement in the parent), children?: Node[],
//            brep?: Uint8Array (exact body), brepId?: number (same id = same shape, written once),
//            prim?: { type: 'box'|'cylinder'|'sphere', ... }, mesh?: { position: Float32Array, index?: Uint32Array } }
// Bodies with neither an exact shape nor a primitive are written as faceted
// solids from their triangles (e.g. STL imports), up to a size limit.

class XcafWriter {
 public:
  explicit XcafWriter(Progress progress) : progress_(progress) {
    doc_ = new TDocStd_Document("XmlXCAF");
    // Sets up the XCAF tools on the document.
    shapeTool_ = XCAFDoc_DocumentTool::ShapeTool(doc_->Main());
    colorTool_ = XCAFDoc_DocumentTool::ColorTool(doc_->Main());
    layerTool_ = XCAFDoc_DocumentTool::LayerTool(doc_->Main());
    shapeTool_->SetAutoNaming(false);
  }

  /** Builds the document; returns the top label (null if nothing could be written). */
  TDF_Label build(val root) {
    countBodies(root);
    TDF_Label top = add(root);
    shapeTool_->UpdateAssemblies();
    return top;
  }

  Handle(TDocStd_Document) doc() const { return doc_; }
  int skipped() const { return skipped_; }
  int faceted() const { return faceted_; }

 private:
  void countBodies(val n) {
    if (n["kind"].as<std::string>() == "body") total_++;
    val kids = n["children"];
    if (!kids.isUndefined() && !kids.isNull())
      for (int i = 0, c = kids["length"].as<int>(); i < c; i++) countBodies(kids[i]);
  }

  static bool has(const val& o, const char* key) {
    val v = o[key];
    return !v.isUndefined() && !v.isNull();
  }

  static std::optional<RGB> colorOf(const val& n) {
    if (!has(n, "color")) return std::nullopt;
    val c = n["color"];
    return RGB{c[0].as<double>(), c[1].as<double>(), c[2].as<double>()};
  }

  /** Placement in the parent; `scale` is set when it isn't a rigid motion. */
  static gp_Trsf trsfOf(const val& n) {
    gp_Trsf t;
    if (!has(n, "matrix")) return t;
    val m = n["matrix"];
    double v[12];
    for (int i = 0; i < 12; i++) v[i] = m[i].as<double>();
    t.SetValues(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9], v[10], v[11]);
    return t;
  }

  void decorate(const TDF_Label& label, const val& n) {
    std::string name = has(n, "name") ? n["name"].as<std::string>() : "";
    if (!name.empty()) TDataStd_Name::Set(label, TCollection_ExtendedString(name.c_str(), true));
    if (auto c = colorOf(n))
      colorTool_->SetColor(label, Quantity_Color((*c)[0], (*c)[1], (*c)[2], Quantity_TOC_RGB), XCAFDoc_ColorGen);
    if (has(n, "layers")) {
      val l = n["layers"];
      for (int i = 0, c = l["length"].as<int>(); i < c; i++)
        layerTool_->SetLayer(label, TCollection_ExtendedString(l[i].as<std::string>().c_str(), true));
    }
  }

  TopoDS_Shape facetedShape(const val& mesh) {
    std::vector<float> pos = emscripten::convertJSArrayToNumberVector<float>(mesh["position"]);
    std::vector<uint32_t> idx;
    if (has(mesh, "index")) idx = emscripten::convertJSArrayToNumberVector<uint32_t>(mesh["index"]);
    else
      for (uint32_t i = 0; i < pos.size() / 3; i++) idx.push_back(i);
    const size_t tris = idx.size() / 3;
    if (tris == 0 || tris > 60000) return TopoDS_Shape();
    BRepBuilderAPI_Sewing sew(1e-4);
    auto P = [&](uint32_t i) { return gp_Pnt(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); };
    int added = 0;
    for (size_t t = 0; t < tris; t++) {
      const gp_Pnt a = P(idx[t * 3]), b = P(idx[t * 3 + 1]), c = P(idx[t * 3 + 2]);
      if (a.Distance(b) < 1e-7 || b.Distance(c) < 1e-7 || a.Distance(c) < 1e-7) continue;
      if (gp_Vec(a, b).Crossed(gp_Vec(a, c)).Magnitude() < 1e-12) continue;
      try {
        BRepBuilderAPI_MakePolygon poly(a, b, c, true);
        if (!poly.IsDone()) continue;
        BRepBuilderAPI_MakeFace face(poly.Wire(), true);
        if (!face.IsDone()) continue;
        sew.Add(face.Face());
        added++;
      } catch (const Standard_Failure&) {
      }
    }
    if (!added) return TopoDS_Shape();
    sew.Perform();
    TopoDS_Shape s = sew.SewedShape();
    // A closed shell becomes a solid.
    if (s.ShapeType() == TopAbs_SHELL && s.Closed()) {
      BRepBuilderAPI_MakeSolid solid(TopoDS::Shell(s));
      if (solid.IsDone()) return solid.Solid();
    }
    return s;
  }

  TopoDS_Shape primShape(const val& p) {
    const std::string type = p["type"].as<std::string>();
    auto num = [&](const char* k) { return p[k].as<double>(); };
    auto pnt = [&](const char* k) { val a = p[k]; return gp_Pnt(a[0].as<double>(), a[1].as<double>(), a[2].as<double>()); };
    if (type == "box") return BRepPrimAPI_MakeBox(pnt("min"), num("dx"), num("dy"), num("dz")).Shape();
    if (type == "cylinder") return BRepPrimAPI_MakeCylinder(gp_Ax2(pnt("base"), gp::DZ()), num("radius"), num("height")).Shape();
    if (type == "sphere") return BRepPrimAPI_MakeSphere(pnt("center"), num("radius")).Shape();
    return TopoDS_Shape();
  }

  TopoDS_Shape bodyShape(const val& n) {
    if (has(n, "brep")) {
      const int id = has(n, "brepId") ? n["brepId"].as<int>() : -1;
      if (id >= 0) {
        auto it = breps_.find(id);
        if (it != breps_.end()) return it->second;
      }
      std::vector<uint8_t> bytes = emscripten::convertJSArrayToNumberVector<uint8_t>(n["brep"]);
      std::istringstream is(std::string(bytes.begin(), bytes.end()));
      TopoDS_Shape s;
      BinTools::Read(s, is);
      if (id >= 0) breps_[id] = s;
      return s;
    }
    if (has(n, "prim")) return primShape(n["prim"]);
    if (has(n, "mesh")) {
      TopoDS_Shape s = facetedShape(n["mesh"]);
      if (!s.IsNull()) faceted_++;
      return s;
    }
    return TopoDS_Shape();
  }

  /** A body label; equal bodies (same shape, name, colour) are written once and instanced. */
  TDF_Label bodyLabel(const val& n, const gp_Trsf* bake) {
    std::string key;
    if (!bake && has(n, "brepId")) {
      std::ostringstream k;
      k << n["brepId"].as<int>() << '|' << (has(n, "name") ? n["name"].as<std::string>() : "");
      if (auto c = colorOf(n)) k << '|' << (*c)[0] << ',' << (*c)[1] << ',' << (*c)[2];
      key = k.str();
      auto it = bodies_.find(key);
      if (it != bodies_.end()) return it->second;
    }
    progress_("Writing bodies", ++done_, total_);
    TopoDS_Shape s;
    try {
      s = bodyShape(n);
      if (!s.IsNull() && bake) s = BRepBuilderAPI_Transform(s, *bake, true).Shape();
    } catch (const Standard_Failure&) {
      s.Nullify();
    }
    if (s.IsNull()) {
      skipped_++;
      return TDF_Label();
    }
    TDF_Label label = shapeTool_->AddShape(s, false);
    decorate(label, n);
    if (!key.empty()) bodies_[key] = label;
    return label;
  }

  TDF_Label add(const val& n) {
    if (n["kind"].as<std::string>() == "body") return bodyLabel(n, nullptr);
    TDF_Label label = shapeTool_->NewShape();
    int count = 0;
    val kids = n["children"];
    for (int i = 0, c = has(n, "children") ? kids["length"].as<int>() : 0; i < c; i++) {
      val child = kids[i];
      gp_Trsf t = trsfOf(child);
      TDF_Label cl;
      if (std::fabs(t.ScaleFactor() - 1) > 1e-9 || t.IsNegative()) {
        // Locations must be rigid motions: bake scaling / mirroring into the geometry.
        if (child["kind"].as<std::string>() != "body") continue;
        cl = bodyLabel(child, &t);
        t = gp_Trsf();
      } else cl = add(child);
      if (cl.IsNull()) continue;
      TDF_Label comp = shapeTool_->AddComponent(label, cl, TopLoc_Location(t));
      // Instance name too, so other systems (and our reader) show it instead of a number.
      if (!comp.IsNull() && has(child, "name") && !child["name"].as<std::string>().empty())
        TDataStd_Name::Set(comp, TCollection_ExtendedString(child["name"].as<std::string>().c_str(), true));
      count++;
    }
    if (!count) {
      shapeTool_->RemoveShape(label);
      return TDF_Label();
    }
    decorate(label, n);
    return label;
  }

  Progress progress_;
  Handle(TDocStd_Document) doc_;
  Handle(XCAFDoc_ShapeTool) shapeTool_;
  Handle(XCAFDoc_ColorTool) colorTool_;
  Handle(XCAFDoc_LayerTool) layerTool_;
  std::map<int, TopoDS_Shape> breps_;
  std::map<std::string, TDF_Label> bodies_;
  int skipped_ = 0, faceted_ = 0, done_ = 0, total_ = 0;
};

}  // namespace

/** A copy of an XCAF document with every placed body as its own top-level shape. */
Handle(TDocStd_Document) flatten(const Handle(TDocStd_Document)& doc) {
  Handle(TDocStd_Document) flat = new TDocStd_Document("XmlXCAF");
  Handle(XCAFDoc_ShapeTool) st = XCAFDoc_DocumentTool::ShapeTool(doc->Main()), fst = XCAFDoc_DocumentTool::ShapeTool(flat->Main());
  Handle(XCAFDoc_ColorTool) ct = XCAFDoc_DocumentTool::ColorTool(doc->Main()), fct = XCAFDoc_DocumentTool::ColorTool(flat->Main());
  Handle(XCAFDoc_LayerTool) lt = XCAFDoc_DocumentTool::LayerTool(doc->Main()), flt = XCAFDoc_DocumentTool::LayerTool(flat->Main());
  fst->SetAutoNaming(false);
  std::function<void(const TDF_Label&, const TopLoc_Location&)> walk = [&](const TDF_Label& l, const TopLoc_Location& loc) {
    if (XCAFDoc_ShapeTool::IsAssembly(l)) {
      TDF_LabelSequence comps;
      XCAFDoc_ShapeTool::GetComponents(l, comps, false);
      for (int i = 1; i <= comps.Length(); i++) {
        TDF_Label ref;
        XCAFDoc_ShapeTool::GetReferredShape(comps.Value(i), ref);
        walk(ref, loc * XCAFDoc_ShapeTool::GetLocation(comps.Value(i)));
      }
      return;
    }
    const TopoDS_Shape s = BRepBuilderAPI_Transform(XCAFDoc_ShapeTool::GetShape(l), loc.Transformation(), true).Shape();
    const TDF_Label nl = fst->AddShape(s, false);
    Handle(TDataStd_Name) name;
    if (l.FindAttribute(TDataStd_Name::GetID(), name)) TDataStd_Name::Set(nl, name->Get());
    Quantity_Color c;
    if (ct->GetColor(l, XCAFDoc_ColorGen, c)) fct->SetColor(nl, c, XCAFDoc_ColorGen);
    Handle(TColStd_HSequenceOfExtendedString) layers;
    if (lt->GetLayers(l, layers))
      for (int i = 1; i <= layers->Length(); i++) flt->SetLayer(nl, layers->Value(i));
  };
  TDF_LabelSequence free;
  st->GetFreeShapes(free);
  for (int i = 1; i <= free.Length(); i++) walk(free.Value(i), TopLoc_Location());
  return flat;
}

val writeCad(std::string path, std::string format, val spec, val progressFn) {
  Progress progress{progressFn};
  try {
    XcafWriter w(progress);
    TDF_Label top = w.build(spec["root"]);
    if (top.IsNull()) throw std::runtime_error("Nothing to export: none of the items has exportable geometry");
    progress("Writing file");
    if (format == "brep") {
      // One flat compound of placed bodies.
      TopoDS_Compound all;
      BRep_Builder b;
      b.MakeCompound(all);
      std::function<void(const TDF_Label&, const TopLoc_Location&)> collect = [&](const TDF_Label& l, const TopLoc_Location& loc) {
        if (!XCAFDoc_ShapeTool::IsAssembly(l)) {
          b.Add(all, XCAFDoc_ShapeTool::GetShape(l).Moved(loc));
          return;
        }
        TDF_LabelSequence comps;
        XCAFDoc_ShapeTool::GetComponents(l, comps, false);
        for (int i = 1; i <= comps.Length(); i++) {
          TDF_Label ref;
          XCAFDoc_ShapeTool::GetReferredShape(comps.Value(i), ref);
          collect(ref, loc * XCAFDoc_ShapeTool::GetLocation(comps.Value(i)));
        }
      };
      collect(top, TopLoc_Location());
      if (!BRepTools::Write(all, path.c_str())) throw std::runtime_error("Could not write the BREP file");
    } else if (format == "step") {
      // Parameters exist once the writer has set up its translator, so set them after.
      STEPCAFControl_Writer wr;
      Interface_Static::SetCVal("write.step.unit", "MM");
      wr.SetColorMode(true);
      wr.SetNameMode(true);
      wr.SetLayerMode(true);
      if (!wr.Transfer(w.doc(), STEPControl_AsIs)) throw std::runtime_error("The CAD kernel could not convert the model to STEP");
      if (wr.Write(path.c_str()) != IFSelect_RetDone) throw std::runtime_error("Could not write the STEP file");
    } else {
      // Solids as B-rep (type 186), so they come back as solids, not loose faces.
      // (The parameters only exist once the IGES translator is set up.)
      IGESControl_Controller::Init();
      Interface_Static::SetIVal("write.iges.brep.mode", 1);
      Interface_Static::SetCVal("write.iges.unit", "MM");
      IGESCAFControl_Writer wr;
      wr.SetColorMode(true);
      wr.SetNameMode(true);
      wr.SetLayerMode(true);
      // IGES has no real assemblies, and the writer keeps only one of several
      // placed copies of a body: write every placed body as its own solid.
      if (!wr.Transfer(flatten(w.doc()))) throw std::runtime_error("The CAD kernel could not convert the model to IGES");
      if (!wr.Write(path.c_str())) throw std::runtime_error("Could not write the IGES file");
    }
    val res = val::object();
    res.set("skipped", w.skipped());
    res.set("faceted", w.faceted());
    return res;
  } catch (const Standard_Failure& e) {
    val err = val::object();
    err.set("error", std::string("CAD kernel error: ") + (e.GetMessageString() ? e.GetMessageString() : e.DynamicType()->Name()));
    return err;
  } catch (const std::exception& e) {
    val err = val::object();
    err.set("error", std::string(e.what()));
    return err;
  }
}

val readCad(std::string path, std::string format, double ratio, double angle, val progressFn) {
  Progress progress{progressFn};
  try {
    if (format == "brep") return readBrep(path, ratio, angle, progress);
    Handle(TDocStd_Document) doc = new TDocStd_Document("XmlXCAF");
    bool ok = false;
    if (format == "step") {
      STEPCAFControl_Reader r;
      r.SetColorMode(true);
      r.SetNameMode(true);
      r.SetLayerMode(true);
      // Keep names given to individual solids inside a part (multi-body parts).
      Interface_Static::SetIVal("read.stepcaf.subshapes.name", 1);
      progress("Reading file");
      if (r.ReadFile(path.c_str()) != IFSelect_RetDone) throw std::runtime_error("Not a readable STEP file");
      progress("Converting geometry");
      ok = r.Transfer(doc);
    } else {
      IGESCAFControl_Reader r;
      r.SetColorMode(true);
      r.SetNameMode(true);
      r.SetLayerMode(true);
      progress("Reading file");
      if (r.ReadFile(path.c_str()) != IFSelect_RetDone) throw std::runtime_error("Not a readable IGES file");
      progress("Converting geometry");
      ok = r.Transfer(doc);
    }
    if (!ok) throw std::runtime_error("The CAD kernel could not convert this file");
    XcafReader reader(doc, ratio, angle, progress);
    return reader.run();
  } catch (const Standard_Failure& e) {
    val err = val::object();
    err.set("error", std::string("CAD kernel error: ") + (e.GetMessageString() ? e.GetMessageString() : e.DynamicType()->Name()));
    return err;
  } catch (const std::exception& e) {
    val err = val::object();
    err.set("error", std::string(e.what()));
    return err;
  }
}


// ---- measure ----------------------------------------------------------------
//
// Module.measure(items) with items = [{ key, brep?, kind: 'body'|'face'|'edge'|'vertex', index, matrix? }]
// (index in TopExp::MapShapes order, matrix row-major 3x4 to world). Bodies are
// cached by `key`, so `brep` is only needed the first time.
// -> { items: [description], pair?: { distance, p1, p2, angle?, centerDistance?, c1?, c2? } } | { error }

namespace {
constexpr double kPi = 3.14159265358979323846;
std::map<int, TopoDS_Shape> g_shapes;

val xyz(const gp_XYZ& p) {
  val a = val::array();
  a.call<void>("push", p.X(), p.Y(), p.Z());
  return a;
}

struct Measured {
  TopoDS_Shape shape;
  std::optional<gp_Dir> dir;  // plane normal, line direction, axis
  bool isAxis = false;        // direction of a line / axis (sign doesn't matter)
  std::optional<gp_Pnt> center;
};

val describe(const std::string& kind, Measured& m) {
  val d = val::object();
  d.set("kind", kind);
  GProp_GProps g;
  if (kind == "vertex") {
    d.set("point", xyz(BRep_Tool::Pnt(TopoDS::Vertex(m.shape)).XYZ()));
    m.center = BRep_Tool::Pnt(TopoDS::Vertex(m.shape));
  } else if (kind == "edge") {
    const TopoDS_Edge& e = TopoDS::Edge(m.shape);
    BRepGProp::LinearProperties(e, g);
    d.set("length", g.Mass());
    BRepAdaptor_Curve c(e);
    d.set("start", xyz(c.Value(c.FirstParameter()).XYZ()));
    d.set("end", xyz(c.Value(c.LastParameter()).XYZ()));
    switch (c.GetType()) {
      case GeomAbs_Line:
        d.set("curve", "Line");
        m.dir = c.Line().Direction();
        m.isAxis = true;
        d.set("direction", xyz(m.dir->XYZ()));
        break;
      case GeomAbs_Circle: {
        const gp_Circ circ = c.Circle();
        d.set("curve", BRep_Tool::IsClosed(e) || std::fabs(c.LastParameter() - c.FirstParameter() - 2 * kPi) < 1e-6 ? "Circle" : "Arc");
        d.set("radius", circ.Radius());
        d.set("center", xyz(circ.Location().XYZ()));
        d.set("normal", xyz(circ.Axis().Direction().XYZ()));
        d.set("sweep", (c.LastParameter() - c.FirstParameter()) * 180 / kPi);
        m.center = circ.Location();
        m.dir = circ.Axis().Direction();
        m.isAxis = true;
        break;
      }
      case GeomAbs_Ellipse:
        d.set("curve", "Ellipse");
        d.set("major", c.Ellipse().MajorRadius());
        d.set("minor", c.Ellipse().MinorRadius());
        d.set("center", xyz(c.Ellipse().Location().XYZ()));
        m.center = c.Ellipse().Location();
        break;
      default:
        d.set("curve", "Spline");
    }
  } else if (kind == "face") {
    const TopoDS_Face& f = TopoDS::Face(m.shape);
    BRepGProp::SurfaceProperties(f, g);
    d.set("area", g.Mass());
    d.set("centroid", xyz(g.CentreOfMass().XYZ()));
    BRepAdaptor_Surface su(f);
    switch (su.GetType()) {
      case GeomAbs_Plane: {
        gp_Dir n = su.Plane().Axis().Direction();
        if (f.Orientation() == TopAbs_REVERSED) n.Reverse();
        d.set("surface", "Plane");
        d.set("normal", xyz(n.XYZ()));
        m.dir = n;
        break;
      }
      case GeomAbs_Cylinder:
        d.set("surface", "Cylinder");
        d.set("radius", su.Cylinder().Radius());
        d.set("axis", xyz(su.Cylinder().Axis().Direction().XYZ()));
        d.set("axisPoint", xyz(su.Cylinder().Axis().Location().XYZ()));
        m.dir = su.Cylinder().Axis().Direction();
        m.isAxis = true;
        break;
      case GeomAbs_Cone:
        d.set("surface", "Cone");
        d.set("halfAngle", su.Cone().SemiAngle() * 180 / kPi);
        d.set("axis", xyz(su.Cone().Axis().Direction().XYZ()));
        m.dir = su.Cone().Axis().Direction();
        m.isAxis = true;
        break;
      case GeomAbs_Sphere:
        d.set("surface", "Sphere");
        d.set("radius", su.Sphere().Radius());
        d.set("center", xyz(su.Sphere().Location().XYZ()));
        m.center = su.Sphere().Location();
        break;
      case GeomAbs_Torus:
        d.set("surface", "Torus");
        d.set("major", su.Torus().MajorRadius());
        d.set("minor", su.Torus().MinorRadius());
        break;
      default:
        d.set("surface", "Freeform");
    }
  } else {
    BRepGProp::VolumeProperties(m.shape, g);
    const double vol = g.Mass();
    if (std::fabs(vol) > 1e-9) {
      d.set("volume", std::fabs(vol));
      d.set("centroid", xyz(g.CentreOfMass().XYZ()));
    }
    GProp_GProps sg;
    BRepGProp::SurfaceProperties(m.shape, sg);
    d.set("area", sg.Mass());
  }
  return d;
}
}  // namespace

val measure(val items) {
  try {
    std::vector<Measured> list;
    val each = val::array();
    for (int i = 0, n = items["length"].as<int>(); i < n; i++) {
      val it = items[i];
      const int key = it["key"].as<int>();
      if (!it["brep"].isUndefined() && !it["brep"].isNull()) {
        std::vector<uint8_t> bytes = emscripten::convertJSArrayToNumberVector<uint8_t>(it["brep"]);
        std::istringstream is(std::string(bytes.begin(), bytes.end()));
        TopoDS_Shape sh;
        BinTools::Read(sh, is);
        g_shapes[key] = sh;
      }
      auto found = g_shapes.find(key);
      if (found == g_shapes.end()) throw std::runtime_error("missing-shape");
      const std::string kind = it["kind"].as<std::string>();
      TopoDS_Shape sub = found->second;
      if (kind != "body") {
        TopTools_IndexedMapOfShape map;
        TopExp::MapShapes(sub, kind == "face" ? TopAbs_FACE : kind == "edge" ? TopAbs_EDGE : TopAbs_VERTEX, map);
        const int idx = it["index"].as<int>();
        if (idx < 0 || idx >= map.Extent()) throw std::runtime_error("That item no longer matches its body");
        sub = map.FindKey(idx + 1);
      }
      if (!it["matrix"].isUndefined() && !it["matrix"].isNull()) {
        val mm = it["matrix"];
        double v[12];
        for (int k = 0; k < 12; k++) v[k] = mm[k].as<double>();
        gp_Trsf t;
        t.SetValues(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9], v[10], v[11]);
        if (std::fabs(t.ScaleFactor() - 1) > 1e-9 || t.IsNegative()) sub = BRepBuilderAPI_Transform(sub, t, true).Shape();
        else sub = sub.Moved(TopLoc_Location(t));
      }
      Measured m;
      m.shape = sub;
      each.call<void>("push", describe(kind, m));
      list.push_back(m);
    }
    val res = val::object();
    res.set("items", each);
    if (list.size() == 2) {
      val pair = val::object();
      BRepExtrema_DistShapeShape dss(list[0].shape, list[1].shape);
      if (dss.IsDone() && dss.NbSolution() > 0) {
        pair.set("distance", dss.Value());
        pair.set("p1", xyz(dss.PointOnShape1(1).XYZ()));
        pair.set("p2", xyz(dss.PointOnShape2(1).XYZ()));
      }
      if (list[0].dir && list[1].dir) {
        double a = list[0].dir->Angle(*list[1].dir) * 180 / kPi;
        if (list[0].isAxis || list[1].isAxis) a = std::min(a, 180 - a);
        pair.set("angle", a);
      }
      if (list[0].center && list[1].center) {
        pair.set("centerDistance", list[0].center->Distance(*list[1].center));
        pair.set("c1", xyz(list[0].center->XYZ()));
        pair.set("c2", xyz(list[1].center->XYZ()));
      }
      res.set("pair", pair);
    }
    return res;
  } catch (const Standard_Failure& e) {
    val err = val::object();
    err.set("error", std::string("CAD kernel error: ") + (e.GetMessageString() ? e.GetMessageString() : e.DynamicType()->Name()));
    return err;
  } catch (const std::exception& e) {
    val err = val::object();
    err.set("error", std::string(e.what()));
    return err;
  }
}


/**
 * Exact bounding box of bodies in a datum frame.
 * items = [{ key, brep?, matrix? }] with matrix = body to datum frame (row-major 3x4).
 * -> { min: [x,y,z], max: [x,y,z] } | { error }
 */
val bounds(val items) {
  try {
    Bnd_Box box;
    for (int i = 0, n = items["length"].as<int>(); i < n; i++) {
      val it = items[i];
      const int key = it["key"].as<int>();
      if (!it["brep"].isUndefined() && !it["brep"].isNull()) {
        std::vector<uint8_t> bytes = emscripten::convertJSArrayToNumberVector<uint8_t>(it["brep"]);
        std::istringstream is(std::string(bytes.begin(), bytes.end()));
        TopoDS_Shape sh;
        BinTools::Read(sh, is);
        g_shapes[key] = sh;
      }
      auto found = g_shapes.find(key);
      if (found == g_shapes.end()) throw std::runtime_error("missing-shape");
      TopoDS_Shape sh = found->second;
      if (!it["matrix"].isUndefined() && !it["matrix"].isNull()) {
        val mm = it["matrix"];
        double v[12];
        for (int k = 0; k < 12; k++) v[k] = mm[k].as<double>();
        gp_Trsf t;
        t.SetValues(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9], v[10], v[11]);
        sh = BRepBuilderAPI_Transform(sh, t, true).Shape();
      }
      BRepBndLib::AddOptimal(sh, box, false, false);
    }
    if (box.IsVoid()) throw std::runtime_error("Nothing to measure");
    double x0, y0, z0, x1, y1, z1;
    box.Get(x0, y0, z0, x1, y1, z1);
    val res = val::object();
    res.set("min", xyz(gp_XYZ(x0, y0, z0)));
    res.set("max", xyz(gp_XYZ(x1, y1, z1)));
    return res;
  } catch (const Standard_Failure& e) {
    val err = val::object();
    err.set("error", std::string("CAD kernel error: ") + (e.GetMessageString() ? e.GetMessageString() : e.DynamicType()->Name()));
    return err;
  } catch (const std::exception& e) {
    val err = val::object();
    err.set("error", std::string(e.what()));
    return err;
  }
}

/**
 * Edit faces: push / pull faces of a body by a distance along their outward
 * normal (positive = out, adding material; negative = in, removing it).
 * Flat faces are swept and fused / cut (robust, like press-pull); any curved
 * face makes the whole edit go through an offset with per-face values.
 * item = { key, brep?, faces: [index...], distance } -> { brep: Uint8Array } | { error }
 */
val editFaces(val it) {
  try {
    const int key = it["key"].as<int>();
    if (!it["brep"].isUndefined() && !it["brep"].isNull()) {
      std::vector<uint8_t> bytes = emscripten::convertJSArrayToNumberVector<uint8_t>(it["brep"]);
      std::istringstream is(std::string(bytes.begin(), bytes.end()));
      TopoDS_Shape sh;
      BinTools::Read(sh, is);
      g_shapes[key] = sh;
    }
    auto found = g_shapes.find(key);
    if (found == g_shapes.end()) throw std::runtime_error("missing-shape");
    const TopoDS_Shape body = found->second;
    const double d = it["distance"].as<double>();
    if (std::fabs(d) < 1e-9) throw std::runtime_error("Distance is zero");
    TopTools_IndexedMapOfShape map;
    TopExp::MapShapes(body, TopAbs_FACE, map);
    std::vector<TopoDS_Face> faces;
    val idx = it["faces"];
    for (int i = 0, n = idx["length"].as<int>(); i < n; i++) {
      const int k = idx[i].as<int>();
      if (k < 0 || k >= map.Extent()) throw std::runtime_error("That face no longer matches its body");
      faces.push_back(TopoDS::Face(map.FindKey(k + 1)));
    }
    if (faces.empty()) throw std::runtime_error("No faces picked");
    bool allFlat = true;
    for (auto& f : faces) if (BRepAdaptor_Surface(f).GetType() != GeomAbs_Plane) allFlat = false;

    TopoDS_Shape result;
    if (allFlat) {
      TopTools_ListOfShape tools;
      for (auto& f : faces) {
        gp_Pln pl = BRepAdaptor_Surface(f).Plane();
        gp_Dir n = pl.Axis().Direction();
        if (f.Orientation() == TopAbs_REVERSED) n.Reverse();
        tools.Append(BRepPrimAPI_MakePrism(f, gp_Vec(n) * d).Shape());
      }
      TopTools_ListOfShape args;
      args.Append(body);
      if (d > 0) {
        BRepAlgoAPI_Fuse op;
        op.SetArguments(args);
        op.SetTools(tools);
        op.Build();
        if (!op.IsDone()) throw std::runtime_error("The faces couldn't be pulled out that far");
        result = op.Shape();
      } else {
        BRepAlgoAPI_Cut op;
        op.SetArguments(args);
        op.SetTools(tools);
        op.Build();
        if (!op.IsDone()) throw std::runtime_error("The faces couldn't be pushed in that far");
        result = op.Shape();
      }
      ShapeUpgrade_UnifySameDomain unify(result, true, true, true);
      unify.Build();
      result = unify.Shape();
    } else {
      BRepOffset_MakeOffset mo;
      mo.Initialize(body, 0.0, 1e-4, BRepOffset_Skin, Standard_False, Standard_False, GeomAbs_Intersection, Standard_False);
      for (auto& f : faces) mo.SetOffsetOnFace(f, d);
      mo.MakeOffsetShape();
      if (!mo.IsDone()) throw std::runtime_error("Those faces can't be offset that far");
      result = mo.Shape();
    }
    if (result.IsNull()) throw std::runtime_error("The edit gave an empty body");
    // Text BREP, as readCad('brep') takes it.
    std::ostringstream os;
    BRepTools::Write(result, os);
    const std::string str = os.str();
    val res = val::object();
    res.set("brep", val(emscripten::typed_memory_view(str.size(), reinterpret_cast<const uint8_t*>(str.data()))).call<val>("slice"));
    return res;
  } catch (const Standard_Failure& e) {
    val err = val::object();
    err.set("error", std::string("CAD kernel error: ") + (e.GetMessageString() ? e.GetMessageString() : e.DynamicType()->Name()));
    return err;
  } catch (const std::exception& e) {
    val err = val::object();
    err.set("error", std::string(e.what()));
    return err;
  }
}

// ---- solid modelling ------------------------------------------------------------

namespace {
gp_Pnt pnt(const val& a) { return gp_Pnt(a[0].as<double>(), a[1].as<double>(), a[2].as<double>()); }
gp_Vec vec(const val& a) { return gp_Vec(a[0].as<double>(), a[1].as<double>(), a[2].as<double>()); }
bool has(const val& v, const char* k) { return !v[k].isUndefined() && !v[k].isNull(); }

/** Segments [{ a, b, m? }] (m: a point on an arc between a and b) -> wire. */
TopoDS_Wire wireOf(const val& segs) {
  BRepBuilderAPI_MakeWire mw;
  for (int i = 0, n = segs["length"].as<int>(); i < n; i++) {
    val s = segs[i];
    const gp_Pnt a = pnt(s["a"]), b = pnt(s["b"]);
    TopoDS_Edge e;
    if (has(s, "m")) {
      GC_MakeArcOfCircle arc(a, pnt(s["m"]), b);
      if (!arc.IsDone()) throw std::runtime_error("A profile arc is degenerate");
      e = BRepBuilderAPI_MakeEdge(arc.Value()).Edge();
    } else {
      if (a.Distance(b) < 1e-7) continue;
      e = BRepBuilderAPI_MakeEdge(a, b).Edge();
    }
    mw.Add(e);
    if (!mw.IsDone()) throw std::runtime_error("The profile isn't a connected loop");
  }
  if (!mw.IsDone()) throw std::runtime_error("The profile is empty");
  return mw.Wire();
}

/** Profiles [{ outer: segs, holes: [segs] }] on a plane -> faces. */
std::vector<TopoDS_Face> facesOf(const val& profiles, const gp_Pln& pln) {
  std::vector<TopoDS_Face> out;
  for (int i = 0, n = profiles["length"].as<int>(); i < n; i++) {
    val pr = profiles[i];
    BRepBuilderAPI_MakeFace mf(pln, wireOf(pr["outer"]), Standard_True);
    if (has(pr, "holes")) {
      val hs = pr["holes"];
      for (int k = 0, m = hs["length"].as<int>(); k < m; k++) mf.Add(wireOf(hs[k]));
    }
    if (!mf.IsDone()) throw std::runtime_error("A profile couldn't be made into a face");
    ShapeFix_Face fix(mf.Face());
    fix.FixOrientation();
    fix.Perform();
    out.push_back(fix.Face());
  }
  if (out.empty()) throw std::runtime_error("No profile picked");
  return out;
}

TopoDS_Shape fuseAll(const std::vector<TopoDS_Shape>& list) {
  if (list.size() == 1) return list[0];
  TopTools_ListOfShape args, tools;
  args.Append(list[0]);
  for (size_t i = 1; i < list.size(); i++) tools.Append(list[i]);
  BRepAlgoAPI_Fuse op;
  op.SetArguments(args);
  op.SetTools(tools);
  op.Build();
  if (!op.IsDone()) throw std::runtime_error("The pieces couldn't be joined");
  return op.Shape();
}

/** Prism of a face from the plane out to `d` along n, with an optional draft (degrees, + narrows). */
TopoDS_Shape prism(const TopoDS_Face& f, const gp_Dir& n, const gp_Pnt& origin, double d, double draft) {
  TopoDS_Shape s = BRepPrimAPI_MakePrism(f, gp_Vec(n) * d).Shape();
  if (std::fabs(draft) < 1e-9) return s;
  gp_Dir pull = d > 0 ? n : n.Reversed();
  BRepOffsetAPI_DraftAngle da(s);
  for (TopExp_Explorer ex(s, TopAbs_FACE); ex.More(); ex.Next()) {
    const TopoDS_Face& face = TopoDS::Face(ex.Current());
    BRepAdaptor_Surface su(face);
    // Caps are parallel to the sketch: leave them.
    if (su.GetType() == GeomAbs_Plane && su.Plane().Axis().Direction().IsParallel(n, 1e-6)) continue;
    da.Add(face, pull, -draft * kPi / 180, gp_Pln(origin, n));
    if (!da.AddDone()) throw std::runtime_error("That draft angle can't be applied to this profile");
  }
  da.Build();
  if (!da.IsDone()) throw std::runtime_error("That draft angle can't be applied to this profile");
  return da.Shape();
}

TopoDS_Shape boolean(const std::string& op, const TopoDS_Shape& a, const std::vector<TopoDS_Shape>& tools) {
  TopTools_ListOfShape args, tl;
  args.Append(a);
  for (auto& t : tools) tl.Append(t);
  TopoDS_Shape r;
  if (op == "fuse") {
    BRepAlgoAPI_Fuse b;
    b.SetArguments(args);
    b.SetTools(tl);
    b.Build();
    if (!b.IsDone() || b.HasErrors()) throw std::runtime_error("The bodies couldn't be added together");
    r = b.Shape();
  } else if (op == "cut") {
    BRepAlgoAPI_Cut b;
    b.SetArguments(args);
    b.SetTools(tl);
    b.Build();
    if (!b.IsDone() || b.HasErrors()) throw std::runtime_error("The cut couldn't be made");
    r = b.Shape();
  } else if (op == "common") {
    BRepAlgoAPI_Common b;
    b.SetArguments(args);
    b.SetTools(tl);
    b.Build();
    if (!b.IsDone() || b.HasErrors()) throw std::runtime_error("The intersection couldn't be made");
    r = b.Shape();
  } else {
    throw std::runtime_error("Unknown boolean " + op);
  }
  ShapeUpgrade_UnifySameDomain unify(r, true, true, true);
  unify.Build();
  return unify.Shape();
}

int countSolids(const TopoDS_Shape& s) {
  int n = 0;
  for (TopExp_Explorer ex(s, TopAbs_SOLID); ex.More(); ex.Next()) n++;
  return n;
}

double volumeOf(const TopoDS_Shape& s) {
  GProp_GProps g;
  BRepGProp::VolumeProperties(s, g);
  return std::fabs(g.Mass());
}
}  // namespace

/**
 * Solid modelling in one call: make a solid from sketch profiles (extrude,
 * revolve, sweep) and/or combine it with bodies (add, cut, intersect).
 *
 * items = [{ key, brep?, matrix? }]   bodies; matrix takes each into the frame the work is done in
 * spec  = {
 *   make?: { kind: 'extrude'|'revolve'|'sweep',
 *            profiles: [{ outer: Seg[], holes: Seg[][] }],  Seg = { a: [x,y,z], b, m? }  (m: point on an arc)
 *            origin: [x,y,z], normal: [x,y,z]                profile plane
 *            from?, to?, draft?                                extrude: distances along the normal, draft in degrees
 *            axisOrigin?, axis?, angle?                        revolve (degrees)
 *            path?: Seg[] }                                    sweep
 *   op: 'new'|'fuse'|'cut'|'common', target?: item index, tools?: [item index...]
 * }
 * -> { brep: Uint8Array (text BREP), solids, volume } | { error }
 */
val solid(val items, val spec) {
  try {
    std::vector<TopoDS_Shape> bodies;
    for (int i = 0, n = items["length"].as<int>(); i < n; i++) {
      val it = items[i];
      const int key = it["key"].as<int>();
      if (has(it, "brep")) {
        std::vector<uint8_t> bytes = emscripten::convertJSArrayToNumberVector<uint8_t>(it["brep"]);
        std::istringstream is(std::string(bytes.begin(), bytes.end()));
        TopoDS_Shape sh;
        BinTools::Read(sh, is);
        g_shapes[key] = sh;
      }
      auto found = g_shapes.find(key);
      if (found == g_shapes.end()) throw std::runtime_error("missing-shape");
      TopoDS_Shape sh = found->second;
      if (has(it, "matrix")) {
        val mm = it["matrix"];
        double v[12];
        for (int k = 0; k < 12; k++) v[k] = mm[k].as<double>();
        gp_Trsf t;
        t.SetValues(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9], v[10], v[11]);
        if (std::fabs(t.ScaleFactor() - 1) > 1e-9 || t.IsNegative()) sh = BRepBuilderAPI_Transform(sh, t, true).Shape();
        else if (t.Form() != gp_Identity) sh = sh.Moved(TopLoc_Location(t));
      }
      bodies.push_back(sh);
    }
    auto body = [&](const val& i) -> TopoDS_Shape {
      const int k = i.as<int>();
      if (k < 0 || k >= (int)bodies.size()) throw std::runtime_error("Missing body");
      return bodies[k];
    };

    const std::string op = spec["op"].as<std::string>();
    TopoDS_Shape made;
    if (has(spec, "make")) {
      val mk = spec["make"];
      const std::string kind = mk["kind"].as<std::string>();
      const gp_Pnt origin = pnt(mk["origin"]);
      const gp_Dir n(vec(mk["normal"]));
      const gp_Pln pln(origin, n);
      std::vector<TopoDS_Face> faces = facesOf(mk["profiles"], pln);
      std::vector<TopoDS_Shape> parts;
      if (kind == "extrude") {
        const double from = has(mk, "from") ? mk["from"].as<double>() : 0.0;
        const double to = mk["to"].as<double>();
        const double draft = has(mk, "draft") ? mk["draft"].as<double>() : 0.0;
        if (std::fabs(to - from) < 1e-7) throw std::runtime_error("Distance is zero");
        for (auto& f : faces) {
          // Each side runs from the sketch plane out, so a draft tapers away from the sketch.
          if (from < -1e-9 && to > 1e-9) {
            parts.push_back(prism(f, n, origin, to, draft));
            parts.push_back(prism(f, n, origin, from, draft));
          } else if (std::fabs(from) < 1e-9 || std::fabs(to) < 1e-9) {
            parts.push_back(prism(f, n, origin, std::fabs(from) < 1e-9 ? to : from, draft));
          } else {
            // Starts off the plane (offset start): no draft.
            TopoDS_Shape moved = BRepBuilderAPI_Transform(f, [&] { gp_Trsf t; t.SetTranslation(gp_Vec(n) * from); return t; }(), true).Shape();
            parts.push_back(BRepPrimAPI_MakePrism(moved, gp_Vec(n) * (to - from)).Shape());
          }
        }
      } else if (kind == "revolve") {
        const gp_Ax1 ax(pnt(mk["axisOrigin"]), gp_Dir(vec(mk["axis"])));
        const double ang = mk["angle"].as<double>();
        if (std::fabs(ang) < 1e-6) throw std::runtime_error("Angle is zero");
        for (auto& f : faces) {
          // Must not cross the axis.
          BRepExtrema_DistShapeShape dss(f, BRepBuilderAPI_MakeEdge(gp_Lin(ax)).Edge());
          if (dss.IsDone() && dss.NbSolution() > 0 && dss.Value() < 1e-7) {
            Bnd_Box bb;
            BRepBndLib::Add(f, bb);
            // Touching the axis along an edge is fine; crossing it isn't. Check both sides.
            gp_Vec side = gp_Vec(ax.Direction()).Crossed(gp_Vec(n));
            double lo = 1e300, hi = -1e300;
            for (TopExp_Explorer ex(f, TopAbs_VERTEX); ex.More(); ex.Next()) {
              const double s = gp_Vec(ax.Location(), BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()))).Dot(side);
              lo = std::min(lo, s);
              hi = std::max(hi, s);
            }
            if (lo < -1e-6 && hi > 1e-6) throw std::runtime_error("The profile crosses the axis");
          }
          if (std::fabs(std::fabs(ang) - 360) < 1e-6) parts.push_back(BRepPrimAPI_MakeRevol(f, ax).Shape());
          else parts.push_back(BRepPrimAPI_MakeRevol(f, ax, ang * kPi / 180).Shape());
        }
      } else if (kind == "sweep") {
        const TopoDS_Wire path = wireOf(mk["path"]);
        for (auto& f : faces) {
          // Outer and hole wires swept on their own, then the holes cut away.
          std::vector<TopoDS_Shape> holes;
          TopoDS_Shape outerSolid;
          const TopoDS_Wire outer = BRepTools::OuterWire(f);
          for (TopExp_Explorer ex(f, TopAbs_WIRE); ex.More(); ex.Next()) {
            TopoDS_Wire w = TopoDS::Wire(ex.Current());
            BRepOffsetAPI_MakePipeShell ps(path);
            ps.SetMode(Standard_False);  // corrected Frenet
            ps.SetTransitionMode(BRepBuilderAPI_RightCorner);
            ps.Add(w);
            ps.Build();
            if (!ps.IsDone()) throw std::runtime_error("The profile can't be swept along that path");
            if (!ps.MakeSolid()) throw std::runtime_error("The sweep didn't close into a solid");
            if (w.IsSame(outer)) outerSolid = ps.Shape();
            else holes.push_back(ps.Shape());
          }
          parts.push_back(holes.empty() ? outerSolid : boolean("cut", outerSolid, holes));
        }
      } else {
        throw std::runtime_error("Unknown solid " + kind);
      }
      made = fuseAll(parts);
      if (parts.size() > 1) {
        ShapeUpgrade_UnifySameDomain unify(made, true, true, true);
        unify.Build();
        made = unify.Shape();
      }
    }

    TopoDS_Shape result;
    if (op == "new") {
      if (made.IsNull()) throw std::runtime_error("Nothing to make");
      result = made;
    } else {
      const TopoDS_Shape target = body(spec["target"]);
      std::vector<TopoDS_Shape> tools;
      if (!made.IsNull()) tools.push_back(made);
      if (has(spec, "tools")) {
        val tl = spec["tools"];
        for (int i = 0, n = tl["length"].as<int>(); i < n; i++) tools.push_back(body(tl[i]));
      }
      if (tools.empty()) throw std::runtime_error("Pick the bodies to combine");
      result = boolean(op, target, tools);
    }
    if (result.IsNull() || countSolids(result) == 0)
      throw std::runtime_error(op == "common" ? "The bodies don't overlap" : op == "cut" ? "The cut removes the whole body" : "The result is empty");

    std::ostringstream os;
    BRepTools::Write(result, os);
    const std::string str = os.str();
    val res = val::object();
    res.set("brep", val(emscripten::typed_memory_view(str.size(), reinterpret_cast<const uint8_t*>(str.data()))).call<val>("slice"));
    res.set("solids", countSolids(result));
    res.set("volume", volumeOf(result));
    return res;
  } catch (const Standard_Failure& e) {
    val err = val::object();
    err.set("error", std::string("CAD kernel error: ") + (e.GetMessageString() ? e.GetMessageString() : e.DynamicType()->Name()));
    return err;
  } catch (const std::exception& e) {
    val err = val::object();
    err.set("error", std::string(e.what()));
    return err;
  }
}

/** Forget cached bodies (when the document is cleared). */
void forgetShapes() { g_shapes.clear(); }

EMSCRIPTEN_BINDINGS(cadkernel) {
  emscripten::function("readCad", &readCad);
  emscripten::function("writeCad", &writeCad);
  emscripten::function("measure", &measure);
  emscripten::function("bounds", &bounds);
  emscripten::function("editFaces", &editFaces);
  emscripten::function("solid", &solid);
  emscripten::function("forgetShapes", &forgetShapes);
}
