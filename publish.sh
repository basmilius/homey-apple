echo "Remove map files..."
rm -rf node_modules/**/*.js.map
rm -rf node_modules/**/*.mjs.map

homey app publish

bun install
