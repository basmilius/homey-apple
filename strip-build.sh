#!/usr/bin/env bash
#
# Strips unnecessary files from .homeybuild to reduce upload size for
# homey app run. Run this AFTER homey app build and BEFORE homey app run --skip-build.
#
# Usage:
#   homey app build
#   ./strip-build.sh
#   homey app run --skip-build
#

set -euo pipefail

BUILD_DIR=".homeybuild/python_packages"

if [ ! -d "$BUILD_DIR" ]; then
    echo "Error: $BUILD_DIR not found. Run 'homey app build' first."
    exit 1
fi

before=$(du -sm "$BUILD_DIR" | cut -f1)

# Remove amd64 packages — Homey Pro (2023) is arm64 only.
if [ -d "$BUILD_DIR/amd64" ]; then
    rm -rf "$BUILD_DIR/amd64"
    echo "Removed amd64 packages."
fi

# Remove __pycache__ directories and .pyc files.
find "$BUILD_DIR" -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true
find "$BUILD_DIR" -name '*.pyc' -delete 2>/dev/null || true
echo "Removed __pycache__ and .pyc files."

# Remove .dist-info directories (pip metadata, not needed at runtime).
find "$BUILD_DIR" -type d -name '*.dist-info' -exec rm -rf {} + 2>/dev/null || true
echo "Removed .dist-info directories."

after=$(du -sm "$BUILD_DIR" | cut -f1)
echo "Done: ${before}MB → ${after}MB (saved $((before - after))MB)"
