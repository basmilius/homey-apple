# Apple TV & HomePod — Homey App

Homey app (SDK 3) voor het besturen van Apple TV's en HomePods via het Homey smart home platform.

## Quick reference

- **Taal**: TypeScript (geen Python, geen JavaScript)
- **Package manager**: Bun
- **Build**: `bun run build` (compileert via `tsc` naar `.homeybuild/`)
- **Validatie**: `homey app build` — voer dit uit voordat je aangeeft dat de implementatie klaar is
- **Publiceren**: `./publish.sh` (verwijdert source maps, publiceert, herinstalleert deps)

## Projectstructuur

```
app.ts                  # Entrypoint, importeert src/index.ts
src/
  index.ts              # AppleApp class (extends App)
  types.ts              # Gedeelde type exports
  apple-tv/             # Apple TV device, driver, pairing, flow
  homepod-base/         # Gedeelde HomePod logica (device, driver, pairing, flow)
  homepod/              # HomePod device & driver
  homepod-mini/         # HomePod Mini device & driver
  base/                 # Base classes (discoverableDevice)
  connection/           # AirPlay & Companion Link connecties
  logic/                # AirPlay logica
  utils/                # Helpers (credentials, waitFor, discovery)
drivers/                # Homey driver definities (compose json, assets, pairing HTML)
  apple-tv/
  homepod/
  homepod-mini/
widgets/                # Homey widgets
  apple_tv_remote/      # Remote control widget
  mini_player/          # Now playing widget
.homeycompose/          # Homey app configuratie (capabilities, flows, locales, app.json)
```

## Dependencies

- `@corewire/devices` en `@corewire/audio-source`: de Apple protocol packages (AirPlay, Companion Link, devices, audio)
  - Broncode in `~/Development/Projects/@basmilius/apple-protocols`; raadpleeg die om protocol-implementaties te valideren
  - Nog niet op npm. Ze staan daarom in `optionalDependencies`: `bun install` meldt dan een 404 als waarschuwing in plaats van te falen
  - Lokaal bouwen: `bash build.sh` in apple-protocols, daarna hier `bun install` en `bun run corewire:local`. Het script (`scripts/corewire-local.ts`) kopieert `package.json` en `dist/` van core, airplay, companion-link, devices en audio-source naar `node_modules/@corewire/` (echte kopieën, `homey app build` pakt `node_modules` in) en zet `workspace:*` om naar de lokale versie. Een andere checkout: `bun run corewire:local <pad>` of `COREWIRE_PATH`
  - Draai het script opnieuw na elke library-build. Zodra @corewire op npm staat, verhuizen de twee packages naar `dependencies` en verdwijnen het script en deze uitleg
- `@basmilius/homey-common` — Gedeelde Homey utilities
- `fast-srp-hap` — SRP authenticatie (voor pairing)

## Conventies

- App configuratie bewerken in `.homeycompose/`, niet in root `app.json` (die wordt gegenereerd)
- Vertalingen in `.homeycompose/locales/` (en, nl, de, es, fr, it, da, no, sv, pl, ru, ko, ar)
- Drivers hebben een `driver.compose.json` in hun map onder `drivers/`
- Output directory is `.homeybuild/` — niet handmatig bewerken
- EditorConfig: 4 spaties, UTF-8, LF, single quotes, semicolons, geen trailing commas
