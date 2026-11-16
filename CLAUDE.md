# Apple TV & HomePod Homey app

Homey app (SDK 3) that controls Apple TVs and HomePods through the Homey smart home platform.

## Quick reference

- Language: TypeScript (no Python, no JavaScript)
- Package manager: Bun
- Build: `bun run build` (compiles with `tsc` into `.homeybuild/`)
- Validation: run `homey app build` before you report that the implementation is done
- Publish: `homey app publish --slim` (drops source maps and type declarations from `node_modules`)

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

- `@apple-protocols/devices` and `@apple-protocols/audio-source`: the Apple protocol packages (AirPlay, Companion Link, devices, audio)
  - These are the Apple Protocols packages (GitHub `basmilius/apple-protocols`). The source lives in `~/Development/Projects/@basmilius/apple-protocols`; consult it to validate protocol implementations
  - From npm, pinned to an exact version in `dependencies` (now `1.0.0-beta.2`, dist-tag `next`). npm also has an empty placeholder `0.0.0` under `latest`, so always pin a real version, never a range that can resolve to `0.0.0`
  - Test an unreleased library change: `bash build.sh` in the Apple Protocols checkout, then `bun run apple-protocols:local` here. The script (`scripts/apple-protocols-local.ts`) copies `package.json` and `dist/` of core, airplay, companion-link, devices and audio-source into `node_modules/@apple-protocols/` as version `0.0.0-local` (real copies, because `homey app build` packs `node_modules`). For another checkout: `bun run apple-protocols:local <path>` or `APPLE_PROTOCOLS_PATH`. The next `bun install` restores the npm version
- `@basmilius/homey-common`: shared Homey utilities

## Conventions

- Edit the app configuration in `.homeycompose/`, not in the root `app.json` (Homey generates it)
- Translations live in `.homeycompose/locales/` (en, nl, de, es, fr, it, da, no, sv, pl, ru, ko, ar)
- Every driver has a `driver.compose.json` in its folder under `drivers/`
- The output directory is `.homeybuild/`; do not edit it by hand
- EditorConfig: 4 spaces, UTF-8, LF, single quotes, semicolons, no trailing commas
