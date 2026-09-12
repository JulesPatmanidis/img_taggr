#!/usr/bin/env bash
# Build the browser metadata engine into src/wasm/.
# Requires: rustup target add wasm32-unknown-unknown
#           cargo install wasm-bindgen-cli --version 0.2.128
set -euo pipefail
cd "$(dirname "$0")"

cargo build --manifest-path src-wasm/Cargo.toml \
  --target wasm32-unknown-unknown --release

wasm-bindgen --target web --no-typescript --out-dir src/wasm \
  src-wasm/target/wasm32-unknown-unknown/release/img_taggr_wasm.wasm

printf '\nbuilt src/wasm/  (%s gzipped)\n' \
  "$(gzip -c src/wasm/img_taggr_wasm_bg.wasm | wc -c | awk '{printf "%.0fKB", $1/1024}')"
