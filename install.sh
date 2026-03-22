echo "Remove map files..."
find ./node_modules -name "*.js.map" -type f -delete
find ./node_modules -name "*.mjs.map" -type f -delete

sleep 1

homey app install

bun install -f
