#!/bin/bash
cd "$(dirname "$0")/.."
run() { echo "=== $(date +%T) $*"; node bench/run.mjs ocr "$@" 2>&1 | grep -v '^$' | tail -6; }
SUB="syn-p0,syn-p100,syn-p200,syn-p300,syn-p400,syn-p500,deg-p0,deg-p2,deg-p4,deg-p6,en-modern-philosophy-p60,en-modern-philosophy-p64,en-prince-pauper-p72,en-prince-pauper-p82,en-dartmoor-p80,en-dartmoor-p84,fr-bovary-p62,fr-bovary-p66,de-kafka-p12,de-kafka-p16,rcpt-starbucks,rcpt-wholefoods"
run pp-v5-mobile-wasm4-d1280 --dpi native
run tess-best-eng --sets real,rcpt --lang eng --dpi native
run tess-best-fra --sets real --lang fra --dpi native
run tess-best-deu --sets real,rcpt --lang deu --dpi native
run pp-v6-medium-wasm4-d1280 --dpi native --pages $SUB
echo "=== done $(date +%T)"
