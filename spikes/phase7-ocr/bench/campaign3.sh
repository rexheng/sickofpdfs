#!/bin/bash
# Corrected build (dist2: reading order tells skewed lines apart). Single-thread WASM, so accuracy and clean CPU time come from the same run.
cd "$(dirname "$0")/.."
export SOP_DIST=dist2
run() { echo "=== $(date +%T) $*"; node bench/run.mjs ocr "$@" 2>&1 | grep -v '^$' | tail -6; }
SUB="syn-p25,syn-p100,deg-p0,deg-p2,en-modern-philosophy-p60,en-prince-pauper-p72,fr-bovary-p62,de-kafka-p12,rcpt-starbucks,rcpt-wholefoods"
run pp-v6-small-wasm1-d1280 --dpi native
run pp-v6-tiny-wasm1-d1280 --dpi native
run pp-v5-latin-wasm1-d1280 --dpi native
run pp-v6-medium-wasm1-d1280 --dpi native --pages $SUB
echo "=== done $(date +%T)"
