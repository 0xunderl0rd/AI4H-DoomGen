#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOOM_DIR="$ROOT_DIR/doom-wasm-main"
OUT_DIR="$ROOT_DIR/public/doom-wasm"
WAD_OUT_DIR="$ROOT_DIR/public/doom"

if ! command -v emconfigure >/dev/null 2>&1 || ! command -v emmake >/dev/null 2>&1; then
  echo "Emscripten tooling not found (emconfigure/emmake). Install emsdk first."
  exit 1
fi

if [[ ! -d "$DOOM_DIR" ]]; then
  echo "Expected doom source at: $DOOM_DIR"
  exit 1
fi

pushd "$DOOM_DIR" >/dev/null
./scripts/build.sh
popd >/dev/null

mkdir -p "$OUT_DIR"
cp "$DOOM_DIR/src/websockets-doom.js" "$OUT_DIR/websockets-doom.js"
cp "$DOOM_DIR/src/websockets-doom.wasm" "$OUT_DIR/websockets-doom.wasm"
DEFAULT_CFG_SRC="${ROOT_DIR}/public/doom-wasm/default.cfg"
if [[ -f "$DOOM_DIR/src/default.cfg" ]]; then
  DEFAULT_CFG_SRC="$DOOM_DIR/src/default.cfg"
fi
if [[ -f "$OUT_DIR/default.cfg" ]] && cmp -s "$DEFAULT_CFG_SRC" "$OUT_DIR/default.cfg"; then
  :
else
  cp "$DEFAULT_CFG_SRC" "$OUT_DIR/default.cfg"
fi

if [[ -n "${1:-}" ]]; then
  mkdir -p "$WAD_OUT_DIR"
  cp "$1" "$WAD_OUT_DIR/doom1.wad"
  cp "$1" "$OUT_DIR/doom1.wad"
  echo "Copied IWAD to $WAD_OUT_DIR/doom1.wad"
fi

echo "doom-wasm assets copied to $OUT_DIR"
echo "Place doom1.wad at $WAD_OUT_DIR/doom1.wad (or pass path as first arg)."
