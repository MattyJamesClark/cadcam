// CADCAM Studio CAD kernel: OpenCascade compiled to WebAssembly.
//
// Reads STEP / IGES / BREP and returns the model as plain data in one call:
// the assembly tree (names, colours, layers, placements) and triangle meshes
// plus model edges per body. Doing the mesh extraction here in C++ (instead of
// thousands of small JS<->wasm calls) and building with native wasm exceptions
// is what makes imports fast.
//
// JS:  Module.readCad(path, format, ratio, angle, progress) -> { root, meshes }
//   Node = { name, ref, kind: 'assembly'|'part'|'body', color?, layers?, matrix?,
//            mesh?, wire?, solid?, children }
//   Mesh = { position: Float32Array, index: Uint32Array, faces: [first, last, color|null][], edges: Float32Array }
//   `ref` is the product name of the referenced shape (to look up STEP product data).

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <BRepAdaptor_Curve.hxx>
#include <BRepBndLib.hxx>
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
#include <TCollection_AsciiString.hxx>
#include <TCollection_ExtendedString.hxx>
#include <TDF_Label.hxx>
#include <TDF_LabelSequence.hxx>
#include <TDF_Tool.hxx>
#include <TDataStd_Name.hxx>
#include <TDocStd_Document.hxx>
#include <TopAbs.hxx>
#include <TopExp.hxx>
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
#include <gp_Trsf.hxx>

#include <algorithm>
#include <array>
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
  return o;
}

struct Bodies {
  std::vector<TopoDS_Shape> shapes;
  bool solid = false;
};

/** Split a shape into bodies: solids, else shells, else everything as one body. */
Bodies bodiesOf(const TopoDS_Shape& shape) {
  Bodies b;
  for (TopAbs_ShapeEnum type : {TopAbs_SOLID, TopAbs_SHELL}) {
    TopTools_IndexedMapOfShape map;
    TopExp::MapShapes(shape, type, map);
    if (map.Extent() > 0) {
      for (int i = 1; i <= map.Extent(); i++) b.shapes.push_back(map.FindKey(i));
      b.solid = type == TopAbs_SOLID;
      return b;
    }
  }
  TopTools_IndexedMapOfShape faces, edges;
  TopExp::MapShapes(shape, TopAbs_FACE, faces);
  TopExp::MapShapes(shape, TopAbs_EDGE, edges);
  if (faces.Extent() > 0 || edges.Extent() > 0) b.shapes.push_back(shape);
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
    for (const TopoDS_Shape& body : bodies.shapes) {
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
      b.solid = !b.wire && bodies.solid;
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
  for (const auto& body : bodies.shapes) {
    MeshOut m = meshBody(body, angle, defl, [](const TopoDS_Face&) { return std::optional<RGB>(); });
    if (m.index.empty() && m.edges.empty()) continue;
    val n = val::object();
    n.set("name", "");
    n.set("kind", "body");
    n.set("mesh", meshes["length"]);
    if (m.index.empty()) n.set("wire", true);
    else n.set("solid", bodies.solid);
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

}  // namespace

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
}
