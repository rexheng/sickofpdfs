#!/bin/bash
# Sequential accuracy campaign (one browser per run, nothing else running, so the timings are clean).
cd "$(dirname "$0")/.."
run() { echo "=== $(date +%T) $*"; node bench/run.mjs ocr "$@" 2>&1 | grep -v '^$' | tail -6; }
run tess-fast-eng --lang eng --dpi native
run pp-v6-tiny-wasm4-d1280 --dpi native
run pp-v6-small-wasm4-d1280 --dpi native
run pp-v5-latin-wasm4-d1280 --dpi native
run tess-fast-fra --lang fra --dpi native
run tess-fast-deu --lang deu --dpi native
run tess-fast-eng+fra+deu --dpi native
run pp-v6-medium-wasm4-d1280 --dpi native
run pp-v5-mobile-wasm4-d1280 --dpi native
run pp-v5-en-wasm4-d1280 --lang eng --dpi native
run tess-best-eng --lang eng --dpi native
run tess-best-fra --lang fra --dpi native
run tess-best-deu --lang deu --dpi native
echo "=== done $(date +%T)"
