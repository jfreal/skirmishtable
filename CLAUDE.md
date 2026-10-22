# CLAUDE.md

## This is a prototype

SkirmishTable is a prototype. Favor speed and getting things working over polish,
long-term architecture, or backwards compatibility.

## Open source: the Unlicense, and no third-party content

This project is open source and released into the public domain under the **Unlicense**
(`UNLICENSE`). Everything in this repository must be ours to give away.

**Never commit licensed or third-party content.** Not in `src/`, `public/`, `tests/`, `docs/`,
or anywhere else, and not in a commit that is later deleted (git history is public too).
That includes:

- 3D models, meshes, textures, scans, asset bundles (Tabletop Simulator or otherwise)
- card images, card sheets, token art, map cards, PDFs, rules text, datacards
- TTS saves or pieces cut out of them (test fixtures too)
- screenshots or renders that show any of the above
- fonts, icons or code from projects whose license needs a notice we don't carry

**Never share it either:** the deployed site and anything we publish (artifacts, uploads)
must not host or relay third-party files. Third-party assets reach a player only one way:
that player's own browser downloads them from their original source (the Steam CDN,
imgur) using the link catalogs in `src/data/tts-*.js`, which hold **links only**.

Local copies are fine for working on the tools, but only in git-ignored folders
(`cache/`, `public/models/`, `public/meshpack.json`). Check `git status` before committing.
If something might be third-party, leave it out and ask.

Game rules are facts and numbers we write ourselves (`src/rules/`); don't paste rules text.
"Kill Team", "Volkus", "Gallowdark" and similar names are Games Workshop trademarks: use them
only to say what the app works with.

## Git workflow

- Commit and merge **straight into `main`**. No feature branches or pull requests needed.
- Keep commits small and descriptive.

## Repo notes

- Every push to `main` deploys to a **public** GitHub Pages site. The deploy also deletes
  `dist/models/` and `dist/meshpack.json` in case a local pack is present; keep that step.
- See `README.md` for setup and `docs/ARCHITECTURE.md` for how the code fits together.

## Commands

```sh
npm ci            # install locked dependencies (use ci, not install)
npm run dev       # dev server at http://localhost:5173
npm test          # unit tests (Vitest)
npm run build     # production build -> dist/
npm run test:e2e  # Playwright tests against the production build
npm run fetch:saves  # download the Workshop saves the import tests read (into cache/)
```
