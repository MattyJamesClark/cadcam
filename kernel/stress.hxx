// Kernel stress tests: the classic ways CAD kernels fail, run against plain
// OpenCascade ("raw", what a naive call gives) and our layer (rk::). Built
// into the wasm kernel (Module.stressTest) and natively (kernel/stress-main.cpp),
// so the scoreboard reflects the build that ships.
//
// Status per case:
//   pass        both raw OCCT and our layer give a correct result
//   fixed       raw OCCT fails or gives a broken / wrong result; ours is correct
//   clear       the operation is impossible (or not solved yet) and we say why in
//               plain English, naming the faulty edge / face
//   fail        wrong result, crash, or a vague error: still to do

#pragma once

#include "robust.hxx"

#include <BRepAlgoAPI_Cut.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepOffsetAPI_ThruSections.hxx>
#include <BRepOffset_MakeOffset.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <BRepPrimAPI_MakeWedge.hxx>
#include <GC_MakeArcOfCircle.hxx>
#include <GeomAPI_PointsToBSplineSurface.hxx>
#include <Geom_BSplineSurface.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <Interface_Static.hxx>
#include <STEPControl_Reader.hxx>
#include <STEPControl_Writer.hxx>
#include <TColgp_Array2OfPnt.hxx>
#include <gp_Ax2.hxx>
#include <gp_Trsf.hxx>

#include <cstdio>
#include <fstream>
#include <iterator>
#include <regex>

namespace stress {

using rk::Result;
using Clock = std::chrono::steady_clock;
inline double msSince(Clock::time_point t) { return std::chrono::duration<double, std::milli>(Clock::now() - t).count(); }

struct Row {
  std::string id, group, title;
  bool possible = true;
  std::string status;  // pass | fixed | clear | fail
  bool rawOk = false;
  std::string rawWhy;
  double rawMs = 0, oursMs = 0;
  std::string strategy, error, note;
  std::vector<int> badEdges, badFaces;
  double hint = std::numeric_limits<double>::quiet_NaN();
  std::vector<std::string> steps;
};

// ---- geometry helpers ----------------------------------------------------------

inline TopoDS_Shape box(double x, double y, double z, double dx, double dy, double dz) {
  return BRepPrimAPI_MakeBox(gp_Pnt(x, y, z), dx, dy, dz).Shape();
}
inline TopoDS_Shape cyl(gp_Pnt p, gp_Dir d, double r, double h) { return BRepPrimAPI_MakeCylinder(gp_Ax2(p, d), r, h).Shape(); }
inline TopoDS_Shape rawFuse(const TopoDS_Shape& a, const TopoDS_Shape& b) {
  BRepAlgoAPI_Fuse f(a, b);
  ShapeUpgrade_UnifySameDomain u(f.Shape(), true, true, true);
  u.Build();
  return rk::solidsOnly(u.Shape());
}
inline TopoDS_Shape rawCut(const TopoDS_Shape& a, const TopoDS_Shape& b) {
  BRepAlgoAPI_Cut f(a, b);
  ShapeUpgrade_UnifySameDomain u(f.Shape(), true, true, true);
  u.Build();
  return rk::solidsOnly(u.Shape());
}
inline TopoDS_Shape moved(const TopoDS_Shape& s, gp_Vec v) {
  gp_Trsf t;
  t.SetTranslation(v);
  return BRepBuilderAPI_Transform(s, t, true).Shape();
}
inline TopoDS_Shape rotated(const TopoDS_Shape& s, gp_Ax1 ax, double deg) {
  gp_Trsf t;
  t.SetRotation(ax, deg * rk::kPi / 180);
  return BRepBuilderAPI_Transform(s, t, true).Shape();
}

/** Indices of edges matching a test on their midpoint and kind. */
inline std::vector<int> edgesWhere(const TopoDS_Shape& s, const std::function<bool(const gp_Pnt&, const BRepAdaptor_Curve&)>& f) {
  std::vector<int> out;
  rk::Index ix(s);
  for (int i = 1; i <= ix.edges.Extent(); i++) {
    const TopoDS_Edge e = TopoDS::Edge(ix.edges.FindKey(i));
    if (BRep_Tool::Degenerated(e)) continue;
    auto fs = ix.facesOf(e);
    if (!fs.empty() && BRep_Tool::IsClosed(e, fs[0])) continue;  // seam
    BRepAdaptor_Curve c(e);
    if (f(c.Value((c.FirstParameter() + c.LastParameter()) / 2), c)) out.push_back(i - 1);
  }
  return out;
}
inline std::vector<int> allEdges(const TopoDS_Shape& s) {
  return edgesWhere(s, [](const gp_Pnt&, const BRepAdaptor_Curve&) { return true; });
}
/** Faces whose outward normal at the middle is close to d. */
inline std::vector<int> facesFacing(const TopoDS_Shape& s, gp_Dir d) {
  std::vector<int> out;
  rk::Index ix(s);
  for (int i = 1; i <= ix.faces.Extent(); i++)
    if (rk::faceNormal(TopoDS::Face(ix.faces.FindKey(i))).Angle(d) < 1e-3) out.push_back(i - 1);
  return out;
}
inline std::vector<int> facesWhere(const TopoDS_Shape& s, const std::function<bool(const TopoDS_Face&)>& f) {
  std::vector<int> out;
  rk::Index ix(s);
  for (int i = 1; i <= ix.faces.Extent(); i++)
    if (f(TopoDS::Face(ix.faces.FindKey(i)))) out.push_back(i - 1);
  return out;
}
inline std::vector<rk::EdgeSize> sized(const std::vector<int>& edges, double r1, double r2 = -1) {
  std::vector<rk::EdgeSize> v;
  for (int e : edges) v.push_back({e, r1, r2 < 0 ? r1 : r2});
  return v;
}

/** Rounded slot (stadium) of length l, width w, extruded h: a tangent chain of 4 edges top and bottom. */
inline TopoDS_Shape stadium(double l, double w, double h) {
  const double r = w / 2;
  gp_Pnt a(0, -r, 0), b(l, -r, 0), c(l, r, 0), d(0, r, 0);
  BRepBuilderAPI_MakeWire mw;
  mw.Add(BRepBuilderAPI_MakeEdge(a, b).Edge());
  mw.Add(BRepBuilderAPI_MakeEdge(GC_MakeArcOfCircle(b, gp_Pnt(l + r, 0, 0), c).Value()).Edge());
  mw.Add(BRepBuilderAPI_MakeEdge(c, d).Edge());
  mw.Add(BRepBuilderAPI_MakeEdge(GC_MakeArcOfCircle(d, gp_Pnt(-r, 0, 0), a).Value()).Edge());
  TopoDS_Face f = BRepBuilderAPI_MakeFace(mw.Wire()).Face();
  return BRepPrimAPI_MakePrism(f, gp_Vec(0, 0, h)).Shape();
}

/** Rounded rectangle (corner radius rc) block: flat sides joined tangentially by quarter cylinders. */
inline TopoDS_Shape roundedBlock(double dx, double dy, double h, double rc) {
  TopoDS_Shape b = box(0, 0, 0, dx, dy, h);
  BRepFilletAPI_MakeFillet mf(b);
  for (int e : edgesWhere(b, [](const gp_Pnt&, const BRepAdaptor_Curve& c) { return c.GetType() == GeomAbs_Line && c.Line().Direction().IsParallel(gp::DZ(), 1e-6); }))
    mf.Add(rc, TopoDS::Edge(rk::Index(b).edges.FindKey(e + 1)));
  return mf.Shape();
}

/** Freeform (B-spline) sheet over [0,w]x[0,w], height z(x,y). */
inline TopoDS_Face bsplineSheet(double w, const std::function<double(double, double)>& z, int n = 6) {
  TColgp_Array2OfPnt pts(1, n, 1, n);
  for (int i = 1; i <= n; i++)
    for (int j = 1; j <= n; j++) {
      const double x = w * (i - 1) / (n - 1), y = w * (j - 1) / (n - 1);
      pts.SetValue(i, j, gp_Pnt(x, y, z(x, y)));
    }
  GeomAPI_PointsToBSplineSurface fit(pts);
  return BRepBuilderAPI_MakeFace(fit.Surface(), 1e-7).Face();
}

/** Twisted loft: a square turning 20° and shrinking per level, so the side faces are freeform (B-spline). */
inline TopoDS_Shape loftBlock() {
  auto square = [](double half, double deg, double z) {
    const double a = deg * rk::kPi / 180;
    std::vector<gp_Pnt> p;
    for (int i = 0; i < 4; i++) {
      const double t = a + i * rk::kPi / 2 + rk::kPi / 4;
      p.push_back(gp_Pnt(15 + half * std::sqrt(2.0) * std::cos(t), 15 + half * std::sqrt(2.0) * std::sin(t), z));
    }
    BRepBuilderAPI_MakeWire mw;
    for (size_t i = 0; i < p.size(); i++) mw.Add(BRepBuilderAPI_MakeEdge(p[i], p[(i + 1) % p.size()]).Edge());
    return mw.Wire();
  };
  BRepOffsetAPI_ThruSections ts(Standard_True, Standard_False);
  ts.AddWire(square(15, 0, 0));
  ts.AddWire(square(13, 20, 10));
  ts.AddWire(square(10, 40, 20));
  ts.Build();
  return ts.Shape();
}

inline TopoDS_Shape plateWithHoles(int nx, int ny, double pitch, double r, double t, bool oneByOne, double* ms = nullptr, bool raw = false) {
  TopoDS_Shape plate = box(0, 0, 0, nx * pitch, ny * pitch, t);
  std::vector<TopoDS_Shape> holes;
  for (int i = 0; i < nx; i++)
    for (int j = 0; j < ny; j++) holes.push_back(cyl(gp_Pnt(pitch * (i + 0.5), pitch * (j + 0.5), -1), gp::DZ(), r, t + 2));
  const auto t0 = Clock::now();
  TopoDS_Shape out;
  if (oneByOne) {
    out = plate;
    for (auto& h : holes) {
      if (raw) {
        std::string why;
        out = rk::runBool(rk::Bool::Cut, out, {h}, 0, BOPAlgo_GlueOff, why);
        if (out.IsNull()) return out;
        continue;
      }
      Result r = rk::boolean(rk::Bool::Cut, out, {h});
      if (!r.ok()) return TopoDS_Shape();
      out = r.shape;
    }
  } else if (raw) {
    std::string why;
    out = rk::runBool(rk::Bool::Cut, plate, holes, 0, BOPAlgo_GlueOff, why);
  } else {
    Result r = rk::boolean(rk::Bool::Cut, plate, holes);
    out = r.shape;
  }
  if (ms) *ms = msSince(t0);
  return out;
}

// ---- checks -----------------------------------------------------------------------

/** Valid, n solids, volume within [lo, hi]. Empty string = fine, else what's wrong. */
inline std::string checkSolid(const TopoDS_Shape& s, int n, double lo, double hi) {
  if (s.IsNull()) return "no result";
  if (!BRepCheck_Analyzer(s).IsValid()) return "invalid B-rep";
  const int k = rk::count(s, TopAbs_SOLID);
  if (k != n) return std::to_string(k) + " solids, expected " + std::to_string(n);
  const double v = rk::volume(s);
  if (v < lo || v > hi) return "volume " + rk::num(v) + " outside " + rk::num(lo) + ".." + rk::num(hi);
  return "";
}

// ---- running a case ------------------------------------------------------------------

struct Spec {
  std::string id, group, title;
  bool possible = true;
  /** Plain OpenCascade, as a naive call would do it. Return null / throw on failure. */
  std::function<TopoDS_Shape()> raw;
  /** Our layer. */
  std::function<Result()> ours;
  /** Is a result correct? "" = yes. */
  std::function<std::string(const TopoDS_Shape&)> check;
  /** For impossible cases: must the error name an edge / face? */
  bool mustName = true;
  /** Raw OpenCascade crashes the process on this one: don't run it. */
  bool rawCrashes = false;
};

inline Row run(const Spec& s) {
  Row row;
  row.id = s.id;
  row.group = s.group;
  row.title = s.title;
  row.possible = s.possible;
  // Raw.
  {
    const auto t0 = Clock::now();
    TopoDS_Shape r;
    std::string why;
    try {
      if (s.rawCrashes) why = "crashes the kernel (not run)";
      else {
        r = s.raw ? s.raw() : TopoDS_Shape();
        if (r.IsNull()) why = "not done";
      }
    } catch (const Standard_Failure& e) {
      why = "exception: " + rk::what(e);
    } catch (const std::exception& e) {
      why = std::string("exception: ") + e.what();
    }
    row.rawMs = msSince(t0);
    if (!r.IsNull()) {
      why = s.check(r);
      if (!why.empty()) why = "wrong result: " + why;
    }
    row.rawOk = why.empty();
    row.rawWhy = why;
  }
  // Ours.
  Result res;
  {
    const auto t0 = Clock::now();
    try {
      res = s.ours();
    } catch (const Standard_Failure& e) {
      res.error = "uncaught exception: " + rk::what(e);
    } catch (const std::exception& e) {
      res.error = std::string("uncaught exception: ") + e.what();
    }
    row.oursMs = msSince(t0);
  }
  row.strategy = res.strategy;
  row.error = res.error;
  row.badEdges = res.badEdges;
  row.badFaces = res.badFaces;
  row.hint = res.hint;
  row.steps = res.steps;
  for (auto& n : res.notes) row.note += (row.note.empty() ? "" : "; ") + n;
  if (res.ok()) {
    const std::string bad = s.check(res.shape);
    if (bad.empty()) row.status = row.rawOk ? "pass" : "fixed";
    else {
      row.status = "fail";
      row.note = "our result is wrong: " + bad + (row.note.empty() ? "" : "; " + row.note);
    }
  } else {
    const bool named = !res.badEdges.empty() || !res.badFaces.empty() || !s.mustName;
    const bool vague = res.error.empty() || res.error.find("exception") != std::string::npos;
    if (!vague && named) row.status = "clear";
    else row.status = "fail";
    if (s.possible && row.rawOk) {
      row.status = "fail";
      row.note = "raw OCCT managed it but we refused";
    }
  }
  return row;
}

// ---- the cases --------------------------------------------------------------------

inline std::vector<Spec> cases() {
  using namespace rk;
  std::vector<Spec> L;
  auto rawFillet = [](TopoDS_Shape b, std::vector<int> edges, double r1, double r2 = -1) {
    return [=]() -> TopoDS_Shape {
      Index ix(b);
      BRepFilletAPI_MakeFillet mf(b);
      for (int e : edges)
        if (r2 < 0) mf.Add(r1, TopoDS::Edge(ix.edges.FindKey(e + 1)));
        else mf.Add(r1, r2, TopoDS::Edge(ix.edges.FindKey(e + 1)));
      mf.Build();
      return mf.IsDone() ? mf.Shape() : TopoDS_Shape();
    };
  };
  auto rawChamfer = [](TopoDS_Shape b, std::vector<int> edges, double d) {
    return [=]() -> TopoDS_Shape {
      Index ix(b);
      BRepFilletAPI_MakeChamfer mc(b);
      for (int e : edges) mc.Add(d, TopoDS::Edge(ix.edges.FindKey(e + 1)));
      mc.Build();
      return mc.IsDone() ? mc.Shape() : TopoDS_Shape();
    };
  };
  auto rawShell = [](TopoDS_Shape b, std::vector<int> faces, double t) {
    return [=]() -> TopoDS_Shape {
      Index ix(b);
      TopTools_ListOfShape l;
      for (int f : faces) l.Append(ix.faces.FindKey(f + 1));
      BRepOffsetAPI_MakeThickSolid mk;
      mk.MakeThickSolidByJoin(b, l, -t, 1e-4);
      return mk.IsDone() ? mk.Shape() : TopoDS_Shape();
    };
  };
  auto solidCheck = [](int n, double lo, double hi) { return [=](const TopoDS_Shape& s) { return checkSolid(s, n, lo, hi); }; };
  auto filletCase = [&](std::string id, std::string title, TopoDS_Shape b, std::vector<int> edges, double r, double lo, double hi, bool possible = true, double r2 = -1) {
    L.push_back({id, "Fillet", title, possible, rawFillet(b, edges, r, r2), [=] { return blend(Blend::Fillet, b, sized(edges, r, r2)); }, solidCheck(1, lo, hi)});
  };

  // -- Fillets -------------------------------------------------------------------
  {
    TopoDS_Shape b = box(0, 0, 0, 20, 20, 20);
    // Rounding all 12 edges of a cube: 8 vertices where 3 fillets meet.
    const double v = 8000 - 12 * (4 - kPi) * 20 + 0;  // rough: each edge removes (1-pi/4) r^2 L
    filletCase("F1", "Cube, all 12 edges r2 (three fillets meet at every corner)", b, allEdges(b), 2, 8000 - 12 * 20 * 4 * (1 - kPi / 4) - 50, 8000 - 12 * 16 * 4 * (1 - kPi / 4) + 50);
    (void)v;
    auto corner = edgesWhere(b, [](const gp_Pnt& p, const BRepAdaptor_Curve&) { return (p.X() < 1e-6) + (p.Y() < 1e-6) + (p.Z() < 1e-6) >= 2; });
    L.push_back({"F2", "Fillet", "Cube corner, three edges with radii 1, 2 and 3 meeting at one vertex", true,
                 [=] {
                   Index ix(b);
                   BRepFilletAPI_MakeFillet mf(b);
                   for (size_t i = 0; i < corner.size(); i++) mf.Add(1.0 + i, TopoDS::Edge(ix.edges.FindKey(corner[i] + 1)));
                   mf.Build();
                   return mf.IsDone() ? mf.Shape() : TopoDS_Shape();
                 },
                 [=] {
                   std::vector<EdgeSize> l;
                   for (size_t i = 0; i < corner.size(); i++) l.push_back({corner[i], 1.0 + i, 1.0 + i});
                   return blend(Blend::Fillet, b, l);
                 },
                 solidCheck(1, 7900, 8000)});
  }
  {
    // L-block: a concave edge meeting convex ones at a vertex (mixed vertex).
    TopoDS_Shape l = rawFuse(box(0, 0, 0, 30, 20, 10), box(0, 0, 10, 10, 20, 15));
    auto e = edgesWhere(l, [](const gp_Pnt& p, const BRepAdaptor_Curve&) { return std::fabs(p.Z() - 10) < 1e-6 || std::fabs(p.X() - 10) < 1e-6; });
    const double v0 = volume(l);
    filletCase("F3", "L-block, concave + convex edges meeting at the inner corner r2", l, e, 2, v0 - 200, v0 + 200);
  }
  {
    // Boss on a plate: concave circle at the base and convex at the top.
    TopoDS_Shape b = rawFuse(box(0, 0, 0, 40, 40, 5), cyl(gp_Pnt(20, 20, 5), gp::DZ(), 8, 10));
    auto e = edgesWhere(b, [](const gp_Pnt&, const BRepAdaptor_Curve& c) { return c.GetType() == GeomAbs_Circle; });
    const double v0 = volume(b);
    filletCase("F4", "Boss on a plate: round base (concave) and top (convex) edges r2", b, e, 2, v0 - 100, v0 + 100);
  }
  {
    TopoDS_Shape s = stadium(30, 10, 8);
    auto top = edgesWhere(s, [](const gp_Pnt& p, const BRepAdaptor_Curve&) { return std::fabs(p.Z() - 8) < 1e-6; });
    const double v0 = volume(s);
    filletCase("F5", "Slot: rolling-ball r2 round a tangent chain (line, arc, line, arc)", s, {top[0]}, 2, v0 - 120, v0 - 10);
    filletCase("F6", "Slot: variable radius 1 to 3 along a tangent chain", s, {top[0]}, 1, v0 - 200, v0 - 5, true, 3);
  }
  {
    TopoDS_Shape p = box(0, 0, 0, 20, 20, 4);
    auto vert = edgesWhere(p, [](const gp_Pnt& q, const BRepAdaptor_Curve& c) { return c.Line().Direction().IsParallel(gp::DZ(), 1e-6) && q.X() < 1e-6 && q.Y() < 1e-6; });
    filletCase("F7", "Fillet bigger than the faces beside it (r25 on a 20 mm plate)", p, vert, 25, 0, 1600, false);
    TopoDS_Shape bar = box(0, 0, 0, 40, 10, 4);
    auto topLong = edgesWhere(bar, [](const gp_Pnt& q, const BRepAdaptor_Curve& c) { return std::fabs(q.Z() - 4) < 1e-6 && c.Line().Direction().IsParallel(gp::DX(), 1e-6); });
    auto topOne = edgesWhere(bar, [](const gp_Pnt& q, const BRepAdaptor_Curve& c) { return std::fabs(q.Z() - 4) < 1e-6 && q.Y() < 1e-6 && c.Line().Direction().IsParallel(gp::DX(), 1e-6); });
    auto sideOne = edgesWhere(bar, [](const gp_Pnt& q, const BRepAdaptor_Curve& c) { return q.X() < 1e-6 && q.Y() < 1e-6 && c.Line().Direction().IsParallel(gp::DZ(), 1e-6); });
    (void)sideOne;
    const double fullRound = 40 * (10 * 4 - 2 * (4 - kPi) * 1);  // 2 fillets r2 eat (1-pi/4)*4 each
    TopoDS_Shape rib = box(0, 0, 0, 40, 10, 10);
    auto ribTop = edgesWhere(rib, [](const gp_Pnt& q, const BRepAdaptor_Curve& c) { return std::fabs(q.Z() - 10) < 1e-6 && c.Line().Direction().IsParallel(gp::DX(), 1e-6); });
    const double fr = 40 * (100 - 2 * 25 * (1 - kPi / 4));
    filletCase("F8", "Full round: r5 on both top edges of a 10 mm rib (the fillets use up the whole top face)", rib, ribTop, 5, fr - 2, fr + 2);
    filletCase("F8b", "Fillets that would overlap: r6 on both top edges of a 10 mm rib", rib, ribTop, 6, 0, 4000, false);
    filletCase("F9", "Fillet as tall as the wall: r4 on one top edge of a 4 mm bar (uses up the side face)", bar, topOne, 4, 1600 - 40 * 16 * (1 - kPi / 4) - 2, 1600 - 40 * 16 * (1 - kPi / 4) + 2);
    filletCase("F10", "Fillet just under the wall height: r3.9 on a 4 mm bar", bar, topOne, 3.9, 1600 - 40 * 3.9 * 3.9 * (1 - kPi / 4) - 5, 1600 - 40 * 3.9 * 3.9 * (1 - kPi / 4) + 5);
    (void)fullRound;
  }
  {
    // Cylinder into cylinder (T pipe): a saddle-shaped intersection edge.
    TopoDS_Shape t = rawFuse(cyl(gp_Pnt(-30, 0, 0), gp::DX(), 10, 60), cyl(gp_Pnt(0, 0, 0), gp::DZ(), 6, 25));
    auto e = edgesWhere(t, [](const gp_Pnt& p, const BRepAdaptor_Curve& c) { return c.GetType() != GeomAbs_Circle && c.GetType() != GeomAbs_Line && p.Z() > 1; });
    const double v0 = volume(t);
    filletCase("F11", "T pipe: r2 on the saddle edge where two cylinders meet", t, e, 2, v0, v0 + 200);
  }
  {
    // Box with a big sphere scooped out of the top: edge between a plane and a sphere.
    TopoDS_Shape b = rawCut(box(0, 0, 0, 40, 40, 20), BRepPrimAPI_MakeSphere(gp_Pnt(20, 20, 45), 30).Shape());
    auto e = edgesWhere(b, [](const gp_Pnt&, const BRepAdaptor_Curve& c) { return c.GetType() == GeomAbs_Circle; });
    const double v0 = volume(b);
    filletCase("F12", "Sphere scooped from a box: r2 on the plane / sphere edge", b, e, 2, v0 - 300, v0);
  }
  {
    TopoDS_Shape lb = loftBlock();
    auto top = edgesWhere(lb, [](const gp_Pnt& p, const BRepAdaptor_Curve&) { return p.Z() > 18; });
    const double v0 = volume(lb);
    filletCase("F13", "Lofted (freeform) block: r1.5 round the twisted top", lb, top, 1.5, v0 - 300, v0);
  }
  {
    // Square pyramid: four edges meet at the apex.
    TopoDS_Shape py = BRepPrimAPI_MakeWedge(20, 20, 20, 10, 10, 10, 10).Shape();
    auto apex = edgesWhere(py, [](const gp_Pnt& p, const BRepAdaptor_Curve&) { return p.Y() > 5; });
    const double v0 = volume(py);
    filletCase("F14", "Pyramid apex: r1 on four edges meeting at one point", py, apex, 1, v0 - 100, v0);
  }
  {
    TopoDS_Shape s = stadium(30, 10, 8);
    rk::Index ix(s);
    // Edge between the flat side and the half-cylinder end: tangent, nothing to round.
    auto smooth = edgesWhere(s, [](const gp_Pnt&, const BRepAdaptor_Curve& c) { return c.GetType() == GeomAbs_Line && c.Line().Direction().IsParallel(gp::DZ(), 1e-6); });
    filletCase("F15", "Fillet on a smooth (tangent) edge", s, {smooth[0]}, 1, 0, 1e9, false);
  }
  {
    double ms = 0;
    TopoDS_Shape p = plateWithHoles(10, 10, 10, 3, 5, false, &ms);
    auto tops = edgesWhere(p, [](const gp_Pnt& q, const BRepAdaptor_Curve& c) { return c.GetType() == GeomAbs_Circle && q.Z() > 4.9; });
    const double v0 = volume(p);
    filletCase("F16", "Big job: r0.5 on 100 hole edges at once", p, tops, 0.5, v0 - 130, v0 - 80);
  }

  {
    // Second-order rounding: a block with r4 vertical corners, then r1 round the top (lines and arcs, tangent).
    TopoDS_Shape rb = roundedBlock(40, 30, 15, 4);
    auto top = edgesWhere(rb, [](const gp_Pnt& p, const BRepAdaptor_Curve&) { return std::fabs(p.Z() - 15) < 1e-6; });
    const double v0 = volume(rb);
    filletCase("F17", "Rounded block: r1 round the whole top (a tangent loop of lines and arcs)", rb, top, 1, v0 - 60, v0 - 10);
    // Very different radii meeting at one corner.
    TopoDS_Shape b = box(0, 0, 0, 30, 30, 30);
    auto corner = edgesWhere(b, [](const gp_Pnt& p, const BRepAdaptor_Curve&) { return (p.X() < 1e-6) + (p.Y() < 1e-6) + (p.Z() < 1e-6) >= 2; });
    L.push_back({"F18", "Fillet", "Cube corner with radii 1, 1 and 8 meeting at one vertex (very different sizes)", true,
                 [=] {
                   Index ix(b);
                   BRepFilletAPI_MakeFillet mf(b);
                   const double rr[3] = {1, 1, 8};
                   for (size_t i = 0; i < corner.size(); i++) mf.Add(rr[i], TopoDS::Edge(ix.edges.FindKey(corner[i] + 1)));
                   mf.Build();
                   return mf.IsDone() ? mf.Shape() : TopoDS_Shape();
                 },
                 [=] {
                   const double rr[3] = {1, 1, 8};
                   std::vector<EdgeSize> l;
                   for (size_t i = 0; i < corner.size(); i++) l.push_back({corner[i], rr[i], rr[i]});
                   return blend(Blend::Fillet, b, l);
                 },
                 solidCheck(1, 27000 - 30 * 64 * (1 - kPi / 4) - 30, 27000 - 5)});
    // Inside and outside edges of a thin-walled (shelled) box.
    TopoDS_Shape cup;
    {
      BRepOffsetAPI_MakeThickSolid mk;
      TopTools_ListOfShape l;
      l.Append(Index(box(0, 0, 0, 40, 30, 20)).faces.FindKey(facesFacing(box(0, 0, 0, 40, 30, 20), gp::DZ())[0] + 1));
      TopoDS_Shape bb = box(0, 0, 0, 40, 30, 20);
      TopTools_ListOfShape l2;
      l2.Append(Index(bb).faces.FindKey(facesFacing(bb, gp::DZ())[0] + 1));
      mk.MakeThickSolidByJoin(bb, l2, -2, 1e-4);
      cup = mk.Shape();
    }
    auto rim = edgesWhere(cup, [](const gp_Pnt& p, const BRepAdaptor_Curve&) { return std::fabs(p.Z() - 20) < 1e-6; });
    const double vc = volume(cup);
    filletCase("F19", "Thin-walled cup: r0.9 on both rim edges of a 2 mm wall (fillets nearly meet)", cup, rim, 0.9, vc - 50, vc - 40);
    filletCase("F20", "Thin-walled cup: r1 on both rim edges of a 2 mm wall (full round rim)", cup, rim, 1, vc - 45, vc);
  }

  // -- Chamfers --------------------------------------------------------------------
  {
    TopoDS_Shape b = box(0, 0, 0, 20, 20, 20);
    const double cut = 12 * 20 * 0.5;  // ~each edge removes d^2/2 * L
    L.push_back({"C1", "Chamfer", "Cube, all 12 edges 1 mm", true, rawChamfer(b, allEdges(b), 1), [=] { return blend(Blend::Chamfer, b, sized(allEdges(b), 1)); }, solidCheck(1, 8000 - cut - 10, 8000 - cut + 20)});
    auto e = edgesWhere(b, [](const gp_Pnt& p, const BRepAdaptor_Curve&) { return p.Z() > 19.9 && p.Y() < 1e-6; });
    L.push_back({"C2", "Chamfer", "Two distances (1 x 3) on one edge", true,
                 [=]() -> TopoDS_Shape {
                   Index ix(b);
                   BRepFilletAPI_MakeChamfer mc(b);
                   const TopoDS_Edge ed = TopoDS::Edge(ix.edges.FindKey(e[0] + 1));
                   mc.Add(1, 3, ed, ix.facesOf(ed)[0]);
                   mc.Build();
                   return mc.IsDone() ? mc.Shape() : TopoDS_Shape();
                 },
                 [=] { return blend(Blend::Chamfer, b, {{e[0], 1, 3}}); }, solidCheck(1, 8000 - 31, 8000 - 29)});
    L.push_back({"C3", "Chamfer", "Distance 2 at 30° on one edge", true,
                 [=]() -> TopoDS_Shape {
                   Index ix(b);
                   BRepFilletAPI_MakeChamfer mc(b);
                   const TopoDS_Edge ed = TopoDS::Edge(ix.edges.FindKey(e[0] + 1));
                   mc.AddDA(2, 30 * kPi / 180, ed, ix.facesOf(ed)[0]);
                   mc.Build();
                   return mc.IsDone() ? mc.Shape() : TopoDS_Shape();
                 },
                 [=] {
                   EdgeSize s{e[0], 2, 2, 30};
                   return blend(Blend::Chamfer, b, {s});
                 },
                 solidCheck(1, 7950, 7999)});
    TopoDS_Shape p = box(0, 0, 0, 20, 20, 4);
    auto top = edgesWhere(p, [](const gp_Pnt& q, const BRepAdaptor_Curve&) { return q.Z() > 3.9 && q.Y() < 1e-6; });
    {
      // Found in the app: chamfer an outside corner of a shelled box deeper than its wall.
      TopoDS_Shape bb = box(0, 0, 0, 100, 60, 40);
      auto two = edgesWhere(bb, [](const gp_Pnt& p, const BRepAdaptor_Curve&) { return std::fabs(p.Z() - 40) < 1e-6 && (p.Y() < 1e-6 || std::fabs(p.X() - 100) < 1e-6); });
      TopoDS_Shape f2 = blend(Blend::Fillet, bb, sized(two, 8)).shape;
      TopoDS_Shape cupf = shell(f2, facesWhere(f2, [](const TopoDS_Face& f) { return BRepAdaptor_Surface(f).GetType() == GeomAbs_Plane && faceNormal(f).Angle(gp::DZ()) < 1e-3; }), 3).shape;
      auto corner = edgesWhere(cupf, [](const gp_Pnt& p, const BRepAdaptor_Curve& c) { return c.GetType() == GeomAbs_Line && c.Line().Direction().IsParallel(gp::DZ(), 1e-6) && std::fabs(p.X() - 100) < 1e-6 && std::fabs(p.Y() - 60) < 1e-6; });
      const double vc = volume(cupf);
      L.push_back({"C5", "Chamfer", "Shelled box: 5 mm chamfer down an outside corner that ends where two fillets meet (found in the app; OpenCascade crashes)", true, rawChamfer(cupf, corner, 5),
                   [=] { return blend(Blend::Chamfer, cupf, sized(corner, 5)); }, solidCheck(1, vc - 500, vc), false, true});
      const double ch = 0.5 * 4 * 40;
      L.push_back({"C6", "Chamfer", "Shelled box (3 mm walls): 2 mm chamfer on an outside corner", true, rawChamfer(cupf, corner, 2),
                   [=] { return blend(Blend::Chamfer, cupf, sized(corner, 2)); }, solidCheck(1, vc - ch - 20, vc - ch + 20)});
    }
    L.push_back({"C4", "Chamfer", "Chamfer deeper than the plate (6 mm on a 4 mm plate)", false, rawChamfer(p, top, 6), [=] { return blend(Blend::Chamfer, p, sized(top, 6)); }, solidCheck(1, 0, 1600)});
  }

  // -- Shell -----------------------------------------------------------------------
  auto shellCase = [&](std::string id, std::string title, TopoDS_Shape b, std::vector<int> open, double t, double lo, double hi, bool possible = true, bool mustName = true) {
    L.push_back({id, "Shell", title, possible, rawShell(b, open, t), [=] { return shell(b, open, t); }, solidCheck(1, lo, hi), mustName});
  };
  {
    TopoDS_Shape b = box(0, 0, 0, 40, 30, 20);
    const double inner = 36 * 26 * 18;
    shellCase("S1", "Box 2 mm walls, top open", b, facesFacing(b, gp::DZ()), 2, 24000 - inner - 1, 24000 - inner + 1);
    shellCase("S2", "Box 0.05 mm walls (very thin), top open", b, facesFacing(b, gp::DZ()), 0.05, 50, 200);
    shellCase("S3", "Wall thicker than the box is wide (12 mm on 20 mm), closed", b, {}, 12, 0, 24000, false, false);
    TopoDS_Shape r3 = roundedBlock(40, 30, 20, 4);
    shellCase("S4", "Rounded box (r4 corners), 2 mm walls: walls thinner than the rounds", r3, facesFacing(r3, gp::DZ()), 2, 4000, 9000);
    TopoDS_Shape r1 = roundedBlock(40, 30, 20, 1);
    shellCase("S5", "Rounded box (r1 corners), 2 mm walls: walls thicker than the rounds (inner corner collapses)", r1, facesFacing(r1, gp::DZ()), 2, 4000, 9000);
    // All edges rounded r1, then shell 2: the classic one (inner offset of every fillet inverts).
    TopoDS_Shape all;
    {
      Index ix(b);
      BRepFilletAPI_MakeFillet mf(b);
      for (int e : allEdges(b)) mf.Add(1, TopoDS::Edge(ix.edges.FindKey(e + 1)));
      all = mf.Shape();
    }
    shellCase("S6", "Box with all edges r1, 2 mm walls, top open (every fillet tighter than the wall)", all, facesWhere(all, [](const TopoDS_Face& f) { return BRepAdaptor_Surface(f).GetType() == GeomAbs_Plane && faceNormal(f).Angle(gp::DZ()) < 1e-3; }), 2, 3000, 9000);
  }
  {
    TopoDS_Shape c = cyl(gp_Pnt(0, 0, 0), gp::DZ(), 15, 30);
    const double v = kPi * 225 * 30 - kPi * 14 * 14 * 29;
    shellCase("S7", "Cylinder cup, 1 mm walls, top open", c, facesFacing(c, gp::DZ()), 1, v - 1, v + 1);
    TopoDS_Shape s = BRepPrimAPI_MakeSphere(gp_Pnt(0, 0, 0), 20).Shape();
    const double vs = 4.0 / 3 * kPi * (8000 - 18 * 18 * 18);
    shellCase("S8", "Hollow sphere (closed, no faces open), 2 mm", s, {}, 2, vs - 5, vs + 5);
    TopoDS_Shape lb = loftBlock();
    auto bottom = facesFacing(lb, -gp::DZ());
    shellCase("S9", "Lofted block (freeform faces), 1.5 mm walls, bottom open", lb, bottom, 1.5, 1000, volume(lb));
    {
      // Found in the app: two r8 fillets meeting at a corner, top open, 3 mm walls.
      TopoDS_Shape bb = box(0, 0, 0, 100, 60, 40);
      auto two = edgesWhere(bb, [](const gp_Pnt& p, const BRepAdaptor_Curve&) { return std::fabs(p.Z() - 40) < 1e-6 && (p.Y() < 1e-6 || std::fabs(p.X() - 100) < 1e-6); });
      TopoDS_Shape f2 = blend(Blend::Fillet, bb, sized(two, 8)).shape;
      auto topf = facesWhere(f2, [](const TopoDS_Face& f) { return BRepAdaptor_Surface(f).GetType() == GeomAbs_Plane && faceNormal(f).Angle(gp::DZ()) < 1e-3; });
      const double vf = volume(f2);
      shellCase("S12", "Box with two r8 fillets meeting at a corner, 3 mm walls, top open (found in the app)", f2, topf, 3, vf * 0.15, vf * 0.4);
    }
    TopoDS_Shape holed = rawCut(box(0, 0, 0, 40, 30, 20), cyl(gp_Pnt(20, 15, -1), gp::DZ(), 5, 22));
    shellCase("S11", "Box with a through hole, 2 mm walls, top open (wall round the hole too)", holed, facesFacing(holed, gp::DZ()), 2, 3000, 9000);
    TopoDS_Shape pipe = rawFuse(cyl(gp_Pnt(-30, 0, 0), gp::DX(), 10, 60), cyl(gp_Pnt(0, 0, 0), gp::DZ(), 6, 25));
    auto ends = facesWhere(pipe, [](const TopoDS_Face& f) { return BRepAdaptor_Surface(f).GetType() == GeomAbs_Plane; });
    shellCase("S10", "T pipe, 1 mm walls, all three ends open", pipe, ends, 1, 500, volume(pipe));
  }

  // -- Offset / thicken -------------------------------------------------------------
  {
    TopoDS_Shape b = box(0, 0, 0, 20, 20, 20);
    // Grow 2: 24^3 minus the corner / edge roundings.
    const double grown = 8000 + 6 * 400 * 2 + 12 * 20 * kPi * 4 / 4 + 8 * (4.0 / 3 * kPi * 8) / 8;
    L.push_back({"O1", "Offset", "Grow a cube by 2 mm (rounded edges and corners)", true,
                 [=]() -> TopoDS_Shape {
                   BRepOffsetAPI_MakeOffsetShape mk;
                   mk.PerformByJoin(b, 2, 1e-4);
                   return mk.IsDone() ? mk.Shape() : TopoDS_Shape();
                 },
                 [=] { return offset(b, 2); }, solidCheck(1, grown - 5, grown + 5)});
    L.push_back({"O2", "Offset", "Shrink a cube by 2 mm", true,
                 [=]() -> TopoDS_Shape {
                   BRepOffsetAPI_MakeOffsetShape mk;
                   mk.PerformByJoin(b, -2, 1e-4);
                   return mk.IsDone() ? mk.Shape() : TopoDS_Shape();
                 },
                 [=] { return offset(b, -2); }, solidCheck(1, 4096 - 1, 4096 + 1)});
    TopoDS_Shape lb = loftBlock();
    const double v0 = volume(lb);
    L.push_back({"O3", "Offset", "Grow a lofted (freeform) solid by 1 mm", true,
                 [=]() -> TopoDS_Shape {
                   BRepOffsetAPI_MakeOffsetShape mk;
                   mk.PerformByJoin(lb, 1, 1e-4);
                   return mk.IsDone() ? mk.Shape() : TopoDS_Shape();
                 },
                 [=] { return offset(lb, 1); }, solidCheck(1, v0 * 1.05, v0 * 1.5)});
    TopoDS_Face wave = bsplineSheet(40, [](double x, double y) { return 3 * std::sin(x / 8) * std::cos(y / 9); });
    L.push_back({"O4", "Offset", "Thicken a wavy freeform surface by 2 mm", true,
                 [=]() -> TopoDS_Shape {
                   BRepOffset_MakeOffset mo;
                   mo.Initialize(wave, 2, 1e-4, BRepOffset_Skin, Standard_False, Standard_False, GeomAbs_Intersection, Standard_True);
                   mo.MakeOffsetShape();
                   return mo.IsDone() ? mo.Shape() : TopoDS_Shape();
                 },
                 [=] { return thicken(wave, 2); }, solidCheck(1, 1600 * 2 * 0.95, 1600 * 2 * 1.3)});
    TopoDS_Face saddle = bsplineSheet(40, [](double x, double y) { return ((x - 20) * (x - 20) - (y - 20) * (y - 20)) / 40; });
    L.push_back({"O5", "Offset", "Thicken a saddle (doubly curved) surface by 1 mm", true,
                 [=]() -> TopoDS_Shape {
                   BRepOffset_MakeOffset mo;
                   mo.Initialize(saddle, 1, 1e-4, BRepOffset_Skin, Standard_False, Standard_False, GeomAbs_Intersection, Standard_True);
                   mo.MakeOffsetShape();
                   return mo.IsDone() ? mo.Shape() : TopoDS_Shape();
                 },
                 [=] { return thicken(saddle, 1); }, solidCheck(1, 1600 * 0.95, 1600 * 1.5)});
    TopoDS_Face tight = bsplineSheet(20, [](double x, double) { return 4 * std::sin(x / 1.5); }, 12);
    L.push_back({"O6", "Offset", "Thicken a tightly rippled surface by 3 mm (ripples tighter than the thickness)", false,
                 [=]() -> TopoDS_Shape {
                   BRepOffset_MakeOffset mo;
                   mo.Initialize(tight, 3, 1e-4, BRepOffset_Skin, Standard_False, Standard_False, GeomAbs_Intersection, Standard_True);
                   mo.MakeOffsetShape();
                   return mo.IsDone() ? mo.Shape() : TopoDS_Shape();
                 },
                 [=] { return thicken(tight, 3); }, solidCheck(1, 400 * 3 * 0.9, 400 * 3 * 1.6), false});
  }

  {
    // Shrinking past a round: the r1 fillets collapse when the body shrinks 2 mm.
    TopoDS_Shape rb = roundedBlock(30, 20, 10, 1);
    L.push_back({"O7", "Offset", "Shrink a block with r1 corners by 2 mm (the rounds collapse to sharp corners)", true,
                 [=]() -> TopoDS_Shape {
                   BRepOffsetAPI_MakeOffsetShape mk;
                   mk.PerformByJoin(rb, -2, 1e-4);
                   return mk.IsDone() ? mk.Shape() : TopoDS_Shape();
                 },
                 [=] { return offset(rb, -2); }, solidCheck(1, 26 * 16 * 6 - 5, 26 * 16 * 6 + 1)});
    // Growing across a narrow slot: the 3 mm slot closes up when grown 2 mm.
    TopoDS_Shape slot = rawCut(box(0, 0, 0, 30, 20, 10), box(13.5, -1, 4, 3, 22, 7));
    L.push_back({"O8", "Offset", "Grow a block with a 3 mm slot by 2 mm (the slot closes up)", true,
                 [=]() -> TopoDS_Shape {
                   BRepOffsetAPI_MakeOffsetShape mk;
                   mk.PerformByJoin(slot, 2, 1e-4);
                   return mk.IsDone() ? mk.Shape() : TopoDS_Shape();
                 },
                 [=] { return offset(slot, 2); }, solidCheck(1, 34 * 24 * 14 - 600, 34 * 24 * 14 + 10)});
  }

  // -- Draft -----------------------------------------------------------------------
  {
    TopoDS_Shape b = box(-10, -10, 0, 20, 20, 20);
    auto sides = facesWhere(b, [](const TopoDS_Face& f) { return std::fabs(faceNormal(f).Z()) < 1e-6; });
    const gp_Pln neutral(gp_Pnt(0, 0, 0), gp::DZ());
    auto rawDraft = [](TopoDS_Shape b, std::vector<int> faces, double ang) {
      return [=]() -> TopoDS_Shape {
        Index ix(b);
        BRepOffsetAPI_DraftAngle da(b);
        for (int f : faces) da.Add(TopoDS::Face(ix.faces.FindKey(f + 1)), gp::DZ(), ang * kPi / 180, gp_Pln(gp_Pnt(0, 0, 0), gp::DZ()));
        da.Build();
        return da.IsDone() ? da.Shape() : TopoDS_Shape();
      };
    };
    const double t = std::tan(3 * kPi / 180) * 20;
    const double vd = 20.0 / 3 * (400 + (20 - 2 * t) * (20 - 2 * t) + 20 * (20 - 2 * t));
    L.push_back({"D1", "Draft", "Cube, four sides 3° about the base", true, rawDraft(b, sides, 3), [=] { return draft(b, sides, 3, gp::DZ(), neutral); },
                 [=](const TopoDS_Shape& s) {
                   std::string w = checkSolid(s, 1, std::min(vd, 8000.0) - 10, std::max(vd, 8000.0) + 10);
                   if (!w.empty()) return w;
                   return std::fabs(volume(s) - 8000) < 1 ? std::string("not drafted") : std::string();
                 }});
    TopoDS_Shape rb = roundedBlock(30, 20, 15, 4);
    auto oneSide = facesWhere(rb, [](const TopoDS_Face& f) { return BRepAdaptor_Surface(f).GetType() == GeomAbs_Plane && faceNormal(f).Angle(-gp::DY()) < 1e-3; });
    const double v0 = volume(rb);
    L.push_back({"D2", "Draft", "Rounded block: draft one flat wall that runs tangent into round corners", true, rawDraft(rb, oneSide, 3),
                 [=] { return draft(rb, oneSide, 3, gp::DZ(), neutral); },
                 [=](const TopoDS_Shape& s) {
                   std::string w = checkSolid(s, 1, v0 * 0.8, v0 * 1.2);
                   if (!w.empty()) return w;
                   return std::fabs(volume(s) - v0) < 0.5 ? std::string("not drafted") : std::string();
                 }});
    auto top = facesFacing(b, gp::DZ());
    L.push_back({"D3", "Draft", "Draft the top face (it faces along the pull)", false, rawDraft(b, top, 3), [=] { return draft(b, top, 3, gp::DZ(), neutral); },
                 solidCheck(1, 0, 1e9)});
    auto walls = facesWhere(rb, [](const TopoDS_Face& f) { return std::fabs(faceNormal(f).Z()) < 1e-6; });
    L.push_back({"D5", "Draft", "Rounded block: all walls and corner rounds 2° (a mould core)", true, rawDraft(rb, walls, 2),
                 [=] { return draft(rb, walls, 2, gp::DZ(), neutral); },
                 [=](const TopoDS_Shape& s) {
                   std::string w = checkSolid(s, 1, v0 * 0.85, v0 * 0.99);
                   return w;
                 }});
    TopoDS_Shape cy = cyl(gp_Pnt(0, 0, 0), gp::DZ(), 10, 20);
    auto wall = facesWhere(cy, [](const TopoDS_Face& f) { return BRepAdaptor_Surface(f).GetType() == GeomAbs_Cylinder; });
    const double vc = volume(cy);
    L.push_back({"D4", "Draft", "Cylinder wall 5° (becomes a cone)", true, rawDraft(cy, wall, 5), [=] { return draft(cy, wall, 5, gp::DZ(), neutral); },
                 [=](const TopoDS_Shape& s) {
                   std::string w = checkSolid(s, 1, vc * 0.6, vc * 1.4);
                   if (!w.empty()) return w;
                   return std::fabs(volume(s) - vc) < 0.5 ? std::string("not drafted") : std::string();
                 }});
  }

  // -- Booleans ---------------------------------------------------------------------
  auto boolCase = [&](std::string id, std::string title, Bool op, TopoDS_Shape a, std::vector<TopoDS_Shape> tools, int n, double lo, double hi, bool possible = true, bool mustName = true) {
    L.push_back({id, "Boolean", title, possible,
                 [=]() -> TopoDS_Shape {
                   std::string why;
                   TopoDS_Shape r = runBool(op, a, tools, 0, BOPAlgo_GlueOff, why);
                   if (r.IsNull()) return r;
                   ShapeUpgrade_UnifySameDomain u(r, true, true, true);
                   u.Build();
                   return u.Shape();
                 },
                 [=] { return boolean(op, a, tools); }, solidCheck(n, lo, hi), mustName});
  };
  {
    TopoDS_Shape a = box(0, 0, 0, 10, 10, 10);
    boolCase("B1", "Two boxes sharing a whole face (coincident faces), add", Bool::Fuse, a, {box(10, 0, 0, 10, 10, 10)}, 1, 1999, 2001);
    boolCase("B2", "Two boxes sharing part of a face, offset, add", Bool::Fuse, a, {box(10, 3, 3, 10, 10, 10)}, 1, 1999, 2001);
    boolCase("B3", "Flush cut: pocket whose top is level with the top face", Bool::Cut, a, {box(2, 2, 5, 6, 6, 5)}, 1, 819, 821);
    boolCase("B4", "Near-coincident: second box 0.00001 mm into the first, add", Bool::Fuse, a, {box(10 - 1e-5, 0, 0, 10, 10, 10)}, 1, 1999, 2001);
    boolCase("B5", "Near-coincident gap: second box 0.00001 mm away, add (should stay 2 bodies or join)", Bool::Fuse, a, {box(10 + 1e-5, 0, 0, 10, 10, 10)}, 2, 1999, 2001);
    boolCase("B6", "Cylinder lying tangent on a box face (line contact), add", Bool::Fuse, a, {cyl(gp_Pnt(-5, 5, 13), gp::DX(), 3, 20)}, 2, 1000 + kPi * 9 * 20 - 1, 1000 + kPi * 9 * 20 + 1);
    boolCase("B7", "Sphere touching a box at one point, add", Bool::Fuse, a, {BRepPrimAPI_MakeSphere(gp_Pnt(5, 5, 15), 5).Shape()}, 2, 1000 + 4.0 / 3 * kPi * 125 - 1, 1000 + 4.0 / 3 * kPi * 125 + 1);
    TopoDS_Shape c1 = cyl(gp_Pnt(0, 0, 0), gp::DZ(), 5, 10);
    boolCase("B8", "Same-radius coaxial cylinders end to end (coincident round faces), add", Bool::Fuse, c1, {cyl(gp_Pnt(0, 0, 5), gp::DZ(), 5, 10)}, 1, kPi * 25 * 15 - 1, kPi * 25 * 15 + 1);
    boolCase("B9", "A body added to an identical copy of itself", Bool::Fuse, a, {box(0, 0, 0, 10, 10, 10)}, 1, 999, 1001);
    // Slivers: a cutter rotated a hair off square leaves wedge faces microns thick.
    TopoDS_Shape cutter = rotated(box(-5, -5, 5, 30, 30, 10), gp_Ax1(gp_Pnt(5, 5, 5), gp::DX()), 0.001);
    boolCase("B10", "Sliver faces: cutter rotated 0.001° off the top face", Bool::Cut, a, {cutter}, 1, 499, 501);
    TopoDS_Shape big = box(0, 0, 0, 20, 20, 10);
    boolCase("B14", "Hole touching the side wall from inside (r5 hole, centre 5 mm from the wall)", Bool::Cut, big, {cyl(gp_Pnt(5, 10, -1), gp::DZ(), 5, 12)}, 1, 4000 - kPi * 250 - 1, 4000 - kPi * 250 + 1);
    // A cutter sharing a round face with a fillet already on the body.
    TopoDS_Shape rnd = roundedBlock(30, 20, 10, 4);
    const double vr = volume(rnd);
    boolCase("B15", "Cylinder exactly on a fillet's round face (coincident curved faces), add: nothing should change", Bool::Fuse, rnd, {cyl(gp_Pnt(4, 4, 0), gp::DZ(), 4, 10)}, 1, vr - 1, vr + 1);
    boolCase("B16", "Box standing on its edge on another box's face (line contact), add", Bool::Fuse, a, {rotated(box(0, 0, 10, 10, 10, 10), gp_Ax1(gp_Pnt(0, 0, 10), gp::DX()), 45)}, 2, 1999, 2001);
    boolCase("B11", "Cut that removes the whole body (should say so, not return nothing)", Bool::Cut, a, {box(-1, -1, -1, 12, 12, 12)}, 1, 0, 1000, false, false);
    boolCase("B12", "Cut splitting a body in two (must keep both pieces)", Bool::Cut, a, {box(4, -1, -1, 2, 12, 12)}, 2, 799, 801);
    // The "box vanished" bug: Edit faces on a box + cylinder Add result.
    TopoDS_Shape bc = rawFuse(box(0, 0, 0, 30, 20, 10), cyl(gp_Pnt(15, 10, 10), gp::DZ(), 5, 10));
    auto cylFace = facesWhere(bc, [](const TopoDS_Face& f) { return BRepAdaptor_Surface(f).GetType() == GeomAbs_Cylinder; });
    const double vbc = volume(bc);
    const double vGrow = 6000 + kPi * 49 * 10;
    L.push_back({"B13", "Boolean", "Edit faces on a box + cylinder Add result: pull the round face out 2 mm (the 'box vanished' bug)", true,
                 [=]() -> TopoDS_Shape {
                   // What editFaces did before: a whole-body offset with one face moved.
                   Index ix(bc);
                   BRepOffset_MakeOffset mo;
                   mo.Initialize(bc, 0.0, 1e-4, BRepOffset_Skin, Standard_False, Standard_False, GeomAbs_Intersection, Standard_False);
                   for (int f : cylFace) mo.SetOffsetOnFace(TopoDS::Face(ix.faces.FindKey(f + 1)), 2);
                   mo.MakeOffsetShape();
                   return mo.IsDone() ? mo.Shape() : TopoDS_Shape();
                 },
                 [=]() -> Result {
                   // Our way: thicken the face into a tool, fuse; the gate refuses lost bodies.
                   Index ix(bc);
                   Result t = thicken(ix.faces.FindKey(cylFace[0] + 1), 2);
                   if (!t.ok()) return t;
                   return boolean(Bool::Fuse, bc, {t.shape});
                 },
                 solidCheck(1, vGrow - 2, vGrow + 2)});
    (void)vbc;
  }

  // -- Tolerance creep ---------------------------------------------------------------
  {
    // 60 operations in a row, each sliding a cutter by an awkward amount so
    // edges land within microns of earlier ones. Raw: no tidy-up between steps.
    auto chain = [](bool ours) -> TopoDS_Shape {
      TopoDS_Shape cur = box(0, 0, 0, 60, 60, 10);
      for (int i = 0; i < 60; i++) {
        const double x = 2 + i * 0.9333333, y = 3 + (i % 7) * 7.7777777;
        TopoDS_Shape tool = rotated(box(x, y, 6 + (i % 3) * 1e-5, 3.3333333, 2.2222222, 10), gp_Ax1(gp_Pnt(x, y, 0), gp::DZ()), i * 0.37);
        if (ours) {
          Result r = rk::boolean(i % 2 ? Bool::Cut : Bool::Fuse, cur, {moved(tool, gp_Vec(0, 0, i % 2 ? 0 : -1e-6))});
          if (!r.ok()) return TopoDS_Shape();
          cur = r.shape;
        } else {
          std::string why;
          cur = runBool(i % 2 ? Bool::Cut : Bool::Fuse, cur, {moved(tool, gp_Vec(0, 0, i % 2 ? 0 : -1e-6))}, 0, BOPAlgo_GlueOff, why);
          if (cur.IsNull()) return cur;
        }
      }
      return cur;
    };
    L.push_back({"T1", "Tolerance", "60 booleans in a row with near-miss edges: still valid, tolerances still tight", true, [=] { return chain(false); },
                 [=] {
                   Result r;
                   r.shape = chain(true);
                   if (r.shape.IsNull()) r.error = "a step failed";
                   else {
                     r.strategy = "tidy after every step";
                     r.notes.push_back("max tolerance " + num(maxTolerance(r.shape)) + " mm");
                   }
                   return r;
                 },
                 [](const TopoDS_Shape& s) {
                   std::string w = checkSolid(s, 1, 30000, 40000);
                   if (!w.empty()) return w;
                   const double t = maxTolerance(s);
                   return t > 1e-4 ? "tolerance crept to " + num(t) + " mm" : std::string();
                 }});
  }

  // -- Imports ------------------------------------------------------------------------
  {
    auto writeStep = [](const TopoDS_Shape& s, const std::string& path) {
      STEPControl_Writer w;
      Interface_Static::SetCVal("write.step.schema", "AP214IS");
      w.Transfer(s, STEPControl_AsIs);
      return w.Write(path.c_str()) == IFSelect_RetDone;
    };
    auto readText = [](const std::string& p) {
      std::ifstream f(p);
      return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    };
    auto writeText = [](const std::string& p, const std::string& t) {
      std::ofstream f(p);
      f << t;
    };
    auto readStep = [](const std::string& path) -> TopoDS_Shape {
      STEPControl_Reader r;
      if (r.ReadFile(path.c_str()) != IFSelect_RetDone) return TopoDS_Shape();
      r.TransferRoots();
      return r.OneShape();
    };
    const std::string base = "/tmp/rk-stress-box.step";
    TopoDS_Shape b = box(0, 0, 0, 10, 10, 10);
    writeStep(b, base);
    const std::string good = readText(base);
    auto variant = [&](const std::string& name, const std::function<std::string(std::string)>& edit) {
      const std::string p = "/tmp/rk-stress-" + name + ".step";
      writeText(p, edit(good));
      return p;
    };
    // Points nudged 0.002 mm: faces no longer quite meet.
    const std::string gaps = variant("gaps", [](std::string t) {
      std::regex re("CARTESIAN_POINT\\('',\\(10\\.,");
      return std::regex_replace(t, re, "CARTESIAN_POINT('',(10.002,", std::regex_constants::format_first_only);
    });
    // One face left out of the shell: a hole in the body.
    const std::string missing = variant("missing", [](std::string t) {
      std::smatch m;
      std::regex re("CLOSED_SHELL\\('',\\((#\\d+),");
      if (std::regex_search(t, m, re)) t = std::regex_replace(t, std::regex("CLOSED_SHELL\\('',\\(" + m[1].str() + ","), "OPEN_SHELL('',(");
      return t;
    });
    const std::string truncated = variant("truncated", [](std::string t) { return t.substr(0, t.size() / 2); });
    auto importCase = [&](std::string id, std::string title, std::string path, bool possible, int solids) {
      L.push_back({id, "Import", title, possible,
                   [=] { return readStep(path); },
                   [=]() -> Result {
                     Result r;
                     TopoDS_Shape s = readStep(path);
                     if (s.IsNull()) {
                       r.error = "The file couldn't be read: it is cut short or isn't STEP.";
                       return r;
                     }
                     r.shape = healBody(s, r.notes);
                     r.strategy = r.notes.empty() ? "direct" : "healed";
                     if (rk::count(r.shape, TopAbs_SOLID) < solids) {
                       r.error = "The body has a hole in it (a face is missing), so it came in as a surface body: " + (r.notes.empty() ? std::string() : r.notes.back());
                       r.badFaces.push_back(0);
                       r.shape.Nullify();
                     }
                     return r;
                   },
                   solidCheck(solids, 999, 1001), possible});
    };
    importCase("I1", "STEP with corner points nudged 0.002 mm (faces don't quite meet)", gaps, true, 1);
    importCase("I2", "STEP with a face missing from the shell", missing, false, 1);
    L.push_back({"I3", "Import", "STEP file cut off half way", false, [=] { return readStep(truncated); },
                 [=]() -> Result {
                   Result r;
                   TopoDS_Shape s = readStep(truncated);
                   if (s.IsNull() || rk::count(s, TopAbs_FACE) == 0) r.error = "The file couldn't be read: it is cut short or isn't STEP.";
                   else r.shape = healBody(s, r.notes);
                   return r;
                 },
                 solidCheck(1, 999, 1001), false});
  }

  // -- Performance --------------------------------------------------------------------
  {
    const double v = 200 * 200 * 5 - 400 * kPi * 9 * 5;
    L.push_back({"P1", "Speed", "Plate with 400 holes, cut in one go", true, [] { return plateWithHoles(20, 20, 10, 3, 5, false, nullptr, true); },
                 [] {
                   Result r;
                   r.shape = plateWithHoles(20, 20, 10, 3, 5, false);
                   r.strategy = "one boolean, all tools";
                   return r;
                 },
                 solidCheck(1, v - 10, v + 10)});
    L.push_back({"P2", "Speed", "Plate with 100 holes, cut one at a time", true, [] { return plateWithHoles(10, 10, 10, 3, 5, true, nullptr, true); },
                 [] {
                   Result r;
                   r.shape = plateWithHoles(10, 10, 10, 3, 5, true);
                   r.strategy = "100 booleans";
                   return r;
                 },
                 solidCheck(1, 100 * 100 * 5 - 100 * kPi * 9 * 5 - 5, 100 * 100 * 5 - 100 * kPi * 9 * 5 + 5)});
  }
  return L;
}

// ---- output -----------------------------------------------------------------------

inline std::string esc(const std::string& s) {
  std::string o;
  for (char c : s) {
    if (c == '"' || c == '\\') o += '\\', o += c;
    else if (c == '\n') o += "\\n";
    else if ((unsigned char)c < 0x20) o += ' ';
    else o += c;
  }
  return o;
}

inline std::string json(const std::vector<Row>& rows) {
  std::ostringstream o;
  o << "[\n";
  for (size_t i = 0; i < rows.size(); i++) {
    const Row& r = rows[i];
    o << "  {\"id\":\"" << esc(r.id) << "\",\"group\":\"" << esc(r.group) << "\",\"title\":\"" << esc(r.title) << "\",\"possible\":" << (r.possible ? "true" : "false")
      << ",\"status\":\"" << r.status << "\",\"rawOk\":" << (r.rawOk ? "true" : "false") << ",\"rawWhy\":\"" << esc(r.rawWhy) << "\",\"rawMs\":" << rk::num(r.rawMs)
      << ",\"oursMs\":" << rk::num(r.oursMs) << ",\"strategy\":\"" << esc(r.strategy) << "\",\"error\":\"" << esc(r.error) << "\",\"note\":\"" << esc(r.note) << "\"";
    if (!std::isnan(r.hint)) o << ",\"hint\":" << rk::num(r.hint);
    o << ",\"badEdges\":[";
    for (size_t k = 0; k < r.badEdges.size(); k++) o << (k ? "," : "") << r.badEdges[k];
    o << "],\"badFaces\":[";
    for (size_t k = 0; k < r.badFaces.size(); k++) o << (k ? "," : "") << r.badFaces[k];
    o << "],\"steps\":[";
    for (size_t k = 0; k < r.steps.size(); k++) o << (k ? "," : "") << "\"" << esc(r.steps[k]) << "\"";
    o << "]}" << (i + 1 < rows.size() ? "," : "") << "\n";
  }
  o << "]\n";
  return o.str();
}

/** Every case id, in order (JSON array). */
inline std::string ids() {
  std::string o = "[";
  bool first = true;
  for (auto& c : cases()) {
    o += (first ? "\"" : ",\"") + c.id + "\"";
    first = false;
  }
  return o + "]";
}

/** Run the case with id `filter`, or every case in group `filter` (empty = all). */
inline std::vector<Row> runAll(const std::string& filter = "", const std::function<void(const Row&)>& each = {}) {
  std::vector<Row> rows;
  std::vector<Spec> all;
  try {
    all = cases();
  } catch (const Standard_Failure& e) {
    Row r;
    r.id = "SETUP";
    r.group = "Setup";
    r.title = "Building the test geometry";
    r.status = "fail";
    r.error = rk::what(e);
    rows.push_back(r);
    return rows;
  }
  for (auto& c : all) {
    if (!filter.empty() && c.id != filter && c.group != filter) continue;
    if (!filter.empty() && c.id != filter && c.group != filter) continue;
    rows.push_back(run(c));
    if (each) each(rows.back());
  }
  return rows;
}

}  // namespace stress
