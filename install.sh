bash scripts/corewire-check.sh "Not installing." || exit 1

echo "Remove map files..."
find ./node_modules -name "*.js.map" -type f -delete
find ./node_modules -name "*.mjs.map" -type f -delete
find ./node_modules -name "*.mts" -type f -delete

sleep 1

NOCHECK=1 homey app install

bun install -f

bash scripts/corewire-check.sh "bun install -f removed the local @corewire copy." || exit 1
