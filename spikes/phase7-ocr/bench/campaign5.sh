#!/bin/bash
# WebGPU on the software adapter: does a session get created for each model pair (operator coverage)? Init only, no pages.
cd "$(dirname "$0")/.."
export SOP_DIST=dist2
GPU="--flags=--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader --use-angle=swiftshader --disable-vulkan-surface --ignore-gpu-blocklist"
for c in pp-v5-latin-webgpu-d1280 pp-v6-small-webgpu-d1280 pp-v6-tiny-webgpu-d1280; do
  echo "=== $(date +%T) $c init only"; node bench/run.mjs ocr $c --sets syn --dpi 200 --limit 0 "$GPU" --tag gpuinit 2>&1 | grep -E "init|Error|error" | cut -c1-400 | head -4
done
echo "=== done $(date +%T)"
