#!/usr/bin/env bash
# Builds the native stress-test runner against a native OpenCascade build.
#   kernel/stress-native.sh <occt source dir> <occt build dir> [out]
set -euo pipefail
src=$1 build=$2 out=${3:-stress}
incs=$(for d in "$src"/src/*/; do printf -- '-I%s ' "$d"; done)
libs=$(find "$build" -name 'libTK*.a' | sort | tr '\n' ' ')
g++ -std=c++17 -O1 -g0 $incs -Ikernel kernel/stress-main.cpp -Wl,--start-group $libs -Wl,--end-group -lpthread -ldl -o "$out"
