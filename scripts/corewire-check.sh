#!/usr/bin/env bash
# Fails when @corewire is not in node_modules. Without it every Homey crashes on
# require('@corewire/devices'), so publish.sh and install.sh stop instead of shipping that.
# Usage: bash scripts/corewire-check.sh <what stops>

missing=0

for pkg in devices audio-source; do
    if [ ! -f "node_modules/@corewire/${pkg}/dist/index.mjs" ]; then
        echo "node_modules/@corewire/${pkg}/dist/index.mjs is missing." >&2
        missing=1
    fi
done

if [ "$missing" -eq 1 ]; then
    echo "$1 Run \`bun install\`, or \`bun run corewire:local\` for a local CoreWire build." >&2
    exit 1
fi
