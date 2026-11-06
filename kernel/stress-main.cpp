// Native runner for the kernel stress tests (same cases as Module.stressTest in
// the wasm kernel). Build: kernel/stress-native.sh <occt-src> <occt-build>
// Usage: stress [id or group] [--json out.json]
// Each case runs in its own process, so one that crashes OpenCascade is
// recorded as a failure instead of ending the run.
#include "stress.hxx"

#include <sys/wait.h>
#include <unistd.h>

#include <cstring>
#include <iostream>

static void print(const stress::Row& r) {
  std::cout << r.id << "\t" << r.status << "\traw " << (r.rawOk ? "ok" : r.rawWhy) << " (" << rk::num(r.rawMs) << " ms)\tours " << (r.error.empty() ? r.strategy : r.error)
            << " (" << rk::num(r.oursMs) << " ms)" << (r.note.empty() ? "" : "\t" + r.note) << std::endl;
  for (auto& s : r.steps) std::cout << "      " << s << std::endl;
}

int main(int argc, char** argv) {
  std::string filter, out;
  for (int i = 1; i < argc; i++) {
    if (!std::strcmp(argv[i], "--json") && i + 1 < argc) out = argv[++i];
    else filter = argv[i];
  }
  std::vector<stress::Spec> all = stress::cases();
  std::string json = "[\n";
  int n = 0, bad = 0;
  for (auto& c : all) {
    if (!filter.empty() && c.id != filter && c.group != filter) continue;
    int fd[2];
    if (pipe(fd)) return 1;
    std::cout.flush();
    const pid_t pid = fork();
    if (pid == 0) {
      close(fd[0]);
      stress::Row r = stress::run(c);
      print(r);
      std::string j = stress::json({r});
      // Strip the array brackets: just the row.
      j = j.substr(2, j.size() - 5);
      if (write(fd[1], j.data(), j.size()) < 0) _exit(2);
      _exit(0);
    }
    close(fd[1]);
    std::string got;
    char buf[4096];
    ssize_t k;
    while ((k = read(fd[0], buf, sizeof buf)) > 0) got.append(buf, k);
    close(fd[0]);
    int st = 0;
    waitpid(pid, &st, 0);
    if (got.empty()) {
      stress::Row r;
      r.id = c.id, r.group = c.group, r.title = c.title, r.possible = c.possible, r.status = "fail";
      r.error = "crashed inside OpenCascade";
      print(r);
      got = stress::json({r});
      got = got.substr(2, got.size() - 5);
    }
    if (got.find("\"status\":\"fail\"") != std::string::npos) bad++;
    json += (n++ ? ",\n" : "") + got;
  }
  json += "\n]\n";
  if (!out.empty()) {
    std::ofstream f(out);
    f << json;
  }
  std::cout << n << " cases, " << bad << " fail" << std::endl;
  return 0;
}
