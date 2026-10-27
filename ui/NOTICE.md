# Third-party notices for the web app

## Fonts

The four font files in `public/fonts` are used unmodified and are served only to render the interface.

| Files | Font | Copyright | Licence |
|---|---|---|---|
| `Outfit-Regular.ttf`, `Outfit-SemiBold.ttf` | Outfit | Copyright 2021 The Outfit Project Authors (https://github.com/Outfitio/Outfit-Fonts) | SIL Open Font License 1.1 |
| `JetBrainsMono-Regular.ttf`, `JetBrainsMono-Medium.ttf` | JetBrains Mono | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) | SIL Open Font License 1.1 |

The full licence text is at https://openfontlicense.org/open-font-license-official-text/. The font files were copied from the
`assets/fonts` folder of the sibling desk. project (decision D-022); no code, copy or screenshots from that project are used here.

## Libraries bundled into the app

React and React DOM (MIT), React Router (MIT), Zod (MIT). Everything else in `ui/` is original to this repository.

## Libraries used only for development and tests

Vite and @vitejs/plugin-react (MIT), @axe-core/playwright and axe-core (MPL-2.0, used as a test tool and not shipped), Playwright (Apache-2.0).
- Fonts: SIL OFL licence texts for Outfit and JetBrains Mono are in ui/public/fonts (copied from the open-licence font package).
