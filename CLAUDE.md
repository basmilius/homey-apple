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

- `@basmilius/apple-*` — Custom Apple protocol packages (AirPlay, Companion Link, RAOP, encoding, encryption, devices)
  - Broncode beschikbaar in `~/Development/Projects/@basmilius/apple-protocols` — raadpleeg deze om protocol-implementaties te valideren
- `@basmilius/homey-common` — Gedeelde Homey utilities
- `fast-srp-hap` — SRP authenticatie (voor pairing)

## Conventies

- App configuratie bewerken in `.homeycompose/`, niet in root `app.json` (die wordt gegenereerd)
- Vertalingen in `.homeycompose/locales/` (en, nl, de, es, fr, it, da, no, sv, pl, ru, ko, ar)
- Drivers hebben een `driver.compose.json` in hun map onder `drivers/`
- Output directory is `.homeybuild/` — niet handmatig bewerken
- EditorConfig: 4 spaties, UTF-8, LF, single quotes, semicolons, geen trailing commas
