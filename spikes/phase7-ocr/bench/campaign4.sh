#!/bin/bash
# Timing, thread scaling, WebGPU (software adapter), sweeps, heap growth and visible-first. Runs after campaign3 on the same build.
cd "$(dirname "$0")/.."
export SOP_DIST=dist2
run() { echo "=== $(date +%T) $*"; node bench/run.mjs ocr "$@" 2>&1 | grep -v '^$' | tail -7; }
GPU="--flags=--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader --use-angle=swiftshader --disable-vulkan-surface --ignore-gpu-blocklist"
SUB="syn-p25,syn-p100,deg-p0,deg-p2,en-modern-philosophy-p60,en-prince-pauper-p72,fr-bovary-p62,de-kafka-p12,rcpt-starbucks,rcpt-wholefoods"
# A: threads (12 synthetic pages at 200 dpi, two passes: the first includes warm-up)
for c in pp-v6-tiny-wasm4-d1280 pp-v6-tiny-wasm2-d1280 pp-v6-small-wasm4-d1280 pp-v5-latin-wasm4-d1280; do run $c --sets syn --dpi 200 --limit 12 --repeat 2 --tag t; done
# B: WebGPU on the software adapter: does it run, and does it give the same words
for c in pp-v6-tiny-webgpu-d1280 pp-v5-latin-webgpu-d1280 pp-v6-small-webgpu-d1280; do run $c --sets syn --dpi 200 --limit 3 "$GPU" --tag gpu; done
# C: detector size and render DPI
for d in 960 1600 2048; do run pp-v6-tiny-wasm1-d$d --dpi native --pages $SUB; done
for dpi in 100 150; do run pp-v6-tiny-wasm1-d1280 --sets syn --dpi $dpi --tag dpi$dpi; done
for dpi in 150 200; do run pp-v6-tiny-wasm1-d1280 --sets real,rcpt --dpi $dpi --tag dpi$dpi; done
for dpi in 100 150; do run tess-fast-eng --sets syn --lang eng --dpi $dpi --tag dpi$dpi; done
for dpi in 150 200; do run tess-fast-eng --sets real --lang eng --dpi $dpi --tag dpi$dpi; done
# E: heap after 100 pages
run pp-v6-tiny-wasm1-d1280 --sets syn --dpi 200 --cycle 100 --tag heap100
run tess-fast-eng --sets syn --lang eng --dpi 200 --cycle 100 --tag heap100
# F: visible page first
run pp-v6-tiny-wasm4-d1280 --sets syn --dpi 200 --limit 12 --vis --tag vis
echo "=== done $(date +%T)"
