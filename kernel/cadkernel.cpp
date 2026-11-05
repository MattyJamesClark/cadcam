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
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
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
#include <TopoDS.hxx>
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
  };
  std::vector<Face> faces;
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
    out.faces.push_back({tri, tri + nt - 1, faceColor(face)});
    tri += nt;
  }

  // Model edges as line segments sampled from the true curves.
  TopTools_IndexedMapOfShape edgeMap;
  TopExp::MapShapes(shape, TopAbs_EDGE, edgeMap);
  for (int i = 1; i <= edgeMap.Extent(); i++) {
    const TopoDS_Edge& edge = TopoDS::Edge(edgeMap.FindKey(i));
    if (BRep_Tool::Degenerated(edge)) continue;
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
  val faces = val::array();
  for (const auto& f : m.faces) {
    val e = val::array();
    e.call<void>("push", f.first, f.last, rgbVal(f.color));
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
Bodies bodiesOf(const TopoDS_Shape& shape) {
  Bodies b;
  BRep_Builder bb;
  std::function<void(const TopoDS_Shape&)> walk = [&](const TopoDS_Shape& s) {
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
  // Next to solids, curve-only leftovers are construction geometry (axes, sketches): leave them out.
  bool anySolid = false;
  for (size_t i = 0; i < b.shapes.size(); i++)
    if (b.shapes[i].ShapeType() == TopAbs_SOLID || b.shapes[i].ShapeType() == TopAbs_SHELL) anySolid = true;
  if (anySolid) {
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
    Bodies bodies = bodiesOf(shape);
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
  Bodies bodies = bodiesOf(shape);
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

EMSCRIPTEN_BINDINGS(cadkernel) {
  emscripten::function("readCad", &readCad);
  emscripten::function("writeCad", &writeCad);
}
