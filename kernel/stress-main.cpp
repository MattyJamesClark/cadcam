// Native runner for the kernel stress tests (same cases as Module.stressTest in
// the wasm kernel). Build: kernel/stress-native.sh <occt-src> <occt-build>
// Usage: stress [filter] [--json out.json]
#include "stress.hxx"

#include <cstring>
#include <iostream>

int main(int argc, char** argv) {
  std::string filter, out;
  for (int i = 1; i < argc; i++) {
    if (!std::strcmp(argv[i], "--json") && i + 1 < argc) out = argv[++i];
    else filter = argv[i];
  }
  auto rows = stress::runAll(filter, [](const stress::Row& r) {
    std::cout << r.id << "\t" << r.status << "\traw " << (r.rawOk ? "ok" : r.rawWhy) << " (" << rk::num(r.rawMs) << " ms)\tours " << (r.error.empty() ? r.strategy : r.error)
              << " (" << rk::num(r.oursMs) << " ms)" << (r.note.empty() ? "" : "\t" + r.note) << std::endl;
    for (auto& s : r.steps) std::cout << "      " << s << std::endl;
  });
  if (!out.empty()) {
    std::ofstream f(out);
    f << stress::json(rows);
  }
  int bad = 0;
  for (auto& r : rows) bad += r.status == "fail";
  std::cout << rows.size() << " cases, " << bad << " fail" << std::endl;
  return 0;
}
