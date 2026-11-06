// CADCAM Studio: our modelling layer over OpenCascade ("rk" = robust kernel).
//
// OpenCascade's algorithms are good but brittle: a fillet that meets a vertex
// badly, a boolean on coincident faces or a shell over a tight curve either
// throws, says "not done", or worse hands back a broken or half-empty solid.
// Every operation here goes through the same pipeline:
//
//   1. pre-checks that catch the impossible cases early, in plain English,
//      naming the edge / face at fault (so the UI can show it in red);
//   2. the direct OpenCascade call;
//   3. if that fails or the result doesn't pass `accept` (valid B-rep, no lost
//      solids, a sane volume), a ladder of retries: healed input, fuzzy
//      tolerances, other join modes, other algorithms, other orders;
//   4. a tidy-up of the result (merge split faces, keep tolerances down).
//
// Results carry what was tried, which step worked, and for some failures a hint
// (e.g. the largest fillet radius that does fit). No emscripten in here: the
// same code builds natively for the stress tests (kernel/stress).

#pragma once

#include <BOPAlgo_CheckResult.hxx>
#include <BOPAlgo_GlueEnum.hxx>
#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_BooleanOperation.hxx>
#include <BRepAlgoAPI_Check.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Defeaturing.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <GC_MakeArcOfCircle.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepFilletAPI_MakeChamfer.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepGProp.hxx>
#include <BRepGProp_Face.hxx>
#include <BRepLProp_SLProps.hxx>
#include <BRepLib.hxx>
#include <BRepOffsetAPI_DraftAngle.hxx>
#include <BRepOffsetAPI_MakeOffsetShape.hxx>
#include <BRepOffsetAPI_MakeThickSolid.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepTools.hxx>
#include <BRepTools_History.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <ChFiDS_ErrorStatus.hxx>
#include <GCPnts_AbscissaPoint.hxx>
#include <GProp_GProps.hxx>
#include <ShapeAnalysis_ShapeTolerance.hxx>
#include <ShapeFix_Shape.hxx>
#include <ShapeFix_ShapeTolerance.hxx>
#include <ShapeFix_Solid.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <Standard_Failure.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Iterator.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>
#include <gp_Pln.hxx>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <functional>
#include <limits>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <vector>

namespace rk {

constexpr double kPi = 3.14159265358979323846;

/** What an operation gives back. */
struct Result {
  TopoDS_Shape shape;
  /** Plain English, empty when it worked. */
  std::string error;
  /** Input edges / faces at fault (0-based, TopExp::MapShapes order of the input body). */
  std::vector<int> badEdges, badFaces;
  /** Every step tried, in order, with how it went. */
  std::vector<std::string> steps;
  /** The step that gave the result ("direct" when no retry was needed). */
  std::string strategy;
  /** A value that would work, when there is one (e.g. the largest radius that fits); NaN if none. */
  double hint = std::numeric_limits<double>::quiet_NaN();
  /** Notes worth showing even when it worked (e.g. "healed 2 gaps in the input"). */
  std::vector<std::string> notes;
  bool ok() const { return error.empty() && !shape.IsNull(); }
};

// ---- small helpers -----------------------------------------------------------------

inline int count(const TopoDS_Shape& s, TopAbs_ShapeEnum t) {
  if (s.IsNull()) return 0;
  TopTools_IndexedMapOfShape m;
  TopExp::MapShapes(s, t, m);
  return m.Extent();
}

inline double volume(const TopoDS_Shape& s) {
  if (s.IsNull()) return 0;
  GProp_GProps g;
  BRepGProp::VolumeProperties(s, g, Standard_True);
  return std::fabs(g.Mass());
}

inline double area(const TopoDS_Shape& s) {
  if (s.IsNull()) return 0;
  GProp_GProps g;
  BRepGProp::SurfaceProperties(s, g, Standard_True);
  return std::fabs(g.Mass());
}

inline double diagonal(const TopoDS_Shape& s) {
  Bnd_Box b;
  BRepBndLib::Add(s, b, false);
  if (b.IsVoid()) return 1;
  return std::max(1e-6, b.CornerMin().Distance(b.CornerMax()));
}

inline double maxTolerance(const TopoDS_Shape& s) {
  ShapeAnalysis_ShapeTolerance t;
  return s.IsNull() ? 0 : t.Tolerance(s, 1);
}

inline std::string num(double v) {
  std::ostringstream o;
  o.precision(v != 0 && std::fabs(v) < 0.1 ? 2 : 3);
  if (std::fabs(v) >= 1000) o.precision(6);
  o << v;
  return o.str();
}

inline std::string what(const Standard_Failure& e) {
  const char* m = e.GetMessageString();
  return (m && *m) ? m : e.DynamicType()->Name();
}

/** Runs f, turning OpenCascade exceptions into an empty shape plus a message. */
template <typename F>
TopoDS_Shape attempt(F&& f, std::string& why) {
  try {
    return f();
  } catch (const Standard_Failure& e) {
    why = what(e);
  } catch (const std::exception& e) {
    why = e.what();
  }
  return TopoDS_Shape();
}

/** Indexes of an input body, for naming the edges and faces at fault. */
struct Index {
  TopoDS_Shape body;
  TopTools_IndexedMapOfShape faces, edges, vertices;
  TopTools_IndexedDataMapOfShapeListOfShape edgeFaces, vertexEdges;
  explicit Index(const TopoDS_Shape& s) : body(s) {
    TopExp::MapShapes(s, TopAbs_FACE, faces);
    TopExp::MapShapes(s, TopAbs_EDGE, edges);
    TopExp::MapShapes(s, TopAbs_VERTEX, vertices);
    TopExp::MapShapesAndAncestors(s, TopAbs_EDGE, TopAbs_FACE, edgeFaces);
    TopExp::MapShapesAndAncestors(s, TopAbs_VERTEX, TopAbs_EDGE, vertexEdges);
  }
  int edge(const TopoDS_Shape& e) const { return edges.FindIndex(e) - 1; }
  int face(const TopoDS_Shape& f) const { return faces.FindIndex(f) - 1; }
  /** The (up to two) faces either side of an edge. */
  std::vector<TopoDS_Face> facesOf(const TopoDS_Edge& e) const {
    std::vector<TopoDS_Face> out;
    const int i = edgeFaces.FindIndex(e);
    if (!i) return out;
    for (TopTools_ListIteratorOfListOfShape it(edgeFaces.FindFromIndex(i)); it.More(); it.Next()) {
      const TopoDS_Face f = TopoDS::Face(it.Value());
      if (std::none_of(out.begin(), out.end(), [&](const TopoDS_Face& g) { return g.IsSame(f); })) out.push_back(f);
    }
    return out;
  }
};

inline double edgeLength(const TopoDS_Edge& e) {
  try {
    BRepAdaptor_Curve c(e);
    return GCPnts_AbscissaPoint::Length(c);
  } catch (const Standard_Failure&) {
    return 0;
  }
}

/** "the 40 mm straight edge (edge 12)" */
inline std::string edgeName(const Index& ix, const TopoDS_Edge& e) {
  std::string kind = "curved";
  try {
    BRepAdaptor_Curve c(e);
    if (c.GetType() == GeomAbs_Line) kind = "straight";
    else if (c.GetType() == GeomAbs_Circle) kind = "round";
  } catch (const Standard_Failure&) {
  }
  return "the " + num(edgeLength(e)) + " mm " + kind + " edge (edge " + std::to_string(ix.edge(e) + 1) + ")";
}

inline std::string surfaceKind(const TopoDS_Face& f) {
  switch (BRepAdaptor_Surface(f).GetType()) {
    case GeomAbs_Plane: return "flat";
    case GeomAbs_Cylinder: return "cylindrical";
    case GeomAbs_Cone: return "conical";
    case GeomAbs_Sphere: return "spherical";
    case GeomAbs_Torus: return "toroidal";
    default: return "freeform";
  }
}

/** "the flat face (face 3)" */
inline std::string faceName(const Index& ix, const TopoDS_Face& f) {
  return "the " + surfaceKind(f) + " face (face " + std::to_string(ix.face(f) + 1) + ")";
}

/** Outward normal of a face at its middle. */
inline gp_Dir faceNormal(const TopoDS_Face& f) {
  BRepAdaptor_Surface s(f);
  const double u = (s.FirstUParameter() + s.LastUParameter()) / 2, v = (s.FirstVParameter() + s.LastVParameter()) / 2;
  BRepLProp_SLProps p(s, u, v, 1, 1e-7);
  gp_Dir n = p.IsNormalDefined() ? p.Normal() : gp_Dir(0, 0, 1);
  if (f.Orientation() == TopAbs_REVERSED) n.Reverse();
  return n;
}

/** Are the two faces either side of the edge tangent there (a smooth edge, nothing to round)? */
inline bool isSmooth(const TopoDS_Edge& e, const TopoDS_Face& f1, const TopoDS_Face& f2) {
  if (BRep_Tool::Continuity(e, f1, f2) >= GeomAbs_G1) return true;
  // Sample a few points: normals parallel all along = tangent.
  try {
    BRepAdaptor_Curve c(e);
    for (int k = 1; k <= 3; k++) {
      const double t = c.FirstParameter() + (c.LastParameter() - c.FirstParameter()) * k / 4;
      const gp_Pnt p = c.Value(t);
      gp_Dir n[2];
      const TopoDS_Face fs[2] = {f1, f2};
      for (int i = 0; i < 2; i++) {
        BRepAdaptor_Surface s(fs[i]);
        // Project the point onto the face's surface via the edge's pcurve.
        double a, b;
        Handle(Geom2d_Curve) pc = BRep_Tool::CurveOnSurface(e, fs[i], a, b);
        if (pc.IsNull()) return false;
        const double tt = a + (b - a) * k / 4;
        const gp_Pnt2d uv = pc->Value(tt);
        BRepLProp_SLProps pr(s, uv.X(), uv.Y(), 1, 1e-7);
        if (!pr.IsNormalDefined()) return false;
        n[i] = pr.Normal();
      }
      (void)p;
      if (!n[0].IsParallel(n[1], 1e-3)) return false;
    }
    return true;
  } catch (const Standard_Failure&) {
    return false;
  }
}

// ---- checking and tidying results --------------------------------------------------

/** Every solid in a shape, as a compound (or the solid itself when there is one). */
inline TopoDS_Shape solidsOnly(const TopoDS_Shape& s) {
  std::vector<TopoDS_Shape> list;
  for (TopExp_Explorer ex(s, TopAbs_SOLID); ex.More(); ex.Next()) list.push_back(ex.Current());
  if (list.size() == 1) return list[0];
  TopoDS_Compound c;
  BRep_Builder b;
  b.MakeCompound(c);
  for (auto& x : list) b.Add(c, x);
  return c;
}

/** Valid B-rep? If not, ShapeFix gets one go at it. Returns the shape to keep (null if hopeless). */
inline TopoDS_Shape validOrFixed(const TopoDS_Shape& s, std::string& why, bool& fixed) {
  fixed = false;
  if (s.IsNull()) {
    why = "empty result";
    return s;
  }
  if (BRepCheck_Analyzer(s).IsValid()) return s;
  try {
    ShapeFix_Shape fix(s);
    fix.SetPrecision(1e-7);
    fix.SetMaxTolerance(std::min(1e-2, diagonal(s) * 1e-4));
    fix.Perform();
    TopoDS_Shape r = fix.Shape();
    if (!r.IsNull() && BRepCheck_Analyzer(r).IsValid()) {
      fixed = true;
      return r;
    }
  } catch (const Standard_Failure&) {
  }
  why = "the result isn't a valid solid";
  return TopoDS_Shape();
}

/** What a result must satisfy to be kept. */
struct Expect {
  /** At least this many solids (never lose a body). */
  int minSolids = 1;
  /** Volume window, relative to the inputs; NaN = don't check. */
  double minVolume = std::numeric_limits<double>::quiet_NaN();
  double maxVolume = std::numeric_limits<double>::quiet_NaN();
};

/**
 * The gate every strategy's result goes through. Catches the quiet failures:
 * a result with a solid missing (the "box vanished" bug), a volume that went
 * the wrong way, or broken topology.
 */
inline bool accept(TopoDS_Shape& s, const Expect& ex, std::string& why) {
  if (s.IsNull()) {
    if (why.empty()) why = "no result";
    return false;
  }
  bool fixed = false;
  TopoDS_Shape v = validOrFixed(s, why, fixed);
  if (v.IsNull()) return false;
  s = v;
  const int n = count(s, TopAbs_SOLID);
  if (n < ex.minSolids) {
    why = n == 0 ? "the result has no solid left" : "the result lost " + std::to_string(ex.minSolids - n) + " of the bodies";
    return false;
  }
  if (!std::isnan(ex.minVolume) || !std::isnan(ex.maxVolume)) {
    const double vol = volume(s);
    if (!std::isnan(ex.minVolume) && vol < ex.minVolume) {
      why = "the result is smaller than it can be (" + num(vol) + " mm³)";
      return false;
    }
    if (!std::isnan(ex.maxVolume) && vol > ex.maxVolume) {
      why = "the result is bigger than it can be (" + num(vol) + " mm³)";
      return false;
    }
  }
  return true;
}

/** Merge faces split by the operation, and keep the result's tolerances in check. */
inline TopoDS_Shape tidy(const TopoDS_Shape& s, bool unify = true) {
  TopoDS_Shape r = s;
  if (unify) {
    try {
      ShapeUpgrade_UnifySameDomain u(r, true, true, true);
      u.SetLinearTolerance(1e-6);
      u.Build();
      if (!u.Shape().IsNull() && BRepCheck_Analyzer(u.Shape()).IsValid()) r = u.Shape();
    } catch (const Standard_Failure&) {
    }
  }
  // Tolerance creep: each operation can grow vertex / edge tolerances, and
  // after enough of them the next boolean sees gaps that aren't there. Pull
  // tolerances back to what the geometry really needs.
  try {
    if (maxTolerance(r) > 1e-5) {
      TopoDS_Shape c = r;
      BRepLib::UpdateTolerances(c, Standard_True);
      if (BRepCheck_Analyzer(c).IsValid()) r = c;
    }
  } catch (const Standard_Failure&) {
  }
  return r;
}

/** ShapeFix on an input before a retry. Returns the input unchanged if it's already fine. */
inline TopoDS_Shape heal(const TopoDS_Shape& s, std::vector<std::string>* notes = nullptr) {
  try {
    ShapeFix_Shape fix(s);
    fix.SetPrecision(1e-7);
    fix.SetMaxTolerance(std::min(1e-2, diagonal(s) * 1e-4));
    fix.Perform();
    TopoDS_Shape r = fix.Shape();
    if (r.IsNull()) return s;
    if (notes && !r.IsSame(s)) notes->push_back("repaired the input body first");
    return r;
  } catch (const Standard_Failure&) {
    return s;
  }
}

/**
 * Heal an imported or suspect body: fix it; if it is an open shell (gaps
 * between faces) sew it with a growing tolerance and close it into a solid.
 */
inline TopoDS_Shape healBody(const TopoDS_Shape& s, std::vector<std::string>& notes) {
  if (s.IsNull()) return s;
  const bool hadSolid = count(s, TopAbs_SOLID) > 0;
  if (hadSolid && BRepCheck_Analyzer(s).IsValid()) return s;
  TopoDS_Shape r = heal(s);
  if (hadSolid && BRepCheck_Analyzer(r).IsValid()) {
    notes.push_back("repaired the body's B-rep");
    return r;
  }
  if (count(r, TopAbs_FACE) == 0) return r;
  const double d = diagonal(r);
  for (double tol : {1e-6 * d, 1e-5 * d, 1e-4 * d, 1e-3 * d}) {
    try {
      BRepBuilderAPI_Sewing sew(tol);
      for (TopExp_Explorer ex(r, TopAbs_FACE); ex.More(); ex.Next()) sew.Add(ex.Current());
      sew.Perform();
      TopoDS_Shape sh = sew.SewedShape();
      if (sh.IsNull()) continue;
      int open = 0;
      TopoDS_Compound c;
      BRep_Builder b;
      b.MakeCompound(c);
      int solids = 0;
      for (TopExp_Explorer ex(sh, TopAbs_SHELL); ex.More(); ex.Next()) {
        const TopoDS_Shell shell = TopoDS::Shell(ex.Current());
        if (!BRep_Tool::IsClosed(shell)) {
          open++;
          b.Add(c, shell);
          continue;
        }
        BRepBuilderAPI_MakeSolid ms(shell);
        if (!ms.IsDone()) continue;
        ShapeFix_Solid fs(ms.Solid());
        fs.Perform();
        b.Add(c, fs.Solid());
        solids++;
      }
      if (open == 0 && solids > 0) {
        notes.push_back("closed gaps of up to " + num(tol) + " mm between faces and made it a solid");
        TopoDS_Shape out = solids == 1 ? solidsOnly(c) : TopoDS_Shape(c);
        bool fixed;
        std::string why;
        TopoDS_Shape v = validOrFixed(out, why, fixed);
        if (!v.IsNull()) return v;
      }
    } catch (const Standard_Failure&) {
    }
  }
  if (!hadSolid) notes.push_back("the body has gaps between its faces, so it stays a surface body");
  return r;
}

/** Retry ladder: try each strategy until one gives an accepted result. */
struct Ladder {
  Result& res;
  Expect expect;
  bool tidyUp = true;
  /** Returns true when this step's shape was kept. */
  bool step(const std::string& name, const std::function<TopoDS_Shape(std::string&)>& f) {
    if (res.ok()) return true;
    std::string why;
    const auto t0 = std::chrono::steady_clock::now();
    TopoDS_Shape s;
    try {
      s = f(why);
    } catch (const Standard_Failure& e) {
      why = what(e);
    } catch (const std::exception& e) {
      why = e.what();
    }
    if (!s.IsNull() && tidyUp) s = tidy(s);
    const bool good = accept(s, expect, why);
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    res.steps.push_back(name + (good ? ": ok" : ": " + (why.empty() ? std::string("failed") : why)) + " (" + num(ms) + " ms)");
    if (good) {
      res.shape = s;
      res.strategy = name;
    }
    return good;
  }
};

/** Finish a result that no strategy rescued. */
inline Result& fail(Result& r, const std::string& msg) {
  r.shape.Nullify();
  r.error = msg;
  return r;
}

// ---- booleans ---------------------------------------------------------------------

enum class Bool { Fuse, Cut, Common };

inline TopoDS_Shape runBool(Bool op, const TopoDS_Shape& a, const std::vector<TopoDS_Shape>& tools, double fuzzy,
                            BOPAlgo_GlueEnum glue, std::string& why) {
  TopTools_ListOfShape args, tl;
  args.Append(a);
  for (auto& t : tools) tl.Append(t);
  std::unique_ptr<BRepAlgoAPI_BooleanOperation> b;
  if (op == Bool::Fuse) b.reset(new BRepAlgoAPI_Fuse());
  else if (op == Bool::Cut) b.reset(new BRepAlgoAPI_Cut());
  else b.reset(new BRepAlgoAPI_Common());
  b->SetArguments(args);
  b->SetTools(tl);
  b->SetNonDestructive(Standard_True);
  b->SetUseOBB(Standard_True);
  b->SetCheckInverted(Standard_True);
  if (fuzzy > 0) b->SetFuzzyValue(fuzzy);
  if (glue != BOPAlgo_GlueOff) b->SetGlue(glue);
  b->Build();
  if (!b->IsDone() || b->HasErrors()) {
    std::ostringstream o;
    b->DumpErrors(o);
    why = o.str().empty() ? "not done" : o.str();
    while (!why.empty() && (why.back() == '\n' || why.back() == ' ')) why.pop_back();
    return TopoDS_Shape();
  }
  return b->Shape();
}

/**
 * Add / cut / intersect. `a` is the target. Retries with fuzzy tolerances
 * (near-coincident faces), with the inputs healed, and with gluing for faces
 * that lie exactly on each other. Volume bounds catch results that quietly
 * dropped a body.
 */
inline Result boolean(Bool op, const TopoDS_Shape& a, const std::vector<TopoDS_Shape>& tools) {
  Result r;
  if (a.IsNull() || tools.empty()) return fail(r, "Pick the bodies to combine");
  const double va = volume(a);
  double vt = 0, vtMax = 0;
  for (auto& t : tools) {
    const double v = volume(t);
    vt += v;
    vtMax = std::max(vtMax, v);
  }
  const double slack = 1e-6 * std::max(1.0, va + vt) + 1e-3;
  Ladder L{r};
  if (op == Bool::Fuse) {
    L.expect.minSolids = 1;
    L.expect.minVolume = std::max(va, vtMax) * (1 - 1e-6) - slack;
    L.expect.maxVolume = (va + vt) * (1 + 1e-6) + slack;
  } else if (op == Bool::Cut) {
    L.expect.minSolids = 1;
    L.expect.maxVolume = va * (1 + 1e-6) + slack;
  } else {
    L.expect.minSolids = 1;
    L.expect.maxVolume = std::min(va, vtMax > 0 ? vtMax : va) * (1 + 1e-6) + slack;
  }
  const double d = diagonal(a);
  bool emptied = false;
  L.step("direct", [&](std::string& why) {
    TopoDS_Shape s = runBool(op, a, tools, 0, BOPAlgo_GlueOff, why);
    emptied = !s.IsNull() && count(s, TopAbs_SOLID) == 0;
    return s;
  });
  // Nothing left is a real answer for cut / intersect, not a failure to retry.
  if (emptied && op != Bool::Fuse)
    return fail(r, op == Bool::Cut ? "The cut removes the whole body" : "The bodies don't overlap");
  // Near-coincident faces: let the boolean treat close-enough as touching.
  for (double fz : {1e-6 * d, 1e-5 * d, 1e-4 * d})
    L.step("fuzzy " + num(fz) + " mm", [&](std::string& why) { return runBool(op, a, tools, fz, BOPAlgo_GlueOff, why); });
  // Bad input: heal both sides and try again.
  if (!r.ok()) {
    std::vector<std::string> notes;
    TopoDS_Shape ha = heal(a, &notes);
    std::vector<TopoDS_Shape> ht;
    for (auto& t : tools) ht.push_back(heal(t, &notes));
    L.step("healed inputs", [&](std::string& why) { return runBool(op, ha, ht, 0, BOPAlgo_GlueOff, why); });
    L.step("healed inputs, fuzzy", [&](std::string& why) { return runBool(op, ha, ht, 1e-5 * d, BOPAlgo_GlueOff, why); });
    // Faces lying exactly on each other (stacked blocks, flush cuts).
    L.step("glued faces", [&](std::string& why) { return runBool(op, ha, ht, 1e-6 * d, BOPAlgo_GlueShift, why); });
  }
  // A tool that misses the target: "cut" leaves the target, "fuse" gives two solids.
  if (r.ok()) {
    if (r.strategy != "direct") r.notes.push_back("needed: " + r.strategy);
    return r;
  }
  // Say what's wrong with the inputs, if the checker can tell.
  try {
    BRepAlgoAPI_Check chk(a, tools[0], op == Bool::Fuse ? BOPAlgo_FUSE : op == Bool::Cut ? BOPAlgo_CUT : BOPAlgo_COMMON);
    if (!chk.IsValid()) {
      Index ix(a);
      for (BOPAlgo_ListIteratorOfListOfCheckResult it(chk.Result()); it.More(); it.Next())
        for (TopTools_ListIteratorOfListOfShape f(it.Value().GetFaultyShapes1()); f.More(); f.Next()) {
          const int fi = ix.face(f.Value()), ei = ix.edge(f.Value());
          if (fi >= 0) r.badFaces.push_back(fi);
          if (ei >= 0) r.badEdges.push_back(ei);
        }
      if (!r.badFaces.empty() || !r.badEdges.empty())
        return fail(r, "The target body has faults the boolean can't get past (shown in red). Try Heal body on it first.");
    }
  } catch (const Standard_Failure&) {
  }
  const std::string verb = op == Bool::Fuse ? "The bodies couldn't be added together" : op == Bool::Cut ? "The cut couldn't be made" : "The intersection couldn't be made";
  return fail(r, verb + ", even with looser tolerances.");
}

// ---- fillets and chamfers ------------------------------------------------------------

/** One edge of a fillet / chamfer: index in the body, and its size(s). */
struct EdgeSize {
  int edge;
  double r1, r2;  // radius (fillet) or distance (chamfer); r2 != r1 = variable / two distances
  double angle = 0;  // chamfer distance-angle (degrees), 0 = off
};

enum class Blend { Fillet, Chamfer };

/** Edges the user picked, checked: real, not smooth, not seams. Fills r.error / badEdges on a problem. */
inline bool checkEdges(const Index& ix, const std::vector<EdgeSize>& list, Result& r) {
  if (list.empty()) {
    fail(r, "Pick the edges to round");
    return false;
  }
  for (auto& es : list) {
    if (es.edge < 0 || es.edge >= ix.edges.Extent()) {
      fail(r, "That edge no longer matches its body");
      return false;
    }
    if (!(es.r1 > 0) || !(es.r2 > 0)) {
      r.badEdges.push_back(es.edge);
      fail(r, "The size must be more than zero");
      return false;
    }
    const TopoDS_Edge e = TopoDS::Edge(ix.edges.FindKey(es.edge + 1));
    if (BRep_Tool::Degenerated(e)) {
      r.badEdges.push_back(es.edge);
      fail(r, "Edge " + std::to_string(es.edge + 1) + " is a collapsed point, not a real edge");
      return false;
    }
    auto fs = ix.facesOf(e);
    if (!fs.empty() && BRep_Tool::IsClosed(e, fs[0])) {
      r.badEdges.push_back(es.edge);
      fail(r, edgeName(ix, e) + " is a seam where a face closes on itself, not a corner");
      return false;
    }
    if (fs.size() < 2) {
      r.badEdges.push_back(es.edge);
      fail(r, edgeName(ix, e) + " is on the open boundary of a surface: there is no corner to round");
      return false;
    }
    if (false) {
      r.badEdges.push_back(es.edge);
      fail(r, edgeName(ix, e) + " is a seam where a face closes on itself, not a corner");
      return false;
    }
    if (isSmooth(e, fs[0], fs[1])) {
      r.badEdges.push_back(es.edge);
      fail(r, edgeName(ix, e) + " is already smooth (its faces meet tangentially), so there's nothing to round");
      return false;
    }
  }
  return true;
}

/**
 * Size the faces next to an edge allow: a constant-radius fillet on a
 * straight edge between two planes eats a strip of width r / tan(a/2) out of
 * each face, which can't exceed that face's width across the edge. Cheap
 * early warning for the commonest "radius too big" case.
 */
inline double planarLimit(const Index& ix, const TopoDS_Edge& e, Blend kind) {
  auto fs = ix.facesOf(e);
  if (fs.size() != 2) return 0;
  BRepAdaptor_Curve c(e);
  if (c.GetType() != GeomAbs_Line) return 0;
  BRepAdaptor_Surface s1(fs[0]), s2(fs[1]);
  if (s1.GetType() != GeomAbs_Plane || s2.GetType() != GeomAbs_Plane) return 0;
  const gp_Dir n1 = faceNormal(fs[0]), n2 = faceNormal(fs[1]);
  const double ang = n1.Angle(n2);  // 0 = flat, pi/2 = square corner
  if (ang < 1e-3) return 0;
  // Convex or concave? Concave corners have no width limit from these faces.
  const gp_Pnt mid = c.Value((c.FirstParameter() + c.LastParameter()) / 2);
  const gp_Dir dir = c.Line().Direction();
  double limit = std::numeric_limits<double>::infinity();
  for (int i = 0; i < 2; i++) {
    const gp_Dir n = i ? n2 : n1;
    // In-face direction pointing away from the edge.
    gp_Vec into = gp_Vec(n).Crossed(gp_Vec(dir));
    const TopoDS_Face other = fs[1 - i];
    // Point "into" towards the face's interior: check against the other face's normal.
    if (into.Dot(gp_Vec(i ? n1 : n2)) > 0) into.Reverse();
    // Width of the face across the edge: furthest vertex along `into`.
    double w = 0;
    for (TopExp_Explorer ex(fs[i], TopAbs_VERTEX); ex.More(); ex.Next())
      w = std::max(w, gp_Vec(mid, BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()))).Dot(into));
    (void)other;
    if (w <= 0) return 0;
    limit = std::min(limit, w);
  }
  // Strip width per unit radius.
  const double per = kind == Blend::Fillet ? std::tan(ang / 2) : 1.0;
  return per > 1e-9 ? limit / per : 0;
}

inline TopoDS_Shape runBlend(Blend kind, const TopoDS_Shape& body, const Index& ix, const std::vector<EdgeSize>& list,
                             ChFi3d_FilletShape shape, std::string& why, std::vector<int>* badEdges = nullptr,
                             const std::function<TopoDS_Edge(int)>& edgeOf = {}) {
  auto E = [&](int i) { return edgeOf ? edgeOf(i) : TopoDS::Edge(ix.edges.FindKey(i + 1)); };
  if (kind == Blend::Fillet) {
    BRepFilletAPI_MakeFillet mf(body, shape);
    for (auto& es : list) {
      TopoDS_Edge e = E(es.edge);
      if (e.IsNull()) continue;
      if (std::fabs(es.r1 - es.r2) < 1e-9) mf.Add(es.r1, e);
      else mf.Add(es.r1, es.r2, e);
    }
    mf.Build();
    if (!mf.IsDone()) {
      why = "the fillet surfaces couldn't be built";
      if (badEdges) {
        for (int c = 1; c <= mf.NbFaultyContours(); c++) {
          const int ic = mf.FaultyContour(c);
          for (int j = 1; j <= mf.NbEdges(ic); j++) {
            const int k = ix.edge(mf.Edge(ic, j));
            if (k >= 0) badEdges->push_back(k);
          }
        }
        for (int v = 1; v <= mf.NbFaultyVertices(); v++) {
          const TopoDS_Vertex vx = mf.FaultyVertex(v);
          const int at = ix.vertexEdges.FindIndex(vx);
          if (!at) continue;
          for (TopTools_ListIteratorOfListOfShape it(ix.vertexEdges.FindFromIndex(at)); it.More(); it.Next()) {
            const int k = ix.edge(it.Value());
            if (k >= 0 && std::any_of(list.begin(), list.end(), [&](const EdgeSize& s) { return s.edge == k; })) badEdges->push_back(k);
          }
        }
      }
      return TopoDS_Shape();
    }
    return mf.Shape();
  }
  BRepFilletAPI_MakeChamfer mc(body);
  for (auto& es : list) {
    TopoDS_Edge e = E(es.edge);
    if (e.IsNull()) continue;
    auto fs = ix.facesOf(TopoDS::Edge(ix.edges.FindKey(es.edge + 1)));
    if (es.angle > 0 && !fs.empty()) mc.AddDA(es.r1, es.angle * kPi / 180, e, fs[0]);
    else if (std::fabs(es.r1 - es.r2) > 1e-9 && !fs.empty()) mc.Add(es.r1, es.r2, e, fs[0]);
    else mc.Add(es.r1, e);
  }
  mc.Build();
  if (!mc.IsDone()) {
    why = "the chamfer faces couldn't be built";
    return TopoDS_Shape();
  }
  return mc.Shape();
}

/**
 * Edges one by one, each run on the result of the last (finding each edge
 * again through the previous step's history). Works where the all-at-once
 * blend fails at a vertex where several meet, at the cost of corner shape.
 */
inline TopoDS_Shape sequentialBlend(Blend kind, const TopoDS_Shape& body, const Index& ix, std::vector<EdgeSize> list,
                                    bool bigFirst, std::string& why) {
  std::stable_sort(list.begin(), list.end(), [&](const EdgeSize& a, const EdgeSize& b) { return bigFirst ? a.r1 > b.r1 : a.r1 < b.r1; });
  TopoDS_Shape cur = body;
  // Where each original edge is now.
  std::vector<TopoDS_Shape> now(ix.edges.Extent());
  for (int i = 0; i < ix.edges.Extent(); i++) now[i] = ix.edges.FindKey(i + 1);
  for (size_t k = 0; k < list.size(); k++) {
    TopoDS_Shape e = now[list[k].edge];
    if (e.IsNull()) continue;  // swallowed by an earlier blend
    Index cix(cur);
    if (cix.edge(e) < 0) {
      // Rebuilt as a new edge with the same geometry: find it by its ends and middle.
      const TopoDS_Edge old = TopoDS::Edge(e);
      BRepAdaptor_Curve oc(old);
      const gp_Pnt a = oc.Value(oc.FirstParameter()), b = oc.Value(oc.LastParameter()), m = oc.Value((oc.FirstParameter() + oc.LastParameter()) / 2);
      TopoDS_Shape found;
      for (int i = 1; i <= cix.edges.Extent() && found.IsNull(); i++) {
        const TopoDS_Edge ce = TopoDS::Edge(cix.edges.FindKey(i));
        if (BRep_Tool::Degenerated(ce)) continue;
        BRepAdaptor_Curve cc(ce);
        const gp_Pnt ca = cc.Value(cc.FirstParameter()), cb = cc.Value(cc.LastParameter()), cm = cc.Value((cc.FirstParameter() + cc.LastParameter()) / 2);
        const double tol = 1e-5;
        if (((ca.Distance(a) < tol && cb.Distance(b) < tol) || (ca.Distance(b) < tol && cb.Distance(a) < tol)) && cm.Distance(m) < tol) found = ce;
      }
      if (found.IsNull()) {
        why = "lost track of edge " + std::to_string(list[k].edge + 1) + " after rounding the one before";
        return TopoDS_Shape();
      }
      e = found;
    }
    std::vector<EdgeSize> one{list[k]};
    one[0].edge = cix.edge(e);
    std::unique_ptr<BRepBuilderAPI_MakeShape> mk;
    TopoDS_Shape next;
    if (kind == Blend::Fillet) {
      auto* mf = new BRepFilletAPI_MakeFillet(cur);
      mk.reset(mf);
      if (std::fabs(one[0].r1 - one[0].r2) < 1e-9) mf->Add(one[0].r1, TopoDS::Edge(e));
      else mf->Add(one[0].r1, one[0].r2, TopoDS::Edge(e));
      mf->Build();
      if (!mf->IsDone()) {
        why = "edge " + std::to_string(list[k].edge + 1) + " failed on its own";
        return TopoDS_Shape();
      }
      next = mf->Shape();
    } else {
      auto* mc = new BRepFilletAPI_MakeChamfer(cur);
      mk.reset(mc);
      auto fs = cix.facesOf(TopoDS::Edge(e));
      if (one[0].angle > 0 && !fs.empty()) mc->AddDA(one[0].r1, one[0].angle * kPi / 180, TopoDS::Edge(e), fs[0]);
      else if (std::fabs(one[0].r1 - one[0].r2) > 1e-9 && !fs.empty()) mc->Add(one[0].r1, one[0].r2, TopoDS::Edge(e), fs[0]);
      else mc->Add(one[0].r1, TopoDS::Edge(e));
      mc->Build();
      if (!mc->IsDone()) {
        why = "edge " + std::to_string(list[k].edge + 1) + " failed on its own";
        return TopoDS_Shape();
      }
      next = mc->Shape();
    }
    // Follow every remaining edge through this step.
    for (size_t j = k + 1; j < list.size(); j++) {
      TopoDS_Shape& w = now[list[j].edge];
      if (w.IsNull()) continue;
      // (IsDeleted isn't trusted: rebuilt edges show as deleted. The lookup above finds them.)
      if (mk->IsDeleted(w)) continue;
      const TopTools_ListOfShape& mod = mk->Modified(w);
      if (!mod.IsEmpty()) {
        // Trimmed by the neighbouring blend: the longest piece carries on.
        TopoDS_Shape best;
        double bl = -1;
        for (TopTools_ListIteratorOfListOfShape it(mod); it.More(); it.Next())
          if (it.Value().ShapeType() == TopAbs_EDGE) {
            const double l = edgeLength(TopoDS::Edge(it.Value()));
            if (l > bl) bl = l, best = it.Value();
          }
        w = best;
      }
    }
    cur = next;
  }
  return cur;
}

/** Largest size (below `hi`) that a single edge set takes, by bisection; NaN if even small sizes fail. */
inline double largestThatFits(Blend kind, const TopoDS_Shape& body, const Index& ix, std::vector<EdgeSize> list, double hi, double budgetMs) {
  const auto t0 = std::chrono::steady_clock::now();
  auto works = [&](double scale) {
    std::vector<EdgeSize> l = list;
    for (auto& e : l) e.r1 *= scale, e.r2 *= scale;
    std::string why;
    TopoDS_Shape s = attempt([&] { return runBlend(kind, body, ix, l, ChFi3d_Rational, why); }, why);
    return !s.IsNull() && BRepCheck_Analyzer(s).IsValid() && count(s, TopAbs_SOLID) >= 1;
  };
  double lo = 0, top = 1;
  if (!works(0.02)) return std::numeric_limits<double>::quiet_NaN();
  lo = 0.02;
  for (int i = 0; i < 9; i++) {
    if (std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count() > budgetMs) break;
    const double mid = (lo + top) / 2;
    if (works(mid)) lo = mid;
    else top = mid;
  }
  return std::floor(hi * lo * 0.98 * 100) / 100;  // a little under, rounded down to 0.01
}

/**
 * Straight edges between two flat faces, done as a boolean: a prism of the
 * corner's cross-section (square corner minus the quarter round, or the
 * chamfer triangle) cut away (convex) or added (concave). Works where the
 * blend algorithm gives up, notably when the fillet eats a whole face (a
 * fillet as tall as the wall, or a full round across a rib). Only for edges
 * that end on faces square to them, and that don't share a vertex with
 * another picked edge (corners where blends meet need the real algorithm).
 */
inline TopoDS_Shape profileBlend(Blend kind, const TopoDS_Shape& body, const Index& ix, const std::vector<EdgeSize>& list, std::string& why) {
  std::vector<TopoDS_Shape> cuts, adds;
  std::set<int> usedVertices;
  for (auto& es : list) {
    if (std::fabs(es.r1 - es.r2) > 1e-9 && kind == Blend::Fillet) return why = "variable radius", TopoDS_Shape();
    if (es.angle > 0) return why = "distance-angle chamfer", TopoDS_Shape();
    const TopoDS_Edge e = TopoDS::Edge(ix.edges.FindKey(es.edge + 1));
    BRepAdaptor_Curve c(e);
    if (c.GetType() != GeomAbs_Line) return why = "not a straight edge", TopoDS_Shape();
    auto fs = ix.facesOf(e);
    if (fs.size() != 2 || BRepAdaptor_Surface(fs[0]).GetType() != GeomAbs_Plane || BRepAdaptor_Surface(fs[1]).GetType() != GeomAbs_Plane)
      return why = "not between two flat faces", TopoDS_Shape();
    TopoDS_Vertex v0, v1;
    TopExp::Vertices(e, v0, v1);
    for (const TopoDS_Vertex& v : {v0, v1}) {
      const int vi = ix.vertices.FindIndex(v);
      if (!usedVertices.insert(vi).second) return why = "edges meet at a corner", TopoDS_Shape();
    }
    const gp_Pnt p0 = BRep_Tool::Pnt(v0), p1 = BRep_Tool::Pnt(v1);
    const double len = p0.Distance(p1);
    if (len < 1e-6) return why = "edge too short", TopoDS_Shape();
    const gp_Dir d(gp_Vec(p0, p1));
    // Both ends must stop on a face square to the edge, so the prism ends flush.
    for (const TopoDS_Vertex& v : {v0, v1}) {
      bool square = false;
      const int at = ix.vertexEdges.FindIndex(v);
      if (!at) return why = "open end", TopoDS_Shape();
      for (TopTools_ListIteratorOfListOfShape it(ix.vertexEdges.FindFromIndex(at)); it.More() && !square; it.Next())
        for (auto& f : ix.facesOf(TopoDS::Edge(it.Value())))
          if (!f.IsSame(fs[0]) && !f.IsSame(fs[1]) && BRepAdaptor_Surface(f).GetType() == GeomAbs_Plane && faceNormal(f).IsParallel(d, 1e-6)) square = true;
      if (!square) return why = "edge doesn't end on a square face", TopoDS_Shape();
    }
    const gp_Dir n1 = faceNormal(fs[0]), n2 = faceNormal(fs[1]);
    // In-face directions, away from the edge into each face.
    auto into = [&](const TopoDS_Face& f, const gp_Dir& n) {
      gp_Vec u = gp_Vec(n).Crossed(gp_Vec(d));
      GProp_GProps g;
      BRepGProp::SurfaceProperties(f, g);
      if (gp_Vec(p0, g.CentreOfMass()).Dot(u) < 0) u.Reverse();
      return gp_Dir(u);
    };
    const gp_Dir u1 = into(fs[0], n1), u2 = into(fs[1], n2);
    const bool convex = gp_Vec(u1).Dot(gp_Vec(n2)) < 0;
    const double sgn = convex ? -1 : 1;
    std::vector<TopoDS_Edge> prof;
    if (kind == Blend::Fillet) {
      const double r = es.r1;
      // Centre r from both planes, on the material side (convex) or the air side (concave).
      // In the cross-section plane: c = p0 + a u1 + b u2 with (c-p0).n1 = sgn r, (c-p0).n2 = sgn r.
      const double a11 = gp_Vec(u1).Dot(gp_Vec(n1)), a12 = gp_Vec(u2).Dot(gp_Vec(n1));
      const double a21 = gp_Vec(u1).Dot(gp_Vec(n2)), a22 = gp_Vec(u2).Dot(gp_Vec(n2));
      const double det = a11 * a22 - a12 * a21;
      if (std::fabs(det) < 1e-9) return why = "faces nearly flat to each other", TopoDS_Shape();
      const double A = (sgn * r * a22 - a12 * sgn * r) / det, B = (a11 * sgn * r - sgn * r * a21) / det;
      const gp_Pnt cc = p0.Translated(gp_Vec(u1) * A + gp_Vec(u2) * B);
      const gp_Pnt t1 = cc.Translated(gp_Vec(n1) * (-sgn * r)), t2 = cc.Translated(gp_Vec(n2) * (-sgn * r));
      const gp_Pnt mid = cc.Translated(gp_Vec(gp_Dir(gp_Vec(cc, p0))) * r);
      GC_MakeArcOfCircle arc(t1, mid, t2);
      if (!arc.IsDone()) return why = "corner arc", TopoDS_Shape();
      prof = {BRepBuilderAPI_MakeEdge(p0, t1).Edge(), BRepBuilderAPI_MakeEdge(arc.Value()).Edge(), BRepBuilderAPI_MakeEdge(t2, p0).Edge()};
    } else {
      const gp_Pnt a = p0.Translated(gp_Vec(u1) * es.r1), b = p0.Translated(gp_Vec(u2) * es.r2);
      prof = {BRepBuilderAPI_MakeEdge(p0, a).Edge(), BRepBuilderAPI_MakeEdge(a, b).Edge(), BRepBuilderAPI_MakeEdge(b, p0).Edge()};
    }
    BRepBuilderAPI_MakeWire mw;
    for (auto& pe : prof) mw.Add(pe);
    if (!mw.IsDone()) return why = "profile", TopoDS_Shape();
    BRepBuilderAPI_MakeFace mf(mw.Wire(), Standard_True);
    if (!mf.IsDone()) return why = "profile face", TopoDS_Shape();
    TopoDS_Shape tool = BRepPrimAPI_MakePrism(mf.Face(), gp_Vec(d) * len).Shape();
    (convex ? cuts : adds).push_back(tool);
  }
  // Tools that overlap mean the blends would run into each other: not a valid result.
  std::vector<TopoDS_Shape> all(cuts);
  all.insert(all.end(), adds.begin(), adds.end());
  if (all.size() > 1 && all.size() <= 40)
    for (size_t i = 0; i < all.size(); i++)
      for (size_t j = i + 1; j < all.size(); j++) {
        Bnd_Box bi, bj;
        BRepBndLib::Add(all[i], bi);
        BRepBndLib::Add(all[j], bj);
        if (bi.IsOut(bj)) continue;
        BRepAlgoAPI_Common cm(all[i], all[j]);
        if (cm.IsDone() && volume(cm.Shape()) > 1e-6) return why = "the blends would overlap", TopoDS_Shape();
      }
  else if (all.size() > 40)
    return why = "too many edges for this method", TopoDS_Shape();
  TopoDS_Shape cur = body;
  if (!cuts.empty()) cur = runBool(Bool::Cut, cur, cuts, 0, BOPAlgo_GlueOff, why);
  if (!cur.IsNull() && !adds.empty()) cur = runBool(Bool::Fuse, cur, adds, 0, BOPAlgo_GlueOff, why);
  return cur;
}

/**
 * Fillet (rolling ball, constant or linearly varying along each edge; tangent
 * chains are followed automatically) or chamfer (equal, two distances, or
 * distance + angle) on edges of a solid.
 */
inline Result blend(Blend kind, const TopoDS_Shape& body, const std::vector<EdgeSize>& list) {
  Result r;
  Index ix(body);
  if (!checkEdges(ix, list, r)) return r;
  const char* noun = kind == Blend::Fillet ? "fillet" : "chamfer";
  const char* size = kind == Blend::Fillet ? "radius" : "distance";

  // Pre-check the cheap, common impossible case: bigger than the faces it sits on.
  for (auto& es : list) {
    const TopoDS_Edge e = TopoDS::Edge(ix.edges.FindKey(es.edge + 1));
    const double lim = planarLimit(ix, e, kind);
    const double want = std::max(es.r1, es.r2);
    if (lim > 0 && want > lim * (1 + 1e-6)) {
      r.badEdges.push_back(es.edge);
      r.hint = std::floor(lim * 0.999 * 100) / 100;
      // Exactly the face width (a full round) is the one place OCCT fails but
      // the shape exists; say so rather than "too big".
      return fail(r, "A " + num(want) + " mm " + noun + " won't fit on " + edgeName(ix, e) + ": the faces beside it only leave room for " + num(r.hint) + " mm.");
    }
  }

  const int solids = count(body, TopAbs_SOLID);
  const double v0 = volume(body);
  Ladder L{r};
  L.expect.minSolids = std::max(1, solids);
  // Rounding convex edges removes material, concave ones add it; either way the
  // change is small next to the body.
  L.expect.minVolume = v0 * 0.2;
  L.expect.maxVolume = v0 * 1.8 + 1e-6;
  std::vector<int> faulty;
  L.step("direct", [&](std::string& why) { return runBlend(kind, body, ix, list, ChFi3d_Rational, why, &faulty); });
  if (kind == Blend::Fillet)
    L.step("polynomial blend surface", [&](std::string& why) { return runBlend(kind, body, ix, list, ChFi3d_Polynomial, why); });
  // Slightly bad input B-rep (tolerances, small gaps) makes blends fail.
  if (!r.ok()) {
    TopoDS_Shape h = heal(body);
    if (!h.IsSame(body)) {
      Index hix(h);
      if (hix.edges.Extent() == ix.edges.Extent())
        L.step("healed input", [&](std::string& why) { return runBlend(kind, h, hix, list, ChFi3d_Rational, why); });
    }
  }
  // Flat-faced straight edges: the corner shape as a boolean (copes when a face is used up).
  if (!r.ok()) L.step("corner profile as a boolean", [&](std::string& why) { return profileBlend(kind, body, ix, list, why); });
  // Several edges meeting at a vertex: one at a time, biggest first, then smallest first.
  if (!r.ok() && list.size() > 1) {
    L.step("one edge at a time, biggest first", [&](std::string& why) { return sequentialBlend(kind, body, ix, list, true, why); });
    L.step("one edge at a time, smallest first", [&](std::string& why) { return sequentialBlend(kind, body, ix, list, false, why); });
  }
  if (r.ok()) {
    if (r.strategy != "direct") r.notes.push_back("needed: " + r.strategy);
    return r;
  }

  // Failed: find which edges, and the biggest size that works there.
  std::sort(faulty.begin(), faulty.end());
  faulty.erase(std::unique(faulty.begin(), faulty.end()), faulty.end());
  if (faulty.empty() && list.size() > 1) {
    // OCCT didn't say: try each picked edge alone.
    for (auto& es : list) {
      std::string why;
      TopoDS_Shape s = attempt([&] { return runBlend(kind, body, ix, {es}, ChFi3d_Rational, why); }, why);
      if (s.IsNull() || !BRepCheck_Analyzer(s).IsValid()) faulty.push_back(es.edge);
    }
  }
  if (faulty.empty()) for (auto& es : list) faulty.push_back(es.edge);
  r.badEdges = faulty;
  std::vector<EdgeSize> bad;
  for (auto& es : list)
    if (std::find(faulty.begin(), faulty.end(), es.edge) != faulty.end()) bad.push_back(es);
  double want = 0;
  for (auto& es : list) want = std::max(want, std::max(es.r1, es.r2));
  // Scale the whole set (neighbouring blends limit each other).
  r.hint = largestThatFits(kind, body, ix, list, want, 1500);
  const TopoDS_Edge first = TopoDS::Edge(ix.edges.FindKey(faulty[0] + 1));
  std::string where = faulty.size() == 1 ? edgeName(ix, first) : std::to_string(faulty.size()) + " edges (shown red)";
  std::string msg = "The " + std::string(noun) + " fails on " + where + ".";
  if (!std::isnan(r.hint) && r.hint > 0 && r.hint < want)
    msg += " The largest " + std::string(size) + " that fits there is about " + num(r.hint) + " mm.";
  else if (std::isnan(r.hint))
    msg += " Even a small " + std::string(size) + " fails there: the faces meet in a way the " + noun + " can't follow (try rounding the neighbouring edges first, or fewer edges at once).";
  else
    msg += " Try rounding the neighbouring edges first, or fewer edges at once.";
  return fail(r, msg);
}

// ---- shell -------------------------------------------------------------------------

/**
 * Smallest radius of curvature over a face's convex (outward) side, sampled.
 * An inward shell thicker than this folds the inner wall over itself.
 */
inline double roundRadius(const TopoDS_Face& f, bool convex);
inline double convexRadius(const TopoDS_Face& f) { return roundRadius(f, true); }
inline double concaveRadius(const TopoDS_Face& f) { return roundRadius(f, false); }

inline double roundRadius(const TopoDS_Face& f, bool convex) {
  BRepAdaptor_Surface s(f);
  switch (s.GetType()) {
    case GeomAbs_Plane: return std::numeric_limits<double>::infinity();
    default: break;
  }
  double best = std::numeric_limits<double>::infinity();
  const double u0 = s.FirstUParameter(), u1 = s.LastUParameter(), v0 = s.FirstVParameter(), v1 = s.LastVParameter();
  if (!std::isfinite(u0) || !std::isfinite(u1) || !std::isfinite(v0) || !std::isfinite(v1)) return best;
  const bool rev = f.Orientation() == TopAbs_REVERSED;
  for (int i = 0; i <= 4; i++)
    for (int j = 0; j <= 4; j++) {
      BRepLProp_SLProps p(s, u0 + (u1 - u0) * i / 4, v0 + (v1 - v0) * j / 4, 2, 1e-7);
      if (!p.IsCurvatureDefined()) continue;
      // OCCT curvature is signed against the surface normal; flip with the face.
      for (double k : {p.MaxCurvature(), p.MinCurvature()}) {
        const double kk = rev ? -k : k;
        // Convex outward = curving away from the outward normal = negative here.
        if (convex && kk < -1e-9) best = std::min(best, 1 / -kk);
        if (!convex && kk > 1e-9) best = std::min(best, 1 / kk);
      }
    }
  return best;
}

/** Inward shell by offsetting the whole body and cutting it out, then opening the removed faces. */
inline TopoDS_Shape shellByCut(const TopoDS_Shape& body, const std::vector<TopoDS_Face>& open, double t, std::string& why) {
  BRepOffset_MakeOffset mo;
  mo.Initialize(body, -t, 1e-4, BRepOffset_Skin, Standard_False, Standard_False, GeomAbs_Intersection, Standard_False);
  // Removed faces pushed out instead of in, so the inner body breaks through there.
  for (auto& f : open) mo.SetOffsetOnFace(f, t);
  mo.MakeOffsetShape();
  if (!mo.IsDone()) {
    why = "inner offset failed";
    return TopoDS_Shape();
  }
  TopoDS_Shape inner = mo.Shape();
  if (count(inner, TopAbs_SOLID) == 0) {
    try {
      BRepBuilderAPI_MakeSolid ms;
      for (TopExp_Explorer ex(inner, TopAbs_SHELL); ex.More(); ex.Next()) ms.Add(TopoDS::Shell(ex.Current()));
      inner = ms.Solid();
    } catch (const Standard_Failure&) {
      why = "inner offset isn't closed";
      return TopoDS_Shape();
    }
  }
  return runBool(Bool::Cut, body, {inner}, 0, BOPAlgo_GlueOff, why);
}

/**
 * Inward shell of a body whose convex rounds are tighter than the wall: the
 * inside of a wall t over a round of radius r < t is the same as over the
 * sharp corner, so take the rounds off (defeaturing extends the neighbours
 * back to a sharp corner), offset that inwards, and cut it out of the
 * original. This is the classic case OpenCascade's thick solid gets wrong.
 */
inline TopoDS_Shape shellByDefeature(const TopoDS_Shape& body, const Index& ix, const std::vector<TopoDS_Face>& open, double t, std::string& why) {
  TopTools_ListOfShape remove;
  for (int i = 1; i <= ix.faces.Extent(); i++) {
    const TopoDS_Face f = TopoDS::Face(ix.faces.FindKey(i));
    if (std::any_of(open.begin(), open.end(), [&](const TopoDS_Face& g) { return g.IsSame(f); })) continue;
    if (convexRadius(f) < t * (1 - 1e-6)) remove.Append(f);
  }
  if (remove.IsEmpty()) return why = "no tight rounds", TopoDS_Shape();
  BRepAlgoAPI_Defeaturing df;
  df.SetShape(body);
  df.AddFacesToRemove(remove);
  df.SetToFillHistory(Standard_True);
  df.Build();
  if (!df.IsDone() || df.HasErrors()) return why = "the rounds couldn't be taken off", TopoDS_Shape();
  const TopoDS_Shape sharp = df.Shape();
  std::vector<TopoDS_Face> sopen;
  for (auto& f : open) {
    if (df.IsDeleted(f)) return why = "an open face was lost", TopoDS_Shape();
    const TopTools_ListOfShape& m = df.Modified(f);
    if (m.IsEmpty()) sopen.push_back(f);
    else
      for (TopTools_ListIteratorOfListOfShape it(m); it.More(); it.Next()) sopen.push_back(TopoDS::Face(it.Value()));
  }
  BRepOffset_MakeOffset mo;
  mo.Initialize(sharp, -t, 1e-4, BRepOffset_Skin, Standard_False, Standard_False, GeomAbs_Intersection, Standard_False);
  for (auto& f : sopen) mo.SetOffsetOnFace(f, t);
  mo.MakeOffsetShape();
  if (!mo.IsDone()) return why = "inner offset failed", TopoDS_Shape();
  TopoDS_Shape inner = mo.Shape();
  if (count(inner, TopAbs_SOLID) == 0) {
    BRepBuilderAPI_MakeSolid ms;
    for (TopExp_Explorer ex(inner, TopAbs_SHELL); ex.More(); ex.Next()) ms.Add(TopoDS::Shell(ex.Current()));
    if (!ms.IsDone()) return why = "inner offset isn't closed", TopoDS_Shape();
    inner = ms.Solid();
  }
  return runBool(Bool::Cut, body, {inner}, 0, BOPAlgo_GlueOff, why);
}

/**
 * Hollow a solid to wall thickness `t`, leaving `open` faces open (none =
 * closed hollow). outward = walls grow outside the faces instead of inside.
 */
inline Result shell(const TopoDS_Shape& body, const std::vector<int>& openFaces, double t, bool outward = false) {
  Result r;
  Index ix(body);
  if (!(t > 0)) return fail(r, "The wall thickness must be more than zero");
  std::vector<TopoDS_Face> open;
  TopTools_ListOfShape openList;
  for (int i : openFaces) {
    if (i < 0 || i >= ix.faces.Extent()) return fail(r, "That face no longer matches its body");
    open.push_back(TopoDS::Face(ix.faces.FindKey(i + 1)));
    openList.Append(open.back());
  }
  if ((int)open.size() >= ix.faces.Extent()) return fail(r, "Leave at least one face closed");
  // Walls thicker than the body is wide can't be hollowed.
  {
    Bnd_Box b;
    BRepBndLib::Add(body, b, false);
    double x0, y0, z0, x1, y1, z1;
    b.Get(x0, y0, z0, x1, y1, z1);
    const double thin = std::min({x1 - x0, y1 - y0, z1 - z0});
    if (!outward && 2 * t >= thin * 0.999 && open.empty())
      return fail(r, "A " + num(t) + " mm wall leaves no room inside: the body is only " + num(thin) + " mm across at its thinnest.");
  }
  // Pre-check: a convex curved face tighter than the wall folds the inside over.
  if (!outward) {
    for (int i = 1; i <= ix.faces.Extent(); i++) {
      const TopoDS_Face f = TopoDS::Face(ix.faces.FindKey(i));
      if (std::any_of(open.begin(), open.end(), [&](const TopoDS_Face& g) { return g.IsSame(f); })) continue;
      const double rad = convexRadius(f);
      if (rad < t * (1 - 1e-6)) r.badFaces.push_back(i - 1);
    }
    // Not fatal on its own: Intersection mode can sometimes cope. Kept for the error.
  }
  const double off = outward ? t : -t;
  const double v0 = volume(body);
  // The walls hold about (area of the closed faces) x (thickness) of material:
  // less where the inside shrinks round convex corners, more round concave
  // ones. A result far outside that is OpenCascade quietly getting it wrong
  // (e.g. handing back the inner core, or a body barely touched).
  double closedArea = area(body);
  for (auto& f : open) closedArea -= area(f);
  const double wall = closedArea * t;
  Ladder L{r};
  L.expect.minSolids = 1;
  if (outward) {
    L.expect.minVolume = v0 + wall * 0.5;
    L.expect.maxVolume = v0 + wall * 2.5;
  } else {
    L.expect.minVolume = std::min(wall * 0.25, v0 * 0.5);
    L.expect.maxVolume = std::min(v0 * (1 + 1e-6), wall * 1.6);
  }
  auto thick = [&](const TopoDS_Shape& b, const TopTools_ListOfShape& faces, GeomAbs_JoinType join, bool inter) {
    return [&, join, inter](std::string& why) -> TopoDS_Shape {
      BRepOffsetAPI_MakeThickSolid mk;
      mk.MakeThickSolidByJoin(b, faces, off, 1e-4, BRepOffset_Skin, inter, Standard_False, join, Standard_False);
      if (!mk.IsDone()) {
        why = "thick solid failed";
        return TopoDS_Shape();
      }
      return mk.Shape();
    };
  };
  std::vector<int> preBad = r.badFaces;
  r.badFaces.clear();
  // Closed hollow (nothing open): OpenCascade's thick solid gives back the
  // inner core instead; cutting the shrunk body out leaves the void.
  if (open.empty() && !outward) L.step("offset and cut", [&](std::string& why) { return shellByCut(body, open, t, why); });
  // Arc joins round the outside corners of an outward shell; inward the corners stay sharp.
  L.step("direct", thick(body, openList, GeomAbs_Arc, false));
  L.step("intersection join", thick(body, openList, GeomAbs_Intersection, false));
  L.step("intersection mode", thick(body, openList, GeomAbs_Intersection, true));
  // Faces split along same-surface seams confuse the offset: merge them first.
  if (!r.ok()) {
    try {
      ShapeUpgrade_UnifySameDomain u(body, true, true, true);
      u.Build();
      TopoDS_Shape ub = u.Shape();
      TopTools_ListOfShape ul;
      bool lost = false;
      for (auto& f : open) {
        const TopTools_ListOfShape& m = u.History()->Modified(f);
        if (!m.IsEmpty()) ul.Append(m.First());
        else if (u.History()->IsRemoved(f)) lost = true;
        else ul.Append(f);
      }
      if (!lost && !ub.IsSame(body)) {
        L.step("merged faces", thick(ub, ul, GeomAbs_Arc, false));
        L.step("merged faces, intersection", thick(ub, ul, GeomAbs_Intersection, true));
      }
    } catch (const Standard_Failure&) {
    }
  }
  if (!r.ok() && !outward && !preBad.empty())
    L.step("sharp inside corners (rounds tighter than the wall)", [&](std::string& why) { return shellByDefeature(body, ix, open, t, why); });
  if (!r.ok() && !outward)
    L.step("offset and cut", [&](std::string& why) { return shellByCut(body, open, t, why); });
  if (!r.ok()) {
    TopoDS_Shape h = heal(body);
    if (!h.IsSame(body)) {
      Index hix(h);
      TopTools_ListOfShape hl;
      for (int i : openFaces)
        if (i < hix.faces.Extent()) hl.Append(hix.faces.FindKey(i + 1));
      L.step("healed input", thick(h, hl, GeomAbs_Intersection, false));
    }
  }
  if (r.ok()) {
    if (r.strategy != "direct") r.notes.push_back("needed: " + r.strategy);
    return r;
  }
  r.badFaces = preBad;
  if (!preBad.empty()) {
    const TopoDS_Face f = TopoDS::Face(ix.faces.FindKey(preBad[0] + 1));
    const double rad = convexRadius(f);
    r.hint = std::floor(rad * 0.98 * 100) / 100;
    return fail(r, "A " + num(t) + " mm wall is thicker than " + faceName(ix, f) + " is curved (radius " + num(rad) +
                       " mm), so the inside would fold over itself. Use a wall under " + num(rad) + " mm, or round that area less tightly.");
  }
  return fail(r, "The body couldn't be hollowed to " + num(t) + " mm. Try a thinner wall, or open different faces.");
}

// ---- offset and thicken -------------------------------------------------------------

/** Grow (+) or shrink (-) a whole solid by `d`, or offset a surface body. */
inline Result offset(const TopoDS_Shape& body, double d) {
  Result r;
  if (std::fabs(d) < 1e-9) return fail(r, "The distance is zero");
  const bool solid = count(body, TopAbs_SOLID) > 0;
  const double v0 = solid ? volume(body) : 0;
  const double a0 = area(body);
  Ladder L{r};
  L.expect.minSolids = solid ? 1 : 0;
  // The skin added / removed is about area x distance.
  if (solid) {
    if (d > 0) L.expect.minVolume = v0 + a0 * d * 0.7;
    else {
      L.expect.maxVolume = v0 - a0 * -d * 0.3;
      L.expect.minVolume = 1e-9;
    }
  }
  auto join = [&](GeomAbs_JoinType j, bool inter) {
    return [&, j, inter](std::string& why) -> TopoDS_Shape {
      BRepOffsetAPI_MakeOffsetShape mk;
      mk.PerformByJoin(body, d, 1e-4, BRepOffset_Skin, inter, Standard_False, j, Standard_False);
      if (!mk.IsDone()) {
        why = "offset failed";
        return TopoDS_Shape();
      }
      TopoDS_Shape s = mk.Shape();
      // An offset of a solid comes back as a shell sometimes: close it.
      if (solid && count(s, TopAbs_SOLID) == 0) {
        BRepBuilderAPI_MakeSolid ms;
        for (TopExp_Explorer ex(s, TopAbs_SHELL); ex.More(); ex.Next()) ms.Add(TopoDS::Shell(ex.Current()));
        s = ms.Solid();
      }
      return s;
    };
  };
  // Rounds tighter than the offset collapse: shrinking past a convex round (or
  // growing past a concave one) leaves a sharp corner. Take those rounds off
  // first so the result is what the offset really is, not a shrunken round.
  if (solid) {
    Index ix(body);
    TopTools_ListOfShape tight;
    for (int i = 1; i <= ix.faces.Extent(); i++) {
      const TopoDS_Face f = TopoDS::Face(ix.faces.FindKey(i));
      if ((d < 0 ? convexRadius(f) : concaveRadius(f)) < std::fabs(d) * (1 - 1e-6)) tight.Append(f);
    }
    if (!tight.IsEmpty())
      L.step("sharp corners where rounds collapse", [&](std::string& why) -> TopoDS_Shape {
        BRepAlgoAPI_Defeaturing df;
        df.SetShape(body);
        df.AddFacesToRemove(tight);
        df.Build();
        if (!df.IsDone() || df.HasErrors()) return why = "the rounds couldn't be taken off", TopoDS_Shape();
        BRepOffsetAPI_MakeOffsetShape mk;
        mk.PerformByJoin(df.Shape(), d, 1e-4, BRepOffset_Skin, Standard_False, Standard_False, d > 0 ? GeomAbs_Arc : GeomAbs_Intersection, Standard_False);
        if (!mk.IsDone()) return why = "offset failed", TopoDS_Shape();
        TopoDS_Shape s = mk.Shape();
        if (count(s, TopAbs_SOLID) == 0) {
          BRepBuilderAPI_MakeSolid ms;
          for (TopExp_Explorer ex(s, TopAbs_SHELL); ex.More(); ex.Next()) ms.Add(TopoDS::Shell(ex.Current()));
          s = ms.Solid();
        }
        return s;
      });
  }
  L.step("direct", join(GeomAbs_Arc, false));
  L.step("intersection join", join(GeomAbs_Intersection, false));
  L.step("intersection mode", join(GeomAbs_Intersection, true));
  // Freeform faces: the "simple" offset moves every face on its own and stitches
  // the gaps; no self-intersection handling, but robust where joins choke.
  L.step("simple offset", [&](std::string& why) -> TopoDS_Shape {
    BRepOffsetAPI_MakeOffsetShape mk;
    mk.PerformBySimple(body, d);
    if (!mk.IsDone()) {
      why = "simple offset failed";
      return TopoDS_Shape();
    }
    return mk.Shape();
  });
  if (r.ok()) {
    if (r.strategy != "direct") r.notes.push_back("needed: " + r.strategy);
    return r;
  }
  return fail(r, d < 0 ? "The body can't be shrunk by " + num(-d) + " mm: part of it is thinner than that, or curves more tightly." : "The body can't be grown by " + num(d) + " mm.");
}

/** Faces (or a whole surface body) thickened into a solid of thickness t (+ along the normals, - against). */
inline Result thicken(const TopoDS_Shape& sheet, double t) {
  Result r;
  if (std::fabs(t) < 1e-9) return fail(r, "The thickness is zero");
  if (count(sheet, TopAbs_FACE) == 0) return fail(r, "Pick faces or a surface body to thicken");
  // About area x thickness; far off means the offset folded over itself.
  const double a0 = area(sheet) * std::fabs(t);
  Ladder L{r};
  L.expect.minSolids = 1;
  L.expect.minVolume = a0 * 0.6;
  L.expect.maxVolume = a0 * 1.4;
  L.step("direct", [&](std::string& why) -> TopoDS_Shape {
    BRepOffset_MakeOffset mo;
    mo.Initialize(sheet, t, 1e-4, BRepOffset_Skin, Standard_False, Standard_False, GeomAbs_Intersection, Standard_True);
    mo.MakeOffsetShape();
    if (!mo.IsDone()) {
      why = "thicken failed";
      return TopoDS_Shape();
    }
    return mo.Shape();
  });
  L.step("simple thicken", [&](std::string& why) -> TopoDS_Shape {
    BRepOffsetAPI_MakeThickSolid mk;
    mk.MakeThickSolidBySimple(sheet, t);
    if (!mk.IsDone()) {
      why = "simple thicken failed";
      return TopoDS_Shape();
    }
    return mk.Shape();
  });
  L.step("arc join", [&](std::string& why) -> TopoDS_Shape {
    BRepOffset_MakeOffset mo;
    mo.Initialize(sheet, t, 1e-4, BRepOffset_Skin, Standard_False, Standard_False, GeomAbs_Arc, Standard_True);
    mo.MakeOffsetShape();
    if (!mo.IsDone()) {
      why = "thicken failed";
      return TopoDS_Shape();
    }
    return mo.Shape();
  });
  if (r.ok()) {
    if (r.strategy != "direct") r.notes.push_back("needed: " + r.strategy);
    return r;
  }
  return fail(r, "The faces couldn't be thickened by " + num(std::fabs(t)) + " mm: they curve more tightly than that somewhere, or fold back on themselves.");
}

// ---- draft -------------------------------------------------------------------------

/** Faces that meet `f` tangentially (they must be drafted with it). */
inline std::vector<int> tangentNeighbours(const Index& ix, int fi) {
  std::vector<int> out;
  const TopoDS_Face f = TopoDS::Face(ix.faces.FindKey(fi + 1));
  for (TopExp_Explorer ex(f, TopAbs_EDGE); ex.More(); ex.Next()) {
    const TopoDS_Edge e = TopoDS::Edge(ex.Current());
    auto fs = ix.facesOf(e);
    if (fs.size() != 2 || BRep_Tool::IsClosed(e, fs[0])) continue;
    const TopoDS_Face other = fs[0].IsSame(f) ? fs[1] : fs[0];
    if (isSmooth(e, fs[0], fs[1])) out.push_back(ix.face(other));
  }
  return out;
}

/**
 * Draft faces by `angle` degrees about a neutral plane, for a mould pulling
 * along `pull`. Positive angle = the face leans out as it goes along `pull`
 * (narrows away from the neutral plane for outside walls).
 */
inline Result draft(const TopoDS_Shape& body, const std::vector<int>& faceIdx, double angle, const gp_Dir& pull, const gp_Pln& neutral) {
  Result r;
  Index ix(body);
  if (faceIdx.empty()) return fail(r, "Pick the faces to draft");
  if (std::fabs(angle) < 1e-9) return fail(r, "The angle is zero");
  if (std::fabs(angle) >= 89) return fail(r, "The draft angle must be under 89°");
  for (int i : faceIdx) {
    if (i < 0 || i >= ix.faces.Extent()) return fail(r, "That face no longer matches its body");
    const TopoDS_Face f = TopoDS::Face(ix.faces.FindKey(i + 1));
    BRepAdaptor_Surface s(f);
    if (s.GetType() == GeomAbs_Plane && faceNormal(f).IsParallel(pull, 1e-6)) {
      r.badFaces.push_back(i);
      return fail(r, faceName(ix, f) + " faces straight along the pull direction, so it can't be drafted (it would tilt sideways). Draft the side walls instead.");
    }
  }
  auto run = [&](const std::vector<int>& faces, double ang) {
    return [&, faces, ang](std::string& why) -> TopoDS_Shape {
      BRepOffsetAPI_DraftAngle da(body);
      for (int i : faces) {
        const TopoDS_Face f = TopoDS::Face(ix.faces.FindKey(i + 1));
        da.Add(f, pull, ang * kPi / 180, neutral);
        if (!da.AddDone()) {
          const int bad = ix.face(da.ProblematicShape());
          why = "face " + std::to_string((bad >= 0 ? bad : i) + 1) + " refused";
          r.badFaces.push_back(bad >= 0 ? bad : i);
          return TopoDS_Shape();
        }
      }
      da.Build();
      if (!da.IsDone()) {
        why = "draft failed";
        return TopoDS_Shape();
      }
      return da.Shape();
    };
  };
  const double v0 = volume(body);
  Ladder L{r};
  L.expect.minSolids = 1;
  L.expect.minVolume = v0 * 0.3;
  L.expect.maxVolume = v0 * 3;
  L.step("direct", run(faceIdx, angle));
  // Tangent faces (a wall with rounded corners) must be drafted together:
  // add the tangent chain the user didn't pick.
  if (!r.ok()) {
    std::set<int> all(faceIdx.begin(), faceIdx.end());
    std::vector<int> stack(faceIdx.begin(), faceIdx.end());
    while (!stack.empty()) {
      const int f = stack.back();
      stack.pop_back();
      for (int n : tangentNeighbours(ix, f)) {
        const TopoDS_Face nf = TopoDS::Face(ix.faces.FindKey(n + 1));
        // Not the caps (faces along the pull).
        if (BRepAdaptor_Surface(nf).GetType() == GeomAbs_Plane && faceNormal(nf).IsParallel(pull, 1e-6)) continue;
        if (all.insert(n).second) stack.push_back(n);
      }
    }
    if (all.size() > faceIdx.size()) {
      std::vector<int> chain(all.begin(), all.end());
      r.badFaces.clear();
      if (L.step("with tangent faces", run(chain, angle)))
        r.notes.push_back("also drafted " + std::to_string(chain.size() - faceIdx.size()) + " tangent face(s) so the wall stays smooth");
    }
  }
  if (!r.ok()) {
    TopoDS_Shape h = heal(body);
    if (!h.IsSame(body)) L.step("healed input", [&](std::string& why) -> TopoDS_Shape {
        Index hix(h);
        BRepOffsetAPI_DraftAngle da(h);
        for (int i : faceIdx) {
          if (i >= hix.faces.Extent()) return TopoDS_Shape();
          da.Add(TopoDS::Face(hix.faces.FindKey(i + 1)), pull, angle * kPi / 180, neutral);
          if (!da.AddDone()) {
            why = "refused";
            return TopoDS_Shape();
          }
        }
        da.Build();
        return da.IsDone() ? da.Shape() : TopoDS_Shape();
      });
  }
  if (r.ok()) {
    if (r.strategy != "direct" && r.notes.empty()) r.notes.push_back("needed: " + r.strategy);
    return r;
  }
  if (r.badFaces.empty()) r.badFaces = faceIdx;
  const TopoDS_Face f = TopoDS::Face(ix.faces.FindKey(r.badFaces[0] + 1));
  return fail(r, "A " + num(angle) + "° draft can't be applied to " + faceName(ix, f) +
                     ": the faces around it can't be re-trimmed to meet it. Try a smaller angle, or draft its neighbours too.");
}

}  // namespace rk
