#!/usr/bin/env bash
# Links kernel/cadkernel.cpp against the OpenCascade static libraries in
# occt-build/ into out/cadkernel.{js,wasm}.
#
# LLVM's wasm backend sometimes miscompiles a function that mixes switch
# statements and C++ exceptions at -O3, giving a module V8 refuses to load
# ("br_table: label arity inconsistent"). When that happens this script finds
# the function, recompiles its OpenCascade source file at -O1, links that
# object ahead of the libraries (so it replaces the archive member) and retries.
set -euo pipefail
: "${FLAGS:?}" "${VARIANT:?}"
mkdir -p out extra
incs=$(for d in occt/src/*/; do printf -- '-I%s ' "$d"; done)
libs=$(find occt-build -name 'libTK*.a' | sort | tr '\n' ' ')
em++ -std=c++17 $FLAGS $incs -c kernel/cadkernel.cpp -o cadkernel.o
ninja -C occt-build -t commands > occt-commands.txt

common=(-lembind -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createCadKernel
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=4MB
  -sENVIRONMENT=web,worker,node -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS)
node_bin="${EMSDK_NODE:-node}"
check() { "$node_bin" -e "try{new WebAssembly.Module(require('fs').readFileSync('$1'));console.log('valid')}catch(e){console.log(e.message)}"; }

for attempt in $(seq 1 12); do
  extras=$(ls extra/*.o 2>/dev/null | tr '\n' ' ' || true)
  # Unoptimised link with function names, just to validate.
  rm -rf /tmp/emscripten_temp
  EMCC_DEBUG=1 em++ $FLAGS cadkernel.o $extras $libs "${common[@]}" --profiling-funcs -O0 -o dbg.js > dbg-log.txt 2>&1 || true
  base=$(ls /tmp/emscripten_temp/emcc-*-base.wasm 2>/dev/null | head -1 || true)
  [ -n "$base" ] || { tail -30 dbg-log.txt; echo "link failed"; exit 1; }
  msg=$(check "$base")
  echo "attempt $attempt: $msg"
  [ "$msg" = valid ] && break
  n=$(echo "$msg" | grep -oE 'function #[0-9]+' | grep -oE '[0-9]+' | head -1)
  fn=$("$node_bin" kernel/wasm-fn-name.mjs "$base" "$n" | grep -E "^$n " | head -1 | cut -d' ' -f2-)
  cls=$(echo "$fn" | sed -E 's/^([A-Za-z0-9_]+)::.*/\1/')
  src=$(find occt/src -name "$cls.cxx" | head -1)
  [ -n "$src" ] || { echo "can't map '$fn' to a source file"; exit 1; }
  echo "recompiling $src at -O1 (miscompiled: $fn)"
  python3 - "$src" "extra/$cls.o" <<'PY'
import re, shlex, subprocess, sys
src, out = sys.argv[1], sys.argv[2]
name = src.split('/')[-1]
for line in open('occt-commands.txt'):
    if (' -c ' in line or line.rstrip().endswith('.cxx')) and '/' + name + ' ' in line + ' ':
        cmd = line.strip()
        # ninja runs from occt-build; make paths absolute by running there
        args = shlex.split(cmd)
        args = ['-O1' if a in ('-O2', '-O3') else a for a in args]
        i = args.index('-o'); args[i + 1] = '../' + out
        args = [a for a in args if not a.startswith(('-MD', '-MF', '-MT'))]
        # drop dependency-file arguments
        cleaned = []
        skip = False
        for a in args:
            if skip: skip = False; continue
            if a in ('-MF', '-MT', '-MQ'): skip = True; continue
            cleaned.append(a)
        subprocess.run(cleaned, cwd='occt-build', check=True)
        sys.exit(0)
sys.exit('no compile command for ' + name)
PY
done
[ "$msg" = valid ] || { echo "still invalid"; exit 1; }

extras=$(ls extra/*.o 2>/dev/null | tr '\n' ' ' || true)
# Final link: optimised if binaryen copes, else as-is (objects are already -O3).
if em++ $FLAGS cadkernel.o $extras $libs "${common[@]}" -O3 -o out/cadkernel.js && [ "$(check out/cadkernel.wasm)" = valid ]; then
  echo "$VARIANT, link -O3, O1 files: ${extras:-none}" > out/BUILD.txt
else
  em++ $FLAGS cadkernel.o $extras $libs "${common[@]}" -O0 -o out/cadkernel.js
  [ "$(check out/cadkernel.wasm)" = valid ] || { echo "final module invalid"; exit 1; }
  echo "$VARIANT, link -O0, O1 files: ${extras:-none}" > out/BUILD.txt
fi
cat out/BUILD.txt
cp occt/LICENSE_LGPL_21.txt out/LICENSE-OCCT.txt 2>/dev/null || true
ls -la out
