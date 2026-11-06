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
# Toolkits the cached OpenCascade build may not include (primitives, booleans,
# offsets): compile their packages directly when the library is missing.
for tk in TKPrim TKBO TKBool TKFillet TKOffset; do
  if ! echo "$libs" | grep -q "lib$tk.a"; then
    mkdir -p "tk/$tk"
    for pkg in $(cat occt/src/$tk/PACKAGES); do
      for f in occt/src/$pkg/*.cxx; do
        o="tk/$tk/$(basename "${f%.cxx}").o"
        [ -f "$o" ] || em++ -std=c++17 $FLAGS -DNDEBUG -DNo_Exception $incs -c "$f" -o "$o" &
        while [ "$(jobs -r | wc -l)" -ge 4 ]; do sleep 0.2; done
      done
    done
    wait
    emar rcs "tk/lib$tk.a" tk/$tk/*.o
    libs="tk/lib$tk.a $libs"
  fi
done
em++ -std=c++17 $FLAGS $incs -c kernel/cadkernel.cpp -o cadkernel.o

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
  # Same flags as the OpenCascade release build, but -O1.
  em++ -std=c++17 ${FLAGS/-O3/-O1} -DNDEBUG -DNo_Exception $incs -c "$src" -o "extra/$cls.o"
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
