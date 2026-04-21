echo "Remove map files..."
find ./node_modules -name "*.js.map" -type f -delete
find ./node_modules -name "*.mjs.map" -type f -delete
find ./node_modules -name "*.mts" -type f -delete

sleep 1

NOCHECK=1 homey app publish

bun install -f
