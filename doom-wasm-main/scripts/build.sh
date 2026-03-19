#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Keep emscripten cache local to this project so builds do not depend on
# write access to the Homebrew Cellar cache path.
export EM_CACHE="${EM_CACHE:-$(pwd)/.emscripten-cache}"
mkdir -p "$EM_CACHE"

if [ -f Makefile ]; then
  emmake make clean || true
fi

if [ "${DOOM_WASM_RECONFIGURE:-0}" = "1" ] || [ ! -f configure ] || grep -q "EXTRA_EXPORTED_RUNTIME_METHODS\\|INVOKE_RUN=1" configure; then
  emconfigure autoreconf -fiv
fi

ac_cv_exeext=".html" \
ac_cv_c_undeclared_builtin_options="none needed" \
emconfigure ./configure --host=none-none-none

emmake make
