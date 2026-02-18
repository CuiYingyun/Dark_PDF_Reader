#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/node_modules/pdfjs-dist"
TARGET_DIR="$ROOT_DIR/vendor/pdfjs"

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "pdfjs-dist is not installed. Run: npm install"
  exit 1
fi

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"

cp -R "$SOURCE_DIR/build" "$TARGET_DIR/"
cp -R "$SOURCE_DIR/web" "$TARGET_DIR/"
cp -R "$SOURCE_DIR/cmaps" "$TARGET_DIR/"
cp -R "$SOURCE_DIR/standard_fonts" "$TARGET_DIR/"
cp "$SOURCE_DIR/LICENSE" "$TARGET_DIR/LICENSE"

echo "Synced pdf.js assets into $TARGET_DIR"
