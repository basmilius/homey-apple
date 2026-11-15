# Apple TV & HomePod Homey app

Homey app (SDK 3) that controls Apple TVs and HomePods through the Homey smart home platform.

## Quick reference

- Language: TypeScript (no Python, no JavaScript)
- Package manager: Bun
- Build: `bun run build` (compiles with `tsc` into `.homeybuild/`)
- Validation: run `homey app build` before you report that the implementation is done
- Publish: `./publish.sh` (removes source maps, publishes, reinstalls deps)

## Project structure

```
app.ts                  # Entry point, imports src/index.ts
src/
  index.ts              # AppleApp class (extends App)
  types.ts              # Shared type exports
  apple-tv/             # Apple TV device, driver, pairing, flow
  homepod-base/         # Shared HomePod logic (device, driver, pairing, flow)
  homepod/              # HomePod device & driver
  homepod-mini/         # HomePod Mini device & driver
  base/                 # Base classes (discoverableDevice)
  logic/                # AirPlay logic
  utils/                # Helpers (credentials, device target, artwork, waitFor, withTimeout)
drivers/                # Homey driver definitions (compose json, assets, pairing HTML)
  apple-tv/
  homepod/
  homepod-mini/
widgets/                # Homey widgets
  apple_tv_remote/      # Remote control widget
  mini_player/          # Now playing widget
  artwork_player/       # Artwork player widget
  client/               # Browser code shared by the player widgets
.homeycompose/          # Homey app configuration (capabilities, flows, locales, app.json)
```

## Dependencies

- `@corewire/devices` and `@corewire/audio-source`: the Apple protocol packages (AirPlay, Companion Link, devices, audio)
  - These are the CoreWire packages (GitHub `basmilius/corewire`). The source lives in `~/Development/Projects/@basmilius/apple-protocols`; consult it to validate protocol implementations
  - From npm, pinned to an exact version in `dependencies` (now `1.0.0-beta.1`, dist-tag `next`). npm also has an empty placeholder `0.0.0` under `latest`, so always pin a real version, never a range that can resolve to `0.0.0`
  - Test an unreleased library change: `bash build.sh` in the CoreWire checkout, then `bun run corewire:local` here. The script (`scripts/corewire-local.ts`) copies `package.json` and `dist/` of core, airplay, companion-link, devices and audio-source into `node_modules/@corewire/` as version `0.0.0-local` (real copies, because `homey app build` packs `node_modules`). For another checkout: `bun run corewire:local <path>` or `COREWIRE_PATH`. The next `bun install` restores the npm version
  - `publish.sh` and `install.sh` stop with a message when `node_modules/@corewire/devices/dist/index.mjs` or the one of audio-source is missing (`scripts/corewire-check.sh`), both before and after their `bun install -f`
- `@basmilius/homey-common`: shared Homey utilities

## Conventions

- Edit the app configuration in `.homeycompose/`, not in the root `app.json` (Homey generates it)
- Translations live in `.homeycompose/locales/` (en, nl, de, es, fr, it, da, no, sv, pl, ru, ko, ar)
- Every driver has a `driver.compose.json` in its folder under `drivers/`
- The output directory is `.homeybuild/`; do not edit it by hand
- EditorConfig: 4 spaces, UTF-8, LF, single quotes, semicolons, no trailing commas
